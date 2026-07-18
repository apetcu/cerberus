import {
  decodeInbound, encodePayload, mailboxKey, OUTBOX_STREAM, type AgentInbound,
} from '@cerberus/protocol';
import type { Brain, BrainContext } from './brain/brain.js';
import type { WorkspaceStore } from './workspace.js';

export interface StreamsClient {
  xgroup(...args: (string | number)[]): Promise<unknown>;
  xreadgroup(...args: (string | number)[]): Promise<unknown>;
  xadd(...args: (string | number)[]): Promise<unknown>;
  xack(key: string, group: string, id: string): Promise<unknown>;
}

const GROUP = 'agent';
const CONSUMER = 'main';
type StreamReply = [string, [string, string[]][]][] | null;

export class MailboxConsumer {
  constructor(
    private readonly redis: StreamsClient,
    private readonly brain: Brain,
    private readonly store: WorkspaceStore,
    private readonly threadKey: string,
    private readonly workspacePath: string,
    private readonly log: Pick<Console, 'error'> = console,
  ) {}

  private get key(): string {
    return mailboxKey(this.threadKey);
  }

  async ensureGroup(): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', this.key, GROUP, '0', 'MKSTREAM');
    } catch (err) {
      if (!String(err).includes('BUSYGROUP')) throw err;
    }
  }

  /** Re-process entries delivered to us but never acked (crash recovery). */
  async drainPending(): Promise<'ok' | 'shutdown'> {
    for (;;) {
      const res = (await this.redis.xreadgroup(
        'GROUP', GROUP, CONSUMER, 'COUNT', 10, 'STREAMS', this.key, '0',
      )) as StreamReply;
      const entries = res?.[0]?.[1] ?? [];
      if (entries.length === 0) return 'ok';
      for (const [id, fields] of entries) {
        if ((await this.processEntry(id, fields)) === 'shutdown') return 'shutdown';
      }
    }
  }

  async runOnce(blockMs: number): Promise<'processed' | 'idle' | 'shutdown'> {
    const res = (await this.redis.xreadgroup(
      'GROUP', GROUP, CONSUMER, 'COUNT', 1, 'BLOCK', blockMs, 'STREAMS', this.key, '>',
    )) as StreamReply;
    const entry = res?.[0]?.[1]?.[0];
    if (!entry) return 'idle';
    return this.processEntry(entry[0], entry[1]);
  }

  private async processEntry(entryId: string, fields: string[]): Promise<'processed' | 'shutdown'> {
    let result: 'processed' | 'shutdown' = 'processed';
    try {
      const msg = decodeInbound(fields);
      if (msg.kind === 'control') {
        if (msg.control === 'shutdown') result = 'shutdown';
      } else {
        await this.handleUserMessage(msg);
      }
    } catch (err) {
      // Malformed payload: ack and drop — retrying can never succeed.
      this.log.error(`dropping malformed mailbox entry ${entryId}: ${String(err)}`);
    }
    await this.redis.xack(this.key, GROUP, entryId);
    return result;
  }

  private async handleUserMessage(msg: AgentInbound): Promise<void> {
    await this.store.append({ id: msg.id, role: 'user', text: msg.text ?? '', ts: new Date().toISOString() });
    const ctx: BrainContext = {
      threadKey: this.threadKey,
      workspacePath: this.workspacePath,
      history: await this.store.load(),
    };
    for await (const out of this.brain.process(msg, ctx)) {
      await this.redis.xadd(OUTBOX_STREAM, 'MAXLEN', '~', 10000, '*', ...encodePayload(out));
      if (out.final && out.kind === 'message') {
        await this.store.append({ id: out.id, role: 'agent', text: out.text, ts: new Date().toISOString() });
      }
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    await this.ensureGroup();
    if ((await this.drainPending()) === 'shutdown') return;
    while (!signal.aborted) {
      if ((await this.runOnce(5000)) === 'shutdown') return;
    }
  }
}

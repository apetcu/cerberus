import { decodeOutbound, OUTBOX_STREAM } from '@cerberus/protocol';
import type { Logger } from '../observability/logger.js';
import type { DeliveryGuard, StreamsClient } from './redis-stores.js';

export interface SlackPoster {
  postToThread(threadKey: string, text: string): Promise<void>;
}

const GROUP = 'orchestrator';
const CONSUMER = 'main';
type StreamReply = [string, [string, string[]][]][] | null;

export class OutboxConsumer {
  constructor(
    private readonly redis: StreamsClient,
    private readonly poster: SlackPoster,
    private readonly guard: DeliveryGuard,
    private readonly log: Logger,
  ) {}

  async ensureGroup(): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', OUTBOX_STREAM, GROUP, '0', 'MKSTREAM');
    } catch (err) {
      if (!String(err).includes('BUSYGROUP')) throw err;
    }
  }

  async handleEntry(entryId: string, fields: string[]): Promise<void> {
    let decoded;
    try {
      decoded = decodeOutbound(fields);
    } catch (err) {
      this.log.error({ err, entryId }, 'dropping malformed outbox entry');
      await this.redis.xack(OUTBOX_STREAM, GROUP, entryId);
      return;
    }
    try {
      if (await this.guard.claim(decoded.id)) {
        await this.poster.postToThread(decoded.threadKey, decoded.text);
      }
      await this.redis.xack(OUTBOX_STREAM, GROUP, entryId);
    } catch (err) {
      // Post failed: release the claim and leave unacked; claimStale() retries it.
      await this.guard.release(decoded.id).catch((releaseErr) => {
        this.log.error({ releaseErr, outboundId: decoded.id }, 'delivery-guard release failed; retry may be starved');
      });
      this.log.error({ err, entryId, threadKey: decoded.threadKey }, 'outbox delivery failed');
    }
  }

  async runOnce(blockMs: number): Promise<number> {
    const res = (await this.redis.xreadgroup(
      'GROUP', GROUP, CONSUMER, 'COUNT', 10, 'BLOCK', blockMs, 'STREAMS', OUTBOX_STREAM, '>',
    )) as StreamReply;
    const entries = res?.[0]?.[1] ?? [];
    for (const [id, fields] of entries) await this.handleEntry(id, fields);
    return entries.length;
  }

  async claimStale(minIdleMs = 60_000): Promise<number> {
    const res = (await this.redis.xautoclaim(
      OUTBOX_STREAM, GROUP, CONSUMER, minIdleMs, '0', 'COUNT', 10,
    )) as [string, [string, string[]][], ...unknown[]];
    const entries = res[1] ?? [];
    for (const [id, fields] of entries) await this.handleEntry(id, fields);
    return entries.length;
  }

  async run(signal: AbortSignal): Promise<void> {
    await this.ensureGroup();
    let cycles = 0;
    while (!signal.aborted) {
      try {
        await this.runOnce(5000);
        if (++cycles % 12 === 0) {
          await this.claimStale().catch((err) => this.log.error({ err }, 'claimStale failed'));
        }
      } catch (err) {
        this.log.error({ err }, 'outbox loop error; retrying after backoff');
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }
}

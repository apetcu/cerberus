import {
  clientMessageSchema, logsChannel, OVERVIEW_CHANNEL, threadChannel,
  type ServerMessage,
} from '@cerberus/protocol';
import type { Logger } from '../observability/logger.js';
import type { ThreadRegistry } from '../registry/thread-registry.js';
import type { AgentRuntime } from '../runtime/agent-runtime.js';
import type { EventBus } from './events.js';
import type { SnapshotBuilder } from './snapshots.js';

export interface HubSocket {
  send(data: string): void;
  on(event: 'message' | 'close', fn: (payload?: unknown) => void): void;
}

export interface HubDeps {
  snapshots: SnapshotBuilder;
  registry: ThreadRegistry;
  runtime: AgentRuntime;
  events: EventBus;
  log: Logger;
  tickMs?: number;
  debounceMs?: number;
}

interface Client {
  socket: HubSocket;
  channels: Set<string>;
  logStreams: Map<string, AbortController>;
}

const LOG_TAIL = 200;

export class DashboardHub {
  private readonly clients = new Set<Client>();
  private readonly tickMs: number;
  private readonly debounceMs: number;
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private unsubscribeEvents: (() => void) | null = null;

  constructor(private readonly deps: HubDeps) {
    this.tickMs = deps.tickMs ?? 2000;
    this.debounceMs = deps.debounceMs ?? 100;
    // Wired unconditionally (not deferred to start()): clients must react to
    // lifecycle events as soon as they subscribe, without the caller having to
    // remember to invoke start() first. start()/stop() govern only the
    // reconcile-tick timer below.
    this.unsubscribeEvents = this.deps.events.onEvent(() => this.scheduleFlush());
  }

  start(): void {
    // Reconcile tick: catches state the orchestrator never emits an event for
    // (a container dying on its own, mailbox depth, heartbeat expiry).
    this.timer = setInterval(() => void this.flush(), this.tickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.unsubscribeEvents?.();
    for (const client of this.clients) this.disposeClient(client);
    this.clients.clear();
  }

  addClient(socket: HubSocket): () => void {
    const client: Client = { socket, channels: new Set(), logStreams: new Map() };
    this.clients.add(client);

    socket.on('message', (raw) => {
      void this.onMessage(client, raw);
    });
    socket.on('close', () => {
      this.disposeClient(client);
      this.clients.delete(client);
    });

    return () => {
      this.disposeClient(client);
      this.clients.delete(client);
    };
  }

  private async onMessage(client: Client, raw: unknown): Promise<void> {
    let parsed;
    try {
      parsed = clientMessageSchema.parse(JSON.parse(String(raw)));
    } catch {
      this.send(client, { type: 'error', message: 'malformed message' });
      return;
    }

    if (parsed.type === 'ping') {
      this.send(client, { type: 'pong' });
      return;
    }

    if (parsed.type === 'subscribe') {
      client.channels.add(parsed.channel);
      if (parsed.channel.startsWith('logs:')) {
        await this.startLogStream(client, parsed.channel);
      } else {
        await this.sendSnapshot(client, parsed.channel);
      }
      return;
    }

    client.channels.delete(parsed.channel);
    this.stopLogStream(client, parsed.channel);
  }

  private scheduleFlush(): void {
    if (this.debounce) return; // a flush is already pending; the burst collapses into it
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.flush();
    }, this.debounceMs);
  }

  /** Re-send snapshots for every subscribed non-log channel. */
  private async flush(): Promise<void> {
    for (const client of this.clients) {
      for (const channel of client.channels) {
        if (channel.startsWith('logs:')) continue;
        await this.sendSnapshot(client, channel);
      }
    }
  }

  private async sendSnapshot(client: Client, channel: string): Promise<void> {
    try {
      if (channel === OVERVIEW_CHANNEL) {
        this.send(client, { type: 'snapshot', channel, data: await this.deps.snapshots.overview() });
        return;
      }
      if (channel.startsWith('thread:')) {
        const threadKey = channel.slice('thread:'.length);
        const detail = await this.deps.snapshots.detail(threadKey);
        if (!detail) {
          this.send(client, { type: 'error', channel, message: 'unknown thread' });
          return;
        }
        this.send(client, { type: 'snapshot', channel, data: detail });
        return;
      }
      this.send(client, { type: 'error', channel, message: 'unknown channel' });
    } catch (err) {
      this.deps.log.error({ err, channel }, 'snapshot failed');
      this.send(client, { type: 'error', channel, message: 'snapshot failed' });
    }
  }

  private async startLogStream(client: Client, channel: string): Promise<void> {
    const threadKey = channel.slice('logs:'.length);
    this.stopLogStream(client, channel);

    const record = await this.deps.registry.get(threadKey);
    const handle = record?.containerName ? await this.deps.runtime.inspect(record.containerName) : null;
    if (!handle) {
      this.send(client, { type: 'log_end', channel, reason: 'no container for this thread' });
      return;
    }

    const controller = new AbortController();
    client.logStreams.set(channel, controller);

    void (async () => {
      try {
        for await (const line of this.deps.runtime.logs(handle, {
          tail: LOG_TAIL, follow: true, signal: controller.signal,
        })) {
          if (controller.signal.aborted) break;
          this.send(client, { type: 'log', channel, line });
        }
        if (!controller.signal.aborted) {
          this.send(client, { type: 'log_end', channel, reason: 'stream closed' });
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          this.deps.log.warn({ err, threadKey }, 'log stream failed');
          this.send(client, { type: 'log_end', channel, reason: 'stream error' });
        }
      } finally {
        client.logStreams.delete(channel);
      }
    })();
  }

  private stopLogStream(client: Client, channel: string): void {
    const controller = client.logStreams.get(channel);
    if (!controller) return;
    controller.abort();
    client.logStreams.delete(channel);
  }

  private disposeClient(client: Client): void {
    for (const controller of client.logStreams.values()) controller.abort();
    client.logStreams.clear();
    client.channels.clear();
  }

  private send(client: Client, message: ServerMessage): void {
    try {
      client.socket.send(JSON.stringify(message));
    } catch (err) {
      this.deps.log.warn({ err }, 'failed to send to dashboard client');
    }
  }
}

export { OVERVIEW_CHANNEL, logsChannel, threadChannel };

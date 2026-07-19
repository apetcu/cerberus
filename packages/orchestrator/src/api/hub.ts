import {
  ACTIVITY_CHANNEL, clientMessageSchema, logsChannel, OVERVIEW_CHANNEL, threadChannel,
  type ServerMessage,
} from '@cerberus/protocol';
import type { Logger } from '../observability/logger.js';
import type { ThreadRegistry } from '../registry/thread-registry.js';
import type { AgentHandle, AgentRuntime } from '../runtime/agent-runtime.js';
import type { ActivityLog } from './activity.js';
import type { EventBus } from './events.js';
import type { SnapshotBuilder } from './snapshots.js';

export interface HubSocket {
  send(data: string): void;
  on(event: 'message' | 'close' | 'error', fn: (payload?: unknown) => void): void;
}

export interface HubDeps {
  snapshots: SnapshotBuilder;
  registry: ThreadRegistry;
  runtime: AgentRuntime;
  events: EventBus;
  activity: ActivityLog;
  log: Logger;
  tickMs?: number;
  debounceMs?: number;
}

interface Client {
  socket: HubSocket;
  channels: Set<string>;
  logStreams: Map<string, AbortController>;
  disposed: boolean;
}

const LOG_TAIL = 200;
const LOG_BATCH_MAX = 50;
const LOG_BATCH_MS = 60;

export class DashboardHub {
  private readonly clients = new Set<Client>();
  private readonly tickMs: number;
  private readonly debounceMs: number;
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private unsubscribeEvents: (() => void) | null = null;
  private unsubscribeActivity: (() => void) | null = null;
  private flushing = false;

  constructor(private readonly deps: HubDeps) {
    this.tickMs = deps.tickMs ?? 2000;
    this.debounceMs = deps.debounceMs ?? 100;
    // Wired unconditionally (not deferred to start()): clients must react to
    // lifecycle events as soon as they subscribe, without the caller having to
    // remember to invoke start() first. start()/stop() govern only the
    // reconcile-tick timer below.
    this.unsubscribeEvents = this.deps.events.onEvent(() => this.scheduleFlush());
    this.unsubscribeActivity = this.subscribeActivity();
  }

  private subscribeActivity(): () => void {
    return this.deps.activity.onEvent((event) => {
      for (const client of this.clients) {
        if (client.channels.has(ACTIVITY_CHANNEL)) {
          this.send(client, { type: 'activity', events: [event] });
        }
      }
    });
  }

  start(): void {
    if (this.timer) return; // already started; do not orphan the existing interval
    // Re-subscribing here keeps start()/stop() symmetric: stop() unsubscribes, so a
    // restarted hub must re-attach or it would silently lose all event-driven pushes.
    this.unsubscribeEvents ??= this.deps.events.onEvent(() => this.scheduleFlush());
    this.unsubscribeActivity ??= this.subscribeActivity();
    // Reconcile tick: catches state the orchestrator never emits an event for
    // (a container dying on its own, mailbox depth, heartbeat expiry).
    this.timer = setInterval(() => void this.flush(), this.tickMs);
  }

  stop(): void {
    // Pauses the background machinery (reconcile tick + event-driven flushes) and releases
    // every in-flight log stream, since each one holds an open connection to the container
    // runtime. Clients themselves stay registered — they are torn down by their own socket
    // 'close' event or the unsubscribe function addClient() returns — so a stop()/start()
    // cycle can resume pushing to sockets that stayed open throughout.
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;
    this.unsubscribeActivity?.();
    this.unsubscribeActivity = null;
    for (const client of this.clients) {
      for (const controller of client.logStreams.values()) controller.abort();
      client.logStreams.clear();
    }
  }

  addClient(socket: HubSocket): () => void {
    const client: Client = { socket, channels: new Set(), logStreams: new Map(), disposed: false };
    this.clients.add(client);

    socket.on('message', (raw) => {
      void this.onMessage(client, raw).catch((err) => {
        this.deps.log.error({ err }, 'dashboard message handling failed');
        this.send(client, { type: 'error', message: 'internal error' });
      });
    });
    socket.on('close', () => {
      this.disposeClient(client);
      this.clients.delete(client);
    });
    socket.on('error', (err) => {
      // ws emits 'error' on abrupt resets and malformed frames. Without a listener Node
      // throws and takes down the whole orchestrator, so contain it and drop the client.
      this.deps.log.warn({ err }, 'dashboard socket error');
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
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (const client of this.clients) {
        for (const channel of client.channels) {
          if (channel.startsWith('logs:')) continue;
          await this.sendSnapshot(client, channel);
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private async sendSnapshot(client: Client, channel: string): Promise<void> {
    try {
      if (channel === OVERVIEW_CHANNEL) {
        this.send(client, { type: 'snapshot', channel, data: await this.deps.snapshots.overview() });
        return;
      }
      if (channel === ACTIVITY_CHANNEL) {
        this.send(client, { type: 'snapshot', channel, data: { events: this.deps.activity.recent() } });
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

    let handle;
    try {
      const record = await this.deps.registry.get(threadKey);
      handle = record?.containerName ? await this.deps.runtime.inspect(record.containerName) : null;
    } catch (err) {
      this.deps.log.warn({ err, threadKey }, 'could not resolve container for log stream');
      this.send(client, { type: 'log_end', channel, reason: 'could not resolve container' });
      return;
    }

    // The client may have disconnected while those lookups were in flight; registering a
    // controller on a disposed client would leak the stream, since dispose already ran.
    if (client.disposed) return;

    if (!handle) {
      this.send(client, { type: 'log_end', channel, reason: 'no container for this thread' });
      return;
    }

    const controller = new AbortController();
    client.logStreams.set(channel, controller);

    void this.pumpLogs(client, channel, handle, controller);
  }

  /** Streams lines to one client, batching frames so a chatty container cannot flood the socket. */
  private async pumpLogs(
    client: Client,
    channel: string,
    handle: AgentHandle,
    controller: AbortController,
  ): Promise<void> {
    let batch: string[] = [];
    let timer: NodeJS.Timeout | null = null;

    const flushBatch = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (batch.length === 0) return;
      const lines = batch;
      batch = [];
      this.send(client, { type: 'log', channel, lines });
    };

    try {
      for await (const line of this.deps.runtime.logs(handle, {
        tail: LOG_TAIL, follow: true, signal: controller.signal,
      })) {
        if (controller.signal.aborted) break;
        batch.push(line);
        if (batch.length >= LOG_BATCH_MAX) flushBatch();
        else if (!timer) timer = setTimeout(flushBatch, LOG_BATCH_MS);
      }
      flushBatch();
      if (!controller.signal.aborted) {
        this.send(client, { type: 'log_end', channel, reason: await this.endReason(handle) });
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        this.deps.log.warn({ err, channel }, 'log stream failed');
        this.send(client, { type: 'log_end', channel, reason: 'stream error' });
      }
    } finally {
      if (timer) clearTimeout(timer);
      // Only clear our own entry: a re-subscribe may already have registered a newer
      // controller for this channel, and deleting it would orphan a live stream.
      if (client.logStreams.get(channel) === controller) client.logStreams.delete(channel);
    }
  }

  /**
   * Explains why a log stream ended. Docker closes the stream immediately for a container
   * that has already exited, and reporting that as "stream closed" tells an operator
   * nothing — re-inspect so the drawer can say what actually happened.
   */
  private async endReason(handle: AgentHandle): Promise<string> {
    try {
      const current = await this.deps.runtime.inspect(handle.name);
      if (!current) return 'container was removed';
      if (!current.running) return 'container exited; restart the agent to resume streaming';
    } catch (err) {
      this.deps.log.warn({ err, container: handle.name }, 'could not determine why the log stream ended');
    }
    return 'log stream closed';
  }

  private stopLogStream(client: Client, channel: string): void {
    const controller = client.logStreams.get(channel);
    if (!controller) return;
    controller.abort();
    client.logStreams.delete(channel);
  }

  private disposeClient(client: Client): void {
    client.disposed = true;
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

import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { logsChannel, OVERVIEW_CHANNEL, threadChannel, type ServerMessage } from '@cerberus/protocol';
import { EventBus } from '../src/api/events.js';
import { DashboardHub, type HubSocket } from '../src/api/hub.js';

const log = pino({ level: 'silent' });
const KEY = 'T1-C1-1.2';

class FakeSocket implements HubSocket {
  sent: ServerMessage[] = [];
  private handlers: Record<string, (payload?: unknown) => void> = {};
  send(data: string): void { this.sent.push(JSON.parse(data) as ServerMessage); }
  on(event: 'message' | 'close', fn: (payload?: unknown) => void): void { this.handlers[event] = fn; }
  emit(event: 'message' | 'close', payload?: unknown): void { this.handlers[event]?.(payload); }
  subscribe(channel: string): void { this.emit('message', JSON.stringify({ type: 'subscribe', channel })); }
  unsubscribe(channel: string): void { this.emit('message', JSON.stringify({ type: 'unsubscribe', channel })); }
  ofType<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.sent.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }
}

function makeHub(
  logLines: string[] = [],
  opts: {
    detail?: unknown;
    registryGet?: () => Promise<unknown>;
    /** End the log stream instead of holding it open, as Docker does for an exited container. */
    endStream?: boolean;
    /** What runtime.inspect reports after the stream ends. */
    inspectAfterEnd?: { id: string; name: string; threadKey: string; running: boolean } | null;
  } = {},
) {
  const events = new EventBus();
  const aborted: AbortSignal[] = [];
  let logsFinished = false;
  const runtime = {
    inspect: vi.fn(async () =>
      logsFinished && opts.inspectAfterEnd !== undefined
        ? opts.inspectAfterEnd
        : { id: 'c1', name: 'cerberus-agent-x', threadKey: KEY, running: true }),
    logs: vi.fn(async function* (_h: unknown, o: { signal?: AbortSignal }) {
      if (o.signal) aborted.push(o.signal);
      for (const line of logLines) yield line;
      if (opts.endStream) { logsFinished = true; return; }
      await new Promise(() => {}); // stay open like a follow stream
    }),
  } as never;
  const hub = new DashboardHub({
    snapshots: {
      overview: vi.fn(async () => ({ generatedAt: 'now', agents: [] })),
      detail: vi.fn(async () => opts.detail ?? { threadKey: KEY }),
    } as never,
    registry: {
      get: opts.registryGet ?? (async () => ({ threadKey: KEY, containerName: 'cerberus-agent-x' })),
    } as never,
    runtime, events, log, tickMs: 10_000, debounceMs: 5,
  });
  return { hub, events, aborted };
}

const flush = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe('DashboardHub', () => {
  it('sends a snapshot immediately on subscribe', async () => {
    const { hub } = makeHub();
    const socket = new FakeSocket();
    hub.addClient(socket);
    socket.subscribe(OVERVIEW_CHANNEL);
    await flush();
    expect(socket.ofType('snapshot')).toHaveLength(1);
    expect(socket.ofType('snapshot')[0]!.channel).toBe(OVERVIEW_CHANNEL);
  });

  it('pushes a fresh snapshot when a lifecycle event fires', async () => {
    const { hub, events } = makeHub();
    const socket = new FakeSocket();
    hub.addClient(socket);
    socket.subscribe(OVERVIEW_CHANNEL);
    await flush();
    events.publish({ kind: 'agent_spawned', threadKey: KEY, at: 'now' });
    await flush();
    expect(socket.ofType('snapshot').length).toBeGreaterThanOrEqual(2);
  });

  it('debounces an event burst into a single extra snapshot', async () => {
    const { hub, events } = makeHub();
    const socket = new FakeSocket();
    hub.addClient(socket);
    socket.subscribe(OVERVIEW_CHANNEL);
    await flush();
    const before = socket.ofType('snapshot').length;
    for (let i = 0; i < 5; i++) events.publish({ kind: 'message_routed', threadKey: KEY, at: 'now' });
    await flush();
    expect(socket.ofType('snapshot').length).toBe(before + 1);
  });

  it('stops sending after unsubscribe', async () => {
    const { hub, events } = makeHub();
    const socket = new FakeSocket();
    hub.addClient(socket);
    socket.subscribe(threadChannel(KEY));
    await flush();
    socket.unsubscribe(threadChannel(KEY));
    const before = socket.sent.length;
    events.publish({ kind: 'agent_spawned', threadKey: KEY, at: 'now' });
    await flush();
    expect(socket.sent.length).toBe(before);
  });

  it('streams log lines and aborts the stream on unsubscribe', async () => {
    const { hub, aborted } = makeHub(['line-one', 'line-two']);
    const socket = new FakeSocket();
    hub.addClient(socket);
    socket.subscribe(logsChannel(KEY));
    await flush(120);
    const lines = socket.ofType('log').flatMap((m) => (m as { lines: string[] }).lines);
    expect(lines).toEqual(['line-one', 'line-two']);
    socket.unsubscribe(logsChannel(KEY));
    await flush();
    expect(aborted[0]!.aborted).toBe(true);
  });

  it('aborts log streams on stop() so no runtime connection outlives the hub', async () => {
    const { hub, aborted } = makeHub(['x']);
    const socket = new FakeSocket();
    hub.addClient(socket);
    hub.start();
    socket.subscribe(logsChannel(KEY));
    await flush();
    hub.stop();
    expect(aborted[0]!.aborted).toBe(true);
  });

  it('says the container exited rather than a bare "stream closed"', async () => {
    const { hub } = makeHub(['last line'], {
      endStream: true,
      inspectAfterEnd: { id: 'c1', name: 'cerberus-agent-x', threadKey: KEY, running: false },
    });
    const socket = new FakeSocket();
    hub.addClient(socket);
    socket.subscribe(logsChannel(KEY));
    await flush(120);
    const end = socket.ofType('log_end')[0] as { reason: string } | undefined;
    expect(end?.reason).toContain('container exited');
  });

  it('says the container was removed when it no longer exists', async () => {
    const { hub } = makeHub(['last line'], { endStream: true, inspectAfterEnd: null });
    const socket = new FakeSocket();
    hub.addClient(socket);
    socket.subscribe(logsChannel(KEY));
    await flush(120);
    const end = socket.ofType('log_end')[0] as { reason: string } | undefined;
    expect(end?.reason).toBe('container was removed');
  });

  it('aborts log streams when the socket closes', async () => {
    const { hub, aborted } = makeHub(['x']);
    const socket = new FakeSocket();
    hub.addClient(socket);
    socket.subscribe(logsChannel(KEY));
    await flush();
    socket.emit('close');
    await flush();
    expect(aborted[0]!.aborted).toBe(true);
  });

  it('reports log_end instead of crashing when the registry lookup fails', async () => {
    const { hub } = makeHub([], { registryGet: async () => { throw new Error('db down'); } });
    const socket = new FakeSocket();
    hub.addClient(socket);
    socket.subscribe(logsChannel(KEY));
    await flush();
    expect(socket.ofType('log_end')).toHaveLength(1);
  });

  it('does not leak a log stream when the socket closes during setup', async () => {
    const { hub, aborted } = makeHub(['x']);
    const socket = new FakeSocket();
    hub.addClient(socket);
    socket.subscribe(logsChannel(KEY));
    socket.emit('close');            // closes while the lookups are still in flight
    await flush(80);
    // Either no stream was ever started, or it was started and aborted — never left running.
    expect(aborted.every((s) => s.aborted)).toBe(true);
  });

  it('re-subscribes to events after stop() then start()', async () => {
    const { hub, events } = makeHub();
    const socket = new FakeSocket();
    hub.addClient(socket);
    socket.subscribe(OVERVIEW_CHANNEL);
    await flush();
    hub.start();
    hub.stop();
    hub.start();
    const before = socket.ofType('snapshot').length;
    events.publish({ kind: 'agent_spawned', threadKey: KEY, at: 'now' });
    await flush();
    expect(socket.ofType('snapshot').length).toBeGreaterThan(before);
    hub.stop();
  });

  it('answers ping with pong and rejects malformed messages', async () => {
    const { hub } = makeHub();
    const socket = new FakeSocket();
    hub.addClient(socket);
    socket.emit('message', JSON.stringify({ type: 'ping' }));
    socket.emit('message', 'not json');
    await flush();
    expect(socket.ofType('pong')).toHaveLength(1);
    expect(socket.ofType('error')).toHaveLength(1);
  });
});

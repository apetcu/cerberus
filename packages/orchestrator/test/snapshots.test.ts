import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capabilitiesSchema } from '@cerberus/protocol';
import { MemoryThreadRegistry } from '../src/registry/memory-thread-registry.js';
import { agentName, type AgentHandle, type AgentRuntime } from '../src/runtime/agent-runtime.js';
import { SnapshotBuilder } from '../src/api/snapshots.js';
import type { CapabilitiesRepo } from '../src/registry/capabilities-repo.js';
import type { StreamsClient } from '../src/mailbox/redis-stores.js';

const log = pino({ level: 'silent' });
const KEY = 'T1-C1-1.2';

function fakeRuntime(live: AgentHandle[], throws = false): AgentRuntime {
  return {
    spawn: vi.fn(), stop: vi.fn(), logs: vi.fn(),
    list: vi.fn(async () => { if (throws) throw new Error('docker down'); return live; }),
    inspect: vi.fn(async (name: string) => live.find((h) => h.name === name) ?? null),
  } as unknown as AgentRuntime;
}

const fakeRedis = (depth: number, heartbeat: number): StreamsClient => ({
  xlen: vi.fn(async () => depth),
  exists: vi.fn(async () => heartbeat),
} as unknown as StreamsClient);

const fakeCaps = (stored: boolean): CapabilitiesRepo => ({
  get: vi.fn(async () => (stored ? capabilitiesSchema.parse({ model: 'stored-model' }) : null)),
  upsert: vi.fn(),
  getMany: vi.fn(async () => new Map()),
});

describe('SnapshotBuilder', () => {
  let ws: string;
  let registry: MemoryThreadRegistry;

  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), 'cerberus-snap-'));
    registry = new MemoryThreadRegistry();
    await registry.upsertActivity({
      threadKey: KEY, teamId: 'T1', channelId: 'C1', threadTs: '1.2',
      runtime: 'docker', workspacePath: join(ws, KEY),
    });
  });
  afterEach(async () => { await rm(ws, { recursive: true, force: true }); });

  const build = (runtime: AgentRuntime, redis: StreamsClient, caps = fakeCaps(false)) =>
    new SnapshotBuilder({
      registry, runtime, capabilities: caps, redis,
      runtimeName: 'docker', workspacesRoot: ws, log,
    });

  it('overview reports counts, container liveness, heartbeat and mailbox depth', async () => {
    await registry.setStatus(KEY, 'running', { containerId: 'c1', containerName: agentName(KEY) });
    const handle = { id: 'c1', name: agentName(KEY), threadKey: KEY, running: true };
    const snap = await build(fakeRuntime([handle]), fakeRedis(3, 1)).overview();

    expect(snap.counts).toMatchObject({ total: 1, running: 1 });
    expect(snap.runtimeHealthy).toBe(true);
    expect(snap.agents[0]).toMatchObject({
      threadKey: KEY, status: 'running', containerRunning: true, heartbeatFresh: true, mailboxDepth: 3,
    });
    expect(typeof snap.agents[0]!.createdAt).toBe('string');
  });

  it('marks containerRunning false when the registry row has no live container', async () => {
    await registry.setStatus(KEY, 'running', { containerId: 'gone', containerName: 'gone' });
    const snap = await build(fakeRuntime([]), fakeRedis(0, 0)).overview();
    expect(snap.agents[0]).toMatchObject({ containerRunning: false, heartbeatFresh: false });
  });

  it('degrades gracefully when the runtime is unreachable', async () => {
    const snap = await build(fakeRuntime([], true), fakeRedis(0, 0)).overview();
    expect(snap.runtimeHealthy).toBe(false);
    expect(snap.agents).toHaveLength(1); // registry data still renders
  });

  it('detail includes conversation from the workspace and stored capabilities', async () => {
    await mkdir(join(ws, KEY), { recursive: true });
    await writeFile(join(ws, KEY, 'conversation.json'), JSON.stringify([
      { id: 'a', role: 'user', text: 'hi', ts: '2026-07-19T00:00:00.000Z' },
    ]));
    const detail = await build(fakeRuntime([]), fakeRedis(0, 0), fakeCaps(true)).detail(KEY);
    expect(detail!.conversation).toHaveLength(1);
    expect(detail!.capabilities.model).toBe('stored-model');
    expect(detail!.workspacePath).toContain(KEY);
  });

  it('detail falls back to default capabilities and empty conversation', async () => {
    const detail = await build(fakeRuntime([]), fakeRedis(0, 0)).detail(KEY);
    expect(detail!.conversation).toEqual([]);
    expect(detail!.capabilities.model).toBe('stub');
  });

  it('detail returns null for an unknown thread', async () => {
    expect(await build(fakeRuntime([]), fakeRedis(0, 0)).detail('nope')).toBeNull();
  });

  it('skips an agent whose summary fails instead of blanking the fleet', async () => {
    const badKey = 'T1-C1-2.3';
    await registry.upsertActivity({
      threadKey: badKey, teamId: 'T1', channelId: 'C1', threadTs: '2.3',
      runtime: 'docker', workspacePath: join(ws, badKey),
    });
    // Inject a record with deliberately broken createdAt so toISOString() throws
    const records = await registry.listRecent(10);
    const badRecord = records.find((r) => r.threadKey === badKey)!;
    Object.defineProperty(badRecord, 'createdAt', {
      value: null,
      configurable: true,
    });
    // Replace listRecent to inject the corrupted record
    const originalListRecent = registry.listRecent.bind(registry);
    (registry as unknown as { listRecent: (limit: number) => Promise<typeof records> }).listRecent =
      async () => {
        const all = await originalListRecent(10);
        return all.map((r) => (r.threadKey === badKey ? badRecord : r));
      };

    const snap = await build(fakeRuntime([]), fakeRedis(0, 0)).overview();
    expect(snap.agents.map((a) => a.threadKey)).toEqual([KEY]);
  });

  it('orders listRecent deterministically when timestamps tie', async () => {
    const other = 'T1-C1-0.1';
    await registry.upsertActivity({
      threadKey: other, teamId: 'T1', channelId: 'C1', threadTs: '0.1',
      runtime: 'docker', workspacePath: join(ws, other),
    });
    const rows = await registry.listRecent(10);
    const tied = rows.filter((r) => r.lastActivityAt.getTime() === rows[0]!.lastActivityAt.getTime());
    if (tied.length > 1) {
      expect([...tied].map((r) => r.threadKey)).toEqual([...tied].map((r) => r.threadKey).sort());
    }
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });
});

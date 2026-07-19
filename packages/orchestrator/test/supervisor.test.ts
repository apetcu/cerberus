import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { MemoryThreadRegistry } from '../src/registry/memory-thread-registry.js';
import {
  agentName, type AgentHandle, type AgentRuntime, type AgentSpec, type LogOptions,
} from '../src/runtime/agent-runtime.js';
import { ThreadSupervisor, type SupervisorConfig } from '../src/lifecycle/supervisor.js';
import { DrainState } from '../src/lifecycle/drain.js';

const log = pino({ level: 'silent' });
const cfg: SupervisorConfig = {
  runtime: 'docker', agentImage: 'cerberus-agent:dev', agentRedisUrl: 'redis://agents',
  logLevel: 'info', workspacesRoot: '/workspaces', workspacesHostRoot: '/host/workspaces',
  maxConcurrentAgents: 2, limits: { cpu: 0.5, memoryBytes: 512 * 1024 * 1024, pids: 256 },
};
const params = { threadKey: 'T1-C1-1.2', teamId: 'T1', channelId: 'C1', threadTs: '1.2' };

class FakeRuntime implements AgentRuntime {
  spawned: AgentSpec[] = [];
  spawnDelayMs = 0;
  failNext = false;
  live = new Map<string, AgentHandle>();

  async spawn(spec: AgentSpec): Promise<AgentHandle> {
    if (this.spawnDelayMs) await new Promise((r) => setTimeout(r, this.spawnDelayMs));
    if (this.failNext) { this.failNext = false; throw new Error('spawn failed'); }
    this.spawned.push(spec);
    const handle = { id: `id-${spec.threadKey}`, name: agentName(spec.threadKey), threadKey: spec.threadKey, running: true };
    this.live.set(handle.name, handle);
    return handle;
  }
  async stop(h: AgentHandle): Promise<void> { this.live.delete(h.name); }
  async list(): Promise<AgentHandle[]> { return [...this.live.values()]; }
  async inspect(name: string): Promise<AgentHandle | null> { return this.live.get(name) ?? null; }
  // eslint-disable-next-line require-yield
  async *logs(_handle: AgentHandle, _opts: LogOptions): AsyncIterable<string> {}
}

function make(runtimeOverrides: Partial<FakeRuntime> = {}, drain?: DrainState) {
  const registry = new MemoryThreadRegistry();
  const runtime = Object.assign(new FakeRuntime(), runtimeOverrides);
  const ensureDir = vi.fn(async () => {});
  const supervisor = new ThreadSupervisor({ registry, runtime, log, ensureDir, drain }, cfg);
  return { registry, runtime, supervisor, ensureDir };
}

describe('ThreadSupervisor.ensureRunning', () => {
  it('spawns on first message with correct spec and marks running', async () => {
    const { registry, runtime, supervisor, ensureDir } = make();
    const res = await supervisor.ensureRunning(params);
    expect(res.outcome).toBe('spawned');
    const spec = runtime.spawned[0]!;
    expect(spec.env).toEqual({
      THREAD_KEY: params.threadKey, REDIS_URL: 'redis://agents', WORKSPACE_PATH: '/workspace', LOG_LEVEL: 'info',
    });
    expect(spec.workspaceHostPath).toBe('/host/workspaces/T1-C1-1.2');
    expect(ensureDir).toHaveBeenCalledWith('/workspaces/T1-C1-1.2');
    expect((await registry.get(params.threadKey))!.status).toBe('running');
  });

  it('is idempotent when container is live', async () => {
    const { runtime, supervisor } = make();
    await supervisor.ensureRunning(params);
    const res = await supervisor.ensureRunning(params);
    expect(res.outcome).toBe('already-running');
    expect(runtime.spawned).toHaveLength(1);
  });

  it('respawns when registry says running but container is gone', async () => {
    const { runtime, supervisor } = make();
    await supervisor.ensureRunning(params);
    runtime.live.clear(); // container died
    const res = await supervisor.ensureRunning(params);
    expect(res.outcome).toBe('spawned');
    expect(runtime.spawned).toHaveLength(2);
  });

  it('two concurrent calls spawn exactly once', async () => {
    const { runtime, supervisor } = make({ spawnDelayMs: 20 });
    const [a, b] = await Promise.all([supervisor.ensureRunning(params), supervisor.ensureRunning(params)]);
    expect(runtime.spawned).toHaveLength(1);
    expect([a.outcome, b.outcome].sort()).toEqual(['already-running', 'spawned']);
  });

  it('defers above the concurrency cap', async () => {
    const { supervisor } = make();
    await supervisor.ensureRunning(params);
    await supervisor.ensureRunning({ ...params, threadKey: 'T1-C2-1.2', channelId: 'C2' });
    const res = await supervisor.ensureRunning({ ...params, threadKey: 'T1-C3-1.2', channelId: 'C3' });
    expect(res.outcome).toBe('deferred');
    expect(res.record.status).toBe('provisioning');
  });

  it('marks failed and records failure on spawn error', async () => {
    const { registry, supervisor } = make({ failNext: true });
    const res = await supervisor.ensureRunning(params);
    expect(res.outcome).toBe('failed');
    const rec = (await registry.get(params.threadKey))!;
    expect(rec.status).toBe('failed');
    expect(rec.failureCount).toBe(1);
  });

  it('returns drained and never spawns while draining', async () => {
    const drain = new DrainState();
    drain.set(true);
    const { runtime, supervisor } = make({}, drain);
    const res = await supervisor.ensureRunning(params);
    expect(res.outcome).toBe('drained');
    expect(runtime.spawned).toHaveLength(0);
  });

  it('spawns again once draining ends', async () => {
    const drain = new DrainState();
    drain.set(true);
    const { runtime, supervisor } = make({}, drain);
    await supervisor.ensureRunning(params);
    drain.set(false);
    const res = await supervisor.ensureRunning(params);
    expect(res.outcome).toBe('spawned');
    expect(runtime.spawned).toHaveLength(1);
  });
});

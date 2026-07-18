import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { MemoryThreadRegistry } from '../src/registry/memory-thread-registry.js';
import { agentName, type AgentHandle, type AgentRuntime } from '../src/runtime/agent-runtime.js';
import { IdleReaper } from '../src/lifecycle/reaper.js';

const log = pino({ level: 'silent' });
const IDLE_MS = 1000;

function makeRuntime(live: string[]): AgentRuntime & { stopped: string[] } {
  const stopped: string[] = [];
  return {
    stopped,
    spawn: vi.fn(),
    stop: vi.fn(async (h: AgentHandle) => { stopped.push(h.name); }),
    list: vi.fn(async () => []),
    inspect: vi.fn(async (name: string) =>
      live.includes(name) ? { id: 'x', name, threadKey: 'k', running: true } : null),
  } as unknown as AgentRuntime & { stopped: string[] };
}

async function seed(registry: MemoryThreadRegistry, threadKey: string, lastActivityAgoMs: number, now: Date) {
  await registry.upsertActivity({
    threadKey, teamId: 'T1', channelId: 'C1', threadTs: '1.2',
    runtime: 'docker', workspacePath: `/w/${threadKey}`,
  });
  await registry.setStatus(threadKey, 'running', { containerId: 'c', containerName: agentName(threadKey) });
  // backdate lastActivity via a direct re-read + mutation hack: MemoryThreadRegistry returns copies,
  // so expose the cutoff through the reaper's injected clock instead: "now" is shifted forward.
  void lastActivityAgoMs; void now;
}

describe('IdleReaper', () => {
  it('stops idle running threads: control message, runtime stop, status stopped', async () => {
    const registry = new MemoryThreadRegistry();
    const now = new Date();
    await seed(registry, 'T1-C1-1.2', 0, now);
    const runtime = makeRuntime([agentName('T1-C1-1.2')]);
    const producer = { publishControl: vi.fn(async () => {}) };
    const future = () => new Date(now.getTime() + IDLE_MS + 60_000);
    const reaper = new IdleReaper({ registry, runtime, producer, log, now: future }, IDLE_MS);

    expect(await reaper.tick()).toBe(1);
    expect(producer.publishControl).toHaveBeenCalledWith('T1-C1-1.2', 'shutdown');
    expect(runtime.stopped).toEqual([agentName('T1-C1-1.2')]);
    expect(await registry.get('T1-C1-1.2')).toMatchObject({
      status: 'stopped', containerId: null, containerName: null,
    });
  });

  it('leaves active threads alone', async () => {
    const registry = new MemoryThreadRegistry();
    const now = new Date();
    await seed(registry, 'T1-C1-1.2', 0, now);
    const runtime = makeRuntime([agentName('T1-C1-1.2')]);
    const producer = { publishControl: vi.fn(async () => {}) };
    const reaper = new IdleReaper({ registry, runtime, producer, log, now: () => now }, IDLE_MS);
    expect(await reaper.tick()).toBe(0);
    expect(runtime.stopped).toEqual([]);
  });

  it('still marks stopped when the container is already gone', async () => {
    const registry = new MemoryThreadRegistry();
    const now = new Date();
    await seed(registry, 'T1-C1-1.2', 0, now);
    const runtime = makeRuntime([]); // nothing live
    const producer = { publishControl: vi.fn(async () => {}) };
    const future = () => new Date(now.getTime() + IDLE_MS + 60_000);
    const reaper = new IdleReaper({ registry, runtime, producer, log, now: future }, IDLE_MS);
    expect(await reaper.tick()).toBe(1);
    expect((await registry.get('T1-C1-1.2'))!.status).toBe('stopped');
  });
});

import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { MemoryThreadRegistry } from '../src/registry/memory-thread-registry.js';
import { agentName, type AgentHandle, type AgentRuntime } from '../src/runtime/agent-runtime.js';
import { LivenessMonitor } from '../src/lifecycle/liveness.js';

const log = pino({ level: 'silent' });
const GRACE_MS = 60_000;
const THREAD = 'T1-C1-1.2';

async function seed(registry: MemoryThreadRegistry, threadKey: string) {
  await registry.upsertActivity({
    threadKey, teamId: 'T1', channelId: 'C1', threadTs: threadKey.split('-')[2]!,
    runtime: 'docker', workspacePath: `/w/${threadKey}`,
  });
  await registry.setStatus(threadKey, 'running', { containerId: 'c', containerName: agentName(threadKey) });
}

function makeRuntime(
  inspect: AgentRuntime['inspect'],
): AgentRuntime & { stopped: string[] } {
  const stopped: string[] = [];
  return {
    spawn: vi.fn(),
    stop: vi.fn(async (h: AgentHandle) => { stopped.push(h.name); }),
    list: vi.fn(async () => []),
    inspect,
    logs: vi.fn(),
    stopped,
  } as unknown as AgentRuntime & { stopped: string[] };
}

/** Past the grace window relative to a row seeded "now". */
function future(now: Date) {
  return () => new Date(now.getTime() + GRACE_MS + 1000);
}

describe('LivenessMonitor', () => {
  it('marks a gone container stopped with container_gone', async () => {
    const registry = new MemoryThreadRegistry();
    const now = new Date();
    await seed(registry, THREAD);
    const runtime = makeRuntime(vi.fn(async () => null));
    const redis = { exists: vi.fn(async () => 1) };
    const events = { publish: vi.fn() };
    const monitor = new LivenessMonitor(
      { registry, runtime, redis, log, events: events as any, now: future(now) },
      GRACE_MS,
    );

    expect(await monitor.tick()).toBe(1);
    expect(await registry.get(THREAD)).toMatchObject({
      status: 'stopped', containerId: null, containerName: null,
    });
    expect(events.publish).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'agent_died', threadKey: THREAD, cause: 'container_gone' }),
    );
    expect(runtime.stopped).toEqual([]);
  });

  it('marks an exited container stopped with container_exited', async () => {
    const registry = new MemoryThreadRegistry();
    const now = new Date();
    await seed(registry, THREAD);
    const name = agentName(THREAD);
    const runtime = makeRuntime(vi.fn(async () => ({ id: 'c', name, threadKey: THREAD, running: false })));
    const redis = { exists: vi.fn(async () => 1) };
    const events = { publish: vi.fn() };
    const monitor = new LivenessMonitor(
      { registry, runtime, redis, log, events: events as any, now: future(now) },
      GRACE_MS,
    );

    expect(await monitor.tick()).toBe(1);
    expect((await registry.get(THREAD))!.status).toBe('stopped');
    expect(events.publish).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'agent_died', threadKey: THREAD, cause: 'container_exited' }),
    );
    expect(runtime.stopped).toEqual([]);
  });

  it('stops the container and marks heartbeat_stale when the heartbeat key is missing', async () => {
    const registry = new MemoryThreadRegistry();
    const now = new Date();
    await seed(registry, THREAD);
    const name = agentName(THREAD);
    const runtime = makeRuntime(vi.fn(async () => ({ id: 'c', name, threadKey: THREAD, running: true })));
    const redis = { exists: vi.fn(async () => 0) };
    const events = { publish: vi.fn() };
    const monitor = new LivenessMonitor(
      { registry, runtime, redis, log, events: events as any, now: future(now) },
      GRACE_MS,
    );

    expect(await monitor.tick()).toBe(1);
    expect(runtime.stopped).toEqual([name]);
    expect((await registry.get(THREAD))!.status).toBe('stopped');
    expect(events.publish).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'agent_died', threadKey: THREAD, cause: 'heartbeat_stale' }),
    );
  });

  it('leaves a row inside the grace window untouched', async () => {
    const registry = new MemoryThreadRegistry();
    const now = new Date();
    await seed(registry, THREAD);
    // Never called in-window, but wired to fail loudly if it is.
    const runtime = makeRuntime(vi.fn(async () => { throw new Error('should not be called'); }));
    const redis = { exists: vi.fn(async () => 0) };
    const events = { publish: vi.fn() };
    const monitor = new LivenessMonitor(
      { registry, runtime, redis, log, events: events as any, now: () => now },
      GRACE_MS,
    );

    expect(await monitor.tick()).toBe(0);
    expect((await registry.get(THREAD))!.status).toBe('running');
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('leaves a healthy row with a fresh heartbeat untouched', async () => {
    const registry = new MemoryThreadRegistry();
    const now = new Date();
    await seed(registry, THREAD);
    const name = agentName(THREAD);
    const runtime = makeRuntime(vi.fn(async () => ({ id: 'c', name, threadKey: THREAD, running: true })));
    const redis = { exists: vi.fn(async () => 1) };
    const events = { publish: vi.fn() };
    const monitor = new LivenessMonitor(
      { registry, runtime, redis, log, events: events as any, now: future(now) },
      GRACE_MS,
    );

    expect(await monitor.tick()).toBe(0);
    expect((await registry.get(THREAD))!.status).toBe('running');
    expect(runtime.stopped).toEqual([]);
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('does not mark a row stopped when inspect throws, but still processes the next row', async () => {
    const registry = new MemoryThreadRegistry();
    const now = new Date();
    const okThread = 'T1-C1-9.9';
    await seed(registry, THREAD);
    await seed(registry, okThread);
    const throwingName = agentName(THREAD);
    const runtime = makeRuntime(vi.fn(async (name: string) => {
      if (name === throwingName) throw new Error('docker daemon unreachable');
      return null; // the other row's container is gone: should still be marked dead
    }));
    const redis = { exists: vi.fn(async () => 1) };
    const events = { publish: vi.fn() };
    const errorSpy = vi.spyOn(log, 'error');
    const monitor = new LivenessMonitor(
      { registry, runtime, redis, log, events: events as any, now: future(now) },
      GRACE_MS,
    );

    expect(await monitor.tick()).toBe(1);
    expect((await registry.get(THREAD))!.status).toBe('running');
    expect((await registry.get(okThread))!.status).toBe('stopped');
    expect(events.publish).toHaveBeenCalledTimes(1);
    expect(events.publish).toHaveBeenCalledWith(
      expect.objectContaining({ threadKey: okThread, kind: 'agent_died', cause: 'container_gone' }),
    );
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

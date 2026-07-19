import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { heartbeatKey } from '@cerberus/protocol';
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

describe('LivenessMonitor', () => {
  it('leaves an unhealthy row untouched on first sighting, then marks it dead once the grace elapses', async () => {
    const registry = new MemoryThreadRegistry();
    let now = new Date();
    await seed(registry, THREAD);
    const runtime = makeRuntime(vi.fn(async () => null)); // container gone
    const redis = { exists: vi.fn(async () => 1) };
    const events = { publish: vi.fn() };
    const monitor = new LivenessMonitor(
      { registry, runtime, redis, log, events: events as any, now: () => now },
      GRACE_MS,
    );

    // First sighting: recorded, but never enough on its own.
    expect(await monitor.tick()).toBe(0);
    expect((await registry.get(THREAD))!.status).toBe('running');
    expect(events.publish).not.toHaveBeenCalled();

    // Still inside the grace window measured from that first sighting.
    now = new Date(now.getTime() + GRACE_MS / 2);
    expect(await monitor.tick()).toBe(0);
    expect((await registry.get(THREAD))!.status).toBe('running');

    // Grace has elapsed since the row was first observed unhealthy: act.
    now = new Date(now.getTime() + GRACE_MS / 2 + 1000);
    expect(await monitor.tick()).toBe(1);
    expect(await registry.get(THREAD)).toMatchObject({
      status: 'stopped', containerId: null, containerName: null,
    });
    expect(events.publish).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'agent_died', threadKey: THREAD, cause: 'container_gone' }),
    );
    expect(runtime.stopped).toEqual([]);
  });

  it('marks an exited container stopped with container_exited once the grace elapses, and removes it', async () => {
    const registry = new MemoryThreadRegistry();
    let now = new Date();
    await seed(registry, THREAD);
    const name = agentName(THREAD);
    const runtime = makeRuntime(vi.fn(async () => ({ id: 'c', name, threadKey: THREAD, running: false })));
    const redis = { exists: vi.fn(async () => 1) };
    const events = { publish: vi.fn() };
    const monitor = new LivenessMonitor(
      { registry, runtime, redis, log, events: events as any, now: () => now },
      GRACE_MS,
    );

    expect(await monitor.tick()).toBe(0); // first sighting only
    now = new Date(now.getTime() + GRACE_MS + 1000);
    expect(await monitor.tick()).toBe(1);
    expect((await registry.get(THREAD))!.status).toBe('stopped');
    expect(events.publish).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'agent_died', threadKey: THREAD, cause: 'container_exited' }),
    );
    // An exited container still holds its writable layer until removed: left alone it would
    // linger until the thread happens to respawn, or forever if it never does.
    expect(runtime.stopped).toEqual([name]);
  });

  it('stops the container and marks heartbeat_stale once a missing heartbeat has persisted through the grace', async () => {
    const registry = new MemoryThreadRegistry();
    let now = new Date();
    await seed(registry, THREAD);
    const name = agentName(THREAD);
    const runtime = makeRuntime(vi.fn(async () => ({ id: 'c', name, threadKey: THREAD, running: true })));
    const redis = { exists: vi.fn(async () => 0) };
    const events = { publish: vi.fn() };
    const monitor = new LivenessMonitor(
      { registry, runtime, redis, log, events: events as any, now: () => now },
      GRACE_MS,
    );

    expect(await monitor.tick()).toBe(0); // first sighting: not even stopped yet
    expect(runtime.stopped).toEqual([]);

    now = new Date(now.getTime() + GRACE_MS + 1000);
    expect(await monitor.tick()).toBe(1);
    expect(runtime.stopped).toEqual([name]);
    expect((await registry.get(THREAD))!.status).toBe('stopped');
    expect(events.publish).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'agent_died', threadKey: THREAD, cause: 'heartbeat_stale' }),
    );
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
      { registry, runtime, redis, log, events: events as any, now: () => new Date(now.getTime() + GRACE_MS + 1000) },
      GRACE_MS,
    );

    expect(await monitor.tick()).toBe(0);
    expect((await registry.get(THREAD))!.status).toBe('running');
    expect(runtime.stopped).toEqual([]);
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('resets the clock when a thread recovers before the grace elapses', async () => {
    const registry = new MemoryThreadRegistry();
    let now = new Date();
    await seed(registry, THREAD);
    const name = agentName(THREAD);
    const runtime = makeRuntime(vi.fn(async () => ({ id: 'c', name, threadKey: THREAD, running: true })));
    let heartbeat = 0; // missing at first: unhealthy
    const redis = { exists: vi.fn(async () => heartbeat) };
    const events = { publish: vi.fn() };
    const monitor = new LivenessMonitor(
      { registry, runtime, redis, log, events: events as any, now: () => now },
      GRACE_MS,
    );

    expect(await monitor.tick()).toBe(0); // first sighting, unhealthy

    heartbeat = 1; // recovers before the grace elapses
    now = new Date(now.getTime() + GRACE_MS / 2);
    expect(await monitor.tick()).toBe(0);

    // Enough wall-clock time has now passed since the *original* sighting to have crossed
    // the grace, but the recovery reset the clock, so a fresh unhealthy spell must start over.
    heartbeat = 0;
    now = new Date(now.getTime() + GRACE_MS - 1000);
    expect(await monitor.tick()).toBe(0);
    expect((await registry.get(THREAD))!.status).toBe('running');
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('keeps the original since but updates to the newest cause when the failure mode changes', async () => {
    const registry = new MemoryThreadRegistry();
    let now = new Date();
    await seed(registry, THREAD);
    const name = agentName(THREAD);
    let handle: AgentHandle | null = { id: 'c', name, threadKey: THREAD, running: true };
    const runtime = makeRuntime(vi.fn(async () => handle));
    const redis = { exists: vi.fn(async () => 0) }; // heartbeat missing from the start
    const events = { publish: vi.fn() };
    const monitor = new LivenessMonitor(
      { registry, runtime, redis, log, events: events as any, now: () => now },
      GRACE_MS,
    );

    expect(await monitor.tick()).toBe(0); // first sighting: heartbeat_stale

    // Partway through the grace window the container disappears outright. The illness has
    // progressed from heartbeat_stale to container_gone, but the clock keeps running from
    // the original sighting rather than restarting.
    now = new Date(now.getTime() + GRACE_MS / 2);
    handle = null;
    expect(await monitor.tick()).toBe(0);

    now = new Date(now.getTime() + GRACE_MS / 2 + 1000);
    expect(await monitor.tick()).toBe(1);
    expect(events.publish).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'agent_died', threadKey: THREAD, cause: 'container_gone' }),
    );
    // The container was already gone by the time it was acted on: never stopped.
    expect(runtime.stopped).toEqual([]);
  });

  it('does not mark a row stopped when inspect throws, but still processes the next row', async () => {
    const registry = new MemoryThreadRegistry();
    let now = new Date();
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
      { registry, runtime, redis, log, events: events as any, now: () => now },
      GRACE_MS,
    );

    expect(await monitor.tick()).toBe(0); // first sighting of okThread; THREAD keeps throwing
    now = new Date(now.getTime() + GRACE_MS + 1000);
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

  it('marks a thread dead once unhealthy for the grace period even while updatedAt keeps advancing', async () => {
    // Reproduces the bug this fix closes: registry.upsertActivity bumps updatedAt on every
    // inbound Slack message. A user who keeps messaging a dead thread must not be able to
    // keep it inside a grace window forever just by continuing to talk to it.
    const registry = new MemoryThreadRegistry();
    let now = new Date();
    await seed(registry, THREAD);
    const runtime = makeRuntime(vi.fn(async () => null)); // container gone: crashed
    const redis = { exists: vi.fn(async () => 1) };
    const events = { publish: vi.fn() };
    const monitor = new LivenessMonitor(
      { registry, runtime, redis, log, events: events as any, now: () => now },
      GRACE_MS,
    );

    expect(await monitor.tick()).toBe(0); // first sighting

    for (let i = 0; i < 2; i += 1) {
      now = new Date(now.getTime() + GRACE_MS / 3);
      // Simulate the user continuing to message the dead thread, exactly what the Slack
      // router does on every inbound message.
      await registry.upsertActivity({
        threadKey: THREAD, teamId: 'T1', channelId: 'C1', threadTs: THREAD.split('-')[2]!,
        runtime: 'docker', workspacePath: `/w/${THREAD}`,
      });
      expect(await monitor.tick()).toBe(0);
    }

    now = new Date(now.getTime() + GRACE_MS + 1000);
    await registry.upsertActivity({
      threadKey: THREAD, teamId: 'T1', channelId: 'C1', threadTs: THREAD.split('-')[2]!,
      runtime: 'docker', workspacePath: `/w/${THREAD}`,
    });
    // updatedAt was just bumped again, yet the row must be marked dead: the grace is measured
    // from the monitor's own first sighting, not from updatedAt.
    expect(await monitor.tick()).toBe(1);
    expect((await registry.get(THREAD))!.status).toBe('stopped');
    expect(events.publish).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'agent_died', threadKey: THREAD, cause: 'container_gone' }),
    );
  });

  it('resets the grace when the row respawns under a new container id before the old grace elapsed', async () => {
    // Reproduces the bug this fix closes: a crashed thread is recorded unhealthy at t0. A
    // user message respawns it before the grace elapses. The row reads `running` across
    // ticks (the `provisioning` interlude is far shorter than a tick) and the new agent has
    // not written its first heartbeat yet. Without scoping the grace to the container's
    // identity, a tick landing after the *original* since plus the grace, but before the new
    // container's first heartbeat, would read the stale entry, see its grace already
    // elapsed, and stop the perfectly healthy new container.
    const registry = new MemoryThreadRegistry();
    let now = new Date();
    await seed(registry, THREAD); // containerId 'c': the container that is about to crash
    const name = agentName(THREAD);
    let inspectResult: AgentHandle | null = null; // original container: gone
    const runtime = makeRuntime(vi.fn(async () => inspectResult));
    let heartbeat = 0;
    const redis = { exists: vi.fn(async () => heartbeat) };
    const events = { publish: vi.fn() };
    const monitor = new LivenessMonitor(
      { registry, runtime, redis, log, events: events as any, now: () => now },
      GRACE_MS,
    );

    expect(await monitor.tick()).toBe(0); // first sighting of the crash: container_gone, since = t0

    // Before the original grace elapses, the thread respawns under a new container id. The
    // new container is up but has not written its first heartbeat yet.
    now = new Date(now.getTime() + GRACE_MS - 1000);
    await registry.setStatus(THREAD, 'running', { containerId: 'new-container', containerName: name });
    inspectResult = { id: 'new-container', name, threadKey: THREAD, running: true };

    // Wall-clock time since the *original* sighting has already crossed the grace, but the
    // new container must not be touched: it is a different life and has not even had its
    // first sighting recorded.
    expect(await monitor.tick()).toBe(0);
    expect((await registry.get(THREAD))!.status).toBe('running');
    expect(events.publish).not.toHaveBeenCalled();
    expect(runtime.stopped).toEqual([]);

    // The new container's own grace has not elapsed yet either.
    now = new Date(now.getTime() + GRACE_MS / 2);
    expect(await monitor.tick()).toBe(0);
    expect((await registry.get(THREAD))!.status).toBe('running');

    // Only once the grace has elapsed from the *new* sighting is it finally acted on.
    now = new Date(now.getTime() + GRACE_MS / 2 + 1000);
    expect(await monitor.tick()).toBe(1);
    expect((await registry.get(THREAD))!.status).toBe('stopped');
    expect(events.publish).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'agent_died', threadKey: THREAD, cause: 'heartbeat_stale' }),
    );
  });

  it('treats a running row with no container name as unhealthy with cause container_gone', async () => {
    // Such a row can never be inspected, so left alone it would sit invisible, and still
    // counting against the concurrency cap, forever; only boot-time reconciliation would
    // ever correct it. There is demonstrably no container to find.
    const registry = new MemoryThreadRegistry();
    let now = new Date();
    await registry.upsertActivity({
      threadKey: THREAD, teamId: 'T1', channelId: 'C1', threadTs: THREAD.split('-')[2]!,
      runtime: 'docker', workspacePath: `/w/${THREAD}`,
    });
    await registry.setStatus(THREAD, 'running'); // no ids given: containerName stays null
    const runtime = makeRuntime(vi.fn());
    const redis = { exists: vi.fn(async () => 1) };
    const events = { publish: vi.fn() };
    const monitor = new LivenessMonitor(
      { registry, runtime, redis, log, events: events as any, now: () => now },
      GRACE_MS,
    );

    expect(await monitor.tick()).toBe(0); // first sighting only
    expect(runtime.inspect).not.toHaveBeenCalled(); // nothing to inspect

    now = new Date(now.getTime() + GRACE_MS + 1000);
    expect(await monitor.tick()).toBe(1);
    expect((await registry.get(THREAD))!.status).toBe('stopped');
    expect(events.publish).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'agent_died', threadKey: THREAD, cause: 'container_gone' }),
    );
  });

  it('does not abort the tick when redis.exists throws, but still processes the next row', async () => {
    const registry = new MemoryThreadRegistry();
    let now = new Date();
    const okThread = 'T1-C1-9.9';
    await seed(registry, THREAD);
    await seed(registry, okThread);
    const throwingKey = heartbeatKey(THREAD);
    const runtime = makeRuntime(vi.fn(async (name: string) =>
      ({ id: 'c', name, threadKey: name === agentName(THREAD) ? THREAD : okThread, running: true })));
    const redis = {
      exists: vi.fn(async (key: string) => {
        if (key === throwingKey) throw new Error('redis unreachable');
        return 0; // okThread has no heartbeat either: unhealthy, should still be processed
      }),
    };
    const events = { publish: vi.fn() };
    const errorSpy = vi.spyOn(log, 'error');
    const monitor = new LivenessMonitor(
      { registry, runtime, redis, log, events: events as any, now: () => now },
      GRACE_MS,
    );

    expect(await monitor.tick()).toBe(0); // first sighting of okThread; THREAD's redis check keeps throwing
    now = new Date(now.getTime() + GRACE_MS + 1000);
    expect(await monitor.tick()).toBe(1);
    expect((await registry.get(THREAD))!.status).toBe('running'); // untouched: redis kept throwing
    expect((await registry.get(okThread))!.status).toBe('stopped');
    expect(events.publish).toHaveBeenCalledTimes(1);
    expect(events.publish).toHaveBeenCalledWith(
      expect.objectContaining({ threadKey: okThread, kind: 'agent_died', cause: 'heartbeat_stale' }),
    );
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

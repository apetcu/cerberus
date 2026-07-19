import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { MemoryThreadRegistry } from '../src/registry/memory-thread-registry.js';
import { WorkspaceGC, type WorkspaceFs } from '../src/lifecycle/workspace-gc.js';
import type { ThreadLocks } from '../src/lifecycle/supervisor.js';
import type { ThreadStatus } from '../src/domain/thread.js';
import type { EventBus } from '../src/api/events.js';

const log = pino({ level: 'silent' });

// A sentinel, never a real filesystem path. Every WorkspaceFs call in these tests is
// served by FakeFs below: no test in this file touches a real directory.
const ROOT = 'fake://workspaces';
const MB = 1024 * 1024;

interface FakeDirSpec {
  bytes: number;
  dirMtimeMs: number;
  /** Omit to simulate a workspace with no conversation.json yet. */
  conversationMtimeMs?: number;
}

/** Purely in-memory WorkspaceFs. No real fs module is imported or called anywhere here. */
class FakeFs implements WorkspaceFs {
  readonly removed: string[] = [];
  listDirsCalls = 0;

  constructor(private readonly dirs: Map<string, FakeDirSpec>) {}

  async listDirs(root: string): Promise<string[]> {
    expect(root).toBe(ROOT);
    this.listDirsCalls += 1;
    return [...this.dirs.keys()];
  }

  async stat(path: string): Promise<{ mtimeMs: number } | null> {
    const { name, isConversation } = this.parse(path);
    const spec = this.dirs.get(name);
    if (!spec) return null;
    if (isConversation) {
      return spec.conversationMtimeMs === undefined ? null : { mtimeMs: spec.conversationMtimeMs };
    }
    return { mtimeMs: spec.dirMtimeMs };
  }

  async sizeOf(path: string): Promise<number> {
    const { name } = this.parse(path);
    return this.dirs.get(name)?.bytes ?? 0;
  }

  async remove(path: string): Promise<void> {
    const { name } = this.parse(path);
    this.removed.push(name);
    this.dirs.delete(name);
  }

  private parse(path: string): { name: string; isConversation: boolean } {
    expect(path.startsWith(`${ROOT}/`)).toBe(true);
    const rel = path.slice(ROOT.length + 1);
    const [name, maybeFile] = rel.split('/');
    return { name: name!, isConversation: maybeFile === 'conversation.json' };
  }
}

async function seed(registry: MemoryThreadRegistry, threadKey: string, status: ThreadStatus) {
  await registry.upsertActivity({
    threadKey, teamId: 'T1', channelId: 'C1', threadTs: '1.1',
    runtime: 'docker', workspacePath: `/w/${threadKey}`,
  });
  const ids = status === 'running'
    ? { containerId: 'c', containerName: threadKey }
    : undefined;
  await registry.setStatus(threadKey, status, ids);
}

/** Passthrough ThreadLocks that records every key locked, in order. */
function makeLocks(): ThreadLocks & { locked: string[] } {
  const locked: string[] = [];
  return {
    locked,
    async withThreadLock(threadKey, fn) {
      locked.push(threadKey);
      return fn();
    },
  };
}

const daysAgo = (n: number) => Date.now() - n * 24 * 60 * 60 * 1000;

describe('WorkspaceGC', () => {
  it('does nothing under the cap', async () => {
    const fs = new FakeFs(new Map([
      ['A', { bytes: 1 * MB, dirMtimeMs: daysAgo(5) }],
      ['B', { bytes: 1 * MB, dirMtimeMs: daysAgo(1) }],
    ]));
    const registry = new MemoryThreadRegistry();
    const events = { publish: () => {} } as unknown as EventBus;
    const gc = new WorkspaceGC({ root: ROOT, registry, locks: makeLocks(), log, events, fs }, 10);

    expect(await gc.collect()).toBe(0);
    expect(fs.removed).toEqual([]);
  });

  it('evicts oldest first, under the thread lock, and stops as soon as it is under the cap', async () => {
    const fs = new FakeFs(new Map([
      ['OLDEST', { bytes: 6 * MB, dirMtimeMs: daysAgo(10) }],
      ['MIDDLE', { bytes: 3 * MB, dirMtimeMs: daysAgo(5) }],
      ['NEWEST', { bytes: 3 * MB, dirMtimeMs: daysAgo(1) }],
    ]));
    const registry = new MemoryThreadRegistry();
    await seed(registry, 'OLDEST', 'stopped');
    await seed(registry, 'MIDDLE', 'stopped');
    await seed(registry, 'NEWEST', 'failed');
    const locks = makeLocks();
    const published: unknown[] = [];
    const events = { publish: (e: unknown) => published.push(e) } as unknown as EventBus;
    const gc = new WorkspaceGC({ root: ROOT, registry, locks, log, events, fs }, 10); // cap 10 MB, total 12 MB

    const reclaimed = await gc.collect();

    expect(reclaimed).toBe(6 * MB);
    expect(fs.removed).toEqual(['OLDEST']);
    expect(locks.locked).toEqual(['OLDEST']);
    expect(published).toEqual([
      expect.objectContaining({ kind: 'workspace_evicted', threadKey: 'OLDEST', bytes: 6 * MB }),
    ]);
  });

  it('never evicts a running thread workspace even when it is the oldest', async () => {
    const fs = new FakeFs(new Map([
      ['RUNNING', { bytes: 8 * MB, dirMtimeMs: daysAgo(30) }], // oldest, but protected
      ['IDLE', { bytes: 5 * MB, dirMtimeMs: daysAgo(2) }],
    ]));
    const registry = new MemoryThreadRegistry();
    await seed(registry, 'RUNNING', 'running');
    await seed(registry, 'IDLE', 'stopped');
    const events = { publish: () => {} } as unknown as EventBus;
    const gc = new WorkspaceGC({ root: ROOT, registry, locks: makeLocks(), log, events, fs }, 10); // cap 10 MB, total 13 MB

    const reclaimed = await gc.collect();

    expect(reclaimed).toBe(5 * MB);
    expect(fs.removed).toEqual(['IDLE']);
    expect(fs.removed).not.toContain('RUNNING');
  });

  it('never evicts a provisioning thread workspace: the supervisor is mid-spawn', async () => {
    const fs = new FakeFs(new Map([
      ['PROVISIONING', { bytes: 8 * MB, dirMtimeMs: daysAgo(30) }],
      ['GONE', { bytes: 5 * MB, dirMtimeMs: daysAgo(2) }],
    ]));
    const registry = new MemoryThreadRegistry();
    await seed(registry, 'PROVISIONING', 'provisioning');
    await seed(registry, 'GONE', 'stopped');
    const events = { publish: () => {} } as unknown as EventBus;
    const gc = new WorkspaceGC({ root: ROOT, registry, locks: makeLocks(), log, events, fs }, 10);

    expect(await gc.collect()).toBe(5 * MB);
    expect(fs.removed).toEqual(['GONE']);
    expect(fs.removed).not.toContain('PROVISIONING');
  });

  it('never evicts a stopping thread workspace: the agent is still flushing conversation.json', async () => {
    const fs = new FakeFs(new Map([
      ['STOPPING', { bytes: 8 * MB, dirMtimeMs: daysAgo(30) }],
      ['GONE', { bytes: 5 * MB, dirMtimeMs: daysAgo(2) }],
    ]));
    const registry = new MemoryThreadRegistry();
    await seed(registry, 'STOPPING', 'stopping');
    await seed(registry, 'GONE', 'failed');
    const events = { publish: () => {} } as unknown as EventBus;
    const gc = new WorkspaceGC({ root: ROOT, registry, locks: makeLocks(), log, events, fs }, 10);

    expect(await gc.collect()).toBe(5 * MB);
    expect(fs.removed).toEqual(['GONE']);
    expect(fs.removed).not.toContain('STOPPING');
  });

  it('never evicts a status it does not recognize: the allowlist fails safe', async () => {
    const fs = new FakeFs(new Map([
      ['FUTURE', { bytes: 20 * MB, dirMtimeMs: daysAgo(30) }],
    ]));
    const registry = new MemoryThreadRegistry();
    await seed(registry, 'FUTURE', 'archived' as ThreadStatus); // a status added after this GC was written
    const events = { publish: () => {} } as unknown as EventBus;
    const gc = new WorkspaceGC({ root: ROOT, registry, locks: makeLocks(), log, events, fs }, 10);

    expect(await gc.collect()).toBe(0);
    expect(fs.removed).toEqual([]);
  });

  it('does not delete a thread revived between the status snapshot and the delete', async () => {
    const fs = new FakeFs(new Map([
      ['RACE', { bytes: 20 * MB, dirMtimeMs: daysAgo(10) }],
    ]));
    const registry = new MemoryThreadRegistry();
    await seed(registry, 'RACE', 'stopped'); // evictable when the snapshot is taken
    // The sweeper wins the per-thread lock first and revives the thread; by the time the
    // GC's turn inside the lock runs, the status recheck must see running and back off.
    const locks: ThreadLocks = {
      async withThreadLock(threadKey, fn) {
        await registry.setStatus(threadKey, 'running', { containerId: 'c', containerName: threadKey });
        return fn();
      },
    };
    const published: unknown[] = [];
    const events = { publish: (e: unknown) => published.push(e) } as unknown as EventBus;
    const gc = new WorkspaceGC({ root: ROOT, registry, locks, log, events, fs }, 10);

    expect(await gc.collect()).toBe(0);
    expect(fs.removed).toEqual([]);
    expect(published).toEqual([]);
  });

  it('evicts a directory with no registry row, logging it instead of publishing a pseudo-thread event', async () => {
    const fs = new FakeFs(new Map([
      ['STRAY', { bytes: 20 * MB, dirMtimeMs: daysAgo(50) }],
    ]));
    const registry = new MemoryThreadRegistry();
    const warnSpy: unknown[][] = [];
    const testLog = { ...log, warn: (...args: unknown[]) => warnSpy.push(args) } as unknown as typeof log;
    const published: unknown[] = [];
    const events = { publish: (e: unknown) => published.push(e) } as unknown as EventBus;
    const gc = new WorkspaceGC({ root: ROOT, registry, locks: makeLocks(), log: testLog, events, fs }, 10);

    expect(await gc.collect()).toBe(20 * MB);
    expect(fs.removed).toEqual(['STRAY']);
    expect(published).toEqual([]);
    expect(warnSpy).toHaveLength(1);
    expect(warnSpy[0]![0]).toMatchObject({ directory: 'STRAY', bytes: 20 * MB });
  });

  it('warns and returns partial bytes when only protected directories remain over cap', async () => {
    const fs = new FakeFs(new Map([
      ['IDLE', { bytes: 2 * MB, dirMtimeMs: daysAgo(9) }], // oldest evictable
      ['RUN1', { bytes: 3 * MB, dirMtimeMs: daysAgo(20) }],
      ['RUN2', { bytes: 3 * MB, dirMtimeMs: daysAgo(15) }],
    ]));
    const registry = new MemoryThreadRegistry();
    await seed(registry, 'IDLE', 'stopped');
    await seed(registry, 'RUN1', 'running');
    await seed(registry, 'RUN2', 'running');
    const warnSpy: unknown[][] = [];
    const testLog = { ...log, warn: (...args: unknown[]) => warnSpy.push(args) } as unknown as typeof log;
    const events = { publish: () => {} } as unknown as EventBus;
    const gc = new WorkspaceGC({ root: ROOT, registry, locks: makeLocks(), log: testLog, events, fs }, 5); // cap 5 MB, total 8 MB

    const reclaimed = await gc.collect();

    expect(reclaimed).toBe(2 * MB); // only IDLE could be evicted
    expect(fs.removed).toEqual(['IDLE']);
    expect(fs.removed).not.toContain('RUN1');
    expect(fs.removed).not.toContain('RUN2');
    expect(warnSpy).toHaveLength(1);
    expect(warnSpy[0]![0]).toMatchObject({ shortfallBytes: 1 * MB });
  });

  it('disables entirely when maxMb is 0', async () => {
    const fs = new FakeFs(new Map([
      ['A', { bytes: 100 * MB, dirMtimeMs: daysAgo(100) }],
    ]));
    const registry = new MemoryThreadRegistry();
    const events = { publish: () => {} } as unknown as EventBus;
    const gc = new WorkspaceGC({ root: ROOT, registry, locks: makeLocks(), log, events, fs }, 0);

    expect(await gc.collect()).toBe(0);
    expect(fs.removed).toEqual([]);
    expect(fs.listDirsCalls).toBe(0);
  });

  it('usage() reports total bytes, count, and the oldest touch time, preferring conversation.json mtime', async () => {
    const yMtimeMs = daysAgo(10);
    const fs = new FakeFs(new Map([
      // conversation.json is much newer than the directory itself: last-touched should
      // follow the file, not the stale directory mtime.
      ['X', { bytes: 1 * MB, dirMtimeMs: daysAgo(300), conversationMtimeMs: daysAgo(1) }],
      // no conversation.json yet: falls back to the directory mtime.
      ['Y', { bytes: 2 * MB, dirMtimeMs: yMtimeMs }],
    ]));
    const registry = new MemoryThreadRegistry();
    const events = { publish: () => {} } as unknown as EventBus;
    const gc = new WorkspaceGC({ root: ROOT, registry, locks: makeLocks(), log, events, fs }, 10);

    const usage = await gc.usage();

    expect(usage.totalBytes).toBe(3 * MB);
    expect(usage.capBytes).toBe(10 * MB);
    expect(usage.count).toBe(2);
    expect(usage.oldestTouchedAt).toBe(new Date(yMtimeMs).toISOString()); // Y, not X
  });

  it('usage() reports zero and null oldest when there are no workspaces', async () => {
    const fs = new FakeFs(new Map());
    const registry = new MemoryThreadRegistry();
    const gc = new WorkspaceGC({ root: ROOT, registry, locks: makeLocks(), log, fs }, 10);

    const usage = await gc.usage();

    expect(usage).toEqual({ totalBytes: 0, capBytes: 10 * MB, count: 0, oldestTouchedAt: null });
  });

  it('serves usage() from cache within the TTL instead of re-walking the filesystem', async () => {
    const fs = new FakeFs(new Map([
      ['A', { bytes: 1 * MB, dirMtimeMs: daysAgo(1) }],
    ]));
    const registry = new MemoryThreadRegistry();
    let now = new Date();
    const gc = new WorkspaceGC({ root: ROOT, registry, locks: makeLocks(), log, fs, now: () => now }, 10);

    const first = await gc.usage();
    expect(fs.listDirsCalls).toBe(1);

    // Still inside the 30 second TTL: served from cache, no second walk.
    now = new Date(now.getTime() + 29_000);
    const second = await gc.usage();
    expect(second).toEqual(first);
    expect(fs.listDirsCalls).toBe(1);

    // Past the TTL: the tree is walked again.
    now = new Date(now.getTime() + 2000);
    await gc.usage();
    expect(fs.listDirsCalls).toBe(2);
  });

  it('invalidates the usage() cache once collect() actually evicts something', async () => {
    const fs = new FakeFs(new Map([
      ['OLD', { bytes: 8 * MB, dirMtimeMs: daysAgo(30) }],
    ]));
    const registry = new MemoryThreadRegistry();
    await seed(registry, 'OLD', 'stopped');
    const events = { publish: () => {} } as unknown as EventBus;
    const now = new Date();
    const gc = new WorkspaceGC({ root: ROOT, registry, locks: makeLocks(), log, events, fs, now: () => now }, 5); // cap 5 MB

    const before = await gc.usage();
    expect(before.totalBytes).toBe(8 * MB);
    expect(fs.listDirsCalls).toBe(1);

    const reclaimed = await gc.collect(); // collect() does its own walk, independent of the cache
    expect(reclaimed).toBe(8 * MB);
    expect(fs.listDirsCalls).toBe(2);

    // Same instant, well inside the TTL: a cache that survived the eviction would still
    // report the pre-deletion total, showing the console stale numbers right after a delete.
    const after = await gc.usage();
    expect(after.totalBytes).toBe(0);
    expect(fs.listDirsCalls).toBe(3);
  });
});

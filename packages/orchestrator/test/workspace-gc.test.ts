import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { MemoryThreadRegistry } from '../src/registry/memory-thread-registry.js';
import { WorkspaceGC, type WorkspaceFs } from '../src/lifecycle/workspace-gc.js';
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

async function seedRunning(registry: MemoryThreadRegistry, threadKey: string) {
  await registry.upsertActivity({
    threadKey, teamId: 'T1', channelId: 'C1', threadTs: '1.1',
    runtime: 'docker', workspacePath: `/w/${threadKey}`,
  });
  await registry.setStatus(threadKey, 'running', { containerId: 'c', containerName: threadKey });
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
    const gc = new WorkspaceGC({ root: ROOT, registry, log, events, fs }, 10);

    expect(await gc.collect()).toBe(0);
    expect(fs.removed).toEqual([]);
  });

  it('evicts oldest first and stops as soon as it is under the cap', async () => {
    const fs = new FakeFs(new Map([
      ['OLDEST', { bytes: 6 * MB, dirMtimeMs: daysAgo(10) }],
      ['MIDDLE', { bytes: 3 * MB, dirMtimeMs: daysAgo(5) }],
      ['NEWEST', { bytes: 3 * MB, dirMtimeMs: daysAgo(1) }],
    ]));
    const registry = new MemoryThreadRegistry();
    const published: unknown[] = [];
    const events = { publish: (e: unknown) => published.push(e) } as unknown as EventBus;
    const gc = new WorkspaceGC({ root: ROOT, registry, log, events, fs }, 10); // cap 10 MB, total 12 MB

    const reclaimed = await gc.collect();

    expect(reclaimed).toBe(6 * MB);
    expect(fs.removed).toEqual(['OLDEST']);
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
    await seedRunning(registry, 'RUNNING');
    const events = { publish: () => {} } as unknown as EventBus;
    const gc = new WorkspaceGC({ root: ROOT, registry, log, events, fs }, 10); // cap 10 MB, total 13 MB

    const reclaimed = await gc.collect();

    expect(reclaimed).toBe(5 * MB);
    expect(fs.removed).toEqual(['IDLE']);
    expect(fs.removed).not.toContain('RUNNING');
  });

  it('warns and returns partial bytes when only protected directories remain over cap', async () => {
    const fs = new FakeFs(new Map([
      ['IDLE', { bytes: 2 * MB, dirMtimeMs: daysAgo(9) }], // oldest, unprotected
      ['RUN1', { bytes: 3 * MB, dirMtimeMs: daysAgo(20) }],
      ['RUN2', { bytes: 3 * MB, dirMtimeMs: daysAgo(15) }],
    ]));
    const registry = new MemoryThreadRegistry();
    await seedRunning(registry, 'RUN1');
    await seedRunning(registry, 'RUN2');
    const warnSpy: unknown[][] = [];
    const testLog = { ...log, warn: (...args: unknown[]) => warnSpy.push(args) } as unknown as typeof log;
    const events = { publish: () => {} } as unknown as EventBus;
    const gc = new WorkspaceGC({ root: ROOT, registry: registry, log: testLog, events, fs }, 5); // cap 5 MB, total 8 MB

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
    const gc = new WorkspaceGC({ root: ROOT, registry, log, events, fs }, 0);

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
    const gc = new WorkspaceGC({ root: ROOT, registry, log, events, fs }, 10);

    const usage = await gc.usage();

    expect(usage.totalBytes).toBe(3 * MB);
    expect(usage.capBytes).toBe(10 * MB);
    expect(usage.count).toBe(2);
    expect(usage.oldestTouchedAt).toBe(new Date(yMtimeMs).toISOString()); // Y, not X
  });

  it('usage() reports zero and null oldest when there are no workspaces', async () => {
    const fs = new FakeFs(new Map());
    const registry = new MemoryThreadRegistry();
    const gc = new WorkspaceGC({ root: ROOT, registry, log, fs }, 10);

    const usage = await gc.usage();

    expect(usage).toEqual({ totalBytes: 0, capBytes: 10 * MB, count: 0, oldestTouchedAt: null });
  });
});

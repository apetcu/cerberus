import { readdir, rm, stat as fsStat } from 'node:fs/promises';
import type { WorkspaceUsage } from '@cerberus/protocol';
import type { Logger } from '../observability/logger.js';
import type { ThreadRegistry } from '../registry/thread-registry.js';
import type { EventBus } from '../api/events.js';

/**
 * The narrow filesystem surface WorkspaceGC needs. Kept small on purpose: every method
 * here is exactly one operation a garbage collector performs, nothing more, so tests can
 * fake the whole thing in memory with no real disk access.
 */
export interface WorkspaceFs {
  /** Names of the immediate subdirectories under root. Missing root yields an empty list. */
  listDirs(root: string): Promise<string[]>;
  /** mtimeMs of path, or null when it does not exist. */
  stat(path: string): Promise<{ mtimeMs: number } | null>;
  /** Total bytes of every file under path, recursively. A missing path counts as zero. */
  sizeOf(path: string): Promise<number>;
  /** Recursively removes path. Tolerates a path that is already gone. */
  remove(path: string): Promise<void>;
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

async function recursiveSize(path: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (err) {
    if (isEnoent(err)) return 0;
    throw err;
  }
  let total = 0;
  for (const entry of entries) {
    const full = `${path}/${entry.name}`;
    if (entry.isDirectory()) {
      total += await recursiveSize(full);
    } else if (entry.isFile()) {
      try {
        const s = await fsStat(full);
        total += s.size;
      } catch (err) {
        if (!isEnoent(err)) throw err;
      }
    }
  }
  return total;
}

/** Thin adapter over node:fs/promises. Real disk I/O; never used by unit tests. */
export const nodeWorkspaceFs: WorkspaceFs = {
  async listDirs(root) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (err) {
      if (isEnoent(err)) return [];
      throw err;
    }
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  },
  async stat(path) {
    try {
      const s = await fsStat(path);
      return { mtimeMs: s.mtimeMs };
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  },
  sizeOf: recursiveSize,
  async remove(path) {
    await rm(path, { recursive: true, force: true });
  },
};

export interface WorkspaceGCDeps {
  root: string;
  registry: ThreadRegistry;
  log: Logger;
  events?: EventBus;
  /** Injected for tests; defaults to node:fs/promises. */
  fs?: WorkspaceFs;
}

interface WorkspaceEntry {
  /** Directory name, which is exactly the thread key (see WORKSPACES_ROOT layout). */
  name: string;
  path: string;
  bytes: number;
  lastTouchedAt: Date;
}

function joinPath(root: string, name: string): string {
  return root.endsWith('/') ? `${root}${name}` : `${root}/${name}`;
}

/**
 * Bounds total workspace disk by evicting the least recently touched workspace directories
 * once a cap is exceeded. A workspace whose thread has a running container is never
 * evicted: deleting the directory out from under a live agent would corrupt the
 * conversation it is mid-way through writing. If honoring that means the cap cannot be
 * met, collect() logs a warning naming the shortfall and stops. It never deletes a
 * protected workspace to satisfy a number.
 */
export class WorkspaceGC {
  private readonly fs: WorkspaceFs;

  constructor(private readonly deps: WorkspaceGCDeps, private readonly maxMb: number) {
    this.fs = deps.fs ?? nodeWorkspaceFs;
  }

  private get capBytes(): number {
    return this.maxMb * 1024 * 1024;
  }

  private async listEntries(): Promise<WorkspaceEntry[]> {
    const { root } = this.deps;
    const names = await this.fs.listDirs(root);
    const entries: WorkspaceEntry[] = [];
    for (const name of names) {
      const path = joinPath(root, name);
      const bytes = await this.fs.sizeOf(path);
      const conversationStat = await this.fs.stat(joinPath(path, 'conversation.json'));
      const dirStat = conversationStat ?? (await this.fs.stat(path));
      // Both stats missing means the directory vanished between listing and sizing.
      // Treat it as the oldest possible so it sorts first for eviction rather than erroring.
      const lastTouchedAt = dirStat ? new Date(dirStat.mtimeMs) : new Date(0);
      entries.push({ name, path, bytes, lastTouchedAt });
    }
    return entries;
  }

  /** Reports current usage: total bytes, the configured cap, workspace count, and the oldest touch time. */
  async usage(): Promise<WorkspaceUsage> {
    const entries = await this.listEntries();
    const totalBytes = entries.reduce((sum, e) => sum + e.bytes, 0);
    const count = entries.length;
    const oldestTouchedAt = entries.length === 0
      ? null
      : entries
        .reduce((oldest, e) => (e.lastTouchedAt < oldest ? e.lastTouchedAt : oldest), entries[0]!.lastTouchedAt)
        .toISOString();
    return { totalBytes, capBytes: this.capBytes, count, oldestTouchedAt };
  }

  /** Evicts least recently touched, unprotected workspaces until under the cap. Returns bytes reclaimed. */
  async collect(): Promise<number> {
    const { registry, log } = this.deps;
    if (this.maxMb === 0) return 0;

    const capBytes = this.capBytes;
    const entries = await this.listEntries();
    let total = entries.reduce((sum, e) => sum + e.bytes, 0);
    if (total <= capBytes) return 0;

    const running = await registry.listByStatus('running');
    const protectedNames = new Set(running.map((r) => r.threadKey));

    const candidates = entries
      .filter((e) => !protectedNames.has(e.name))
      .sort((a, b) => a.lastTouchedAt.getTime() - b.lastTouchedAt.getTime());

    let reclaimed = 0;
    for (const entry of candidates) {
      if (total <= capBytes) break;
      await this.fs.remove(entry.path);
      total -= entry.bytes;
      reclaimed += entry.bytes;
      this.deps.events?.publish({
        kind: 'workspace_evicted',
        threadKey: entry.name,
        at: new Date().toISOString(),
        bytes: entry.bytes,
      });
    }

    if (total > capBytes) {
      const shortfallBytes = total - capBytes;
      log.warn(
        { shortfallBytes, root: this.deps.root },
        'workspace GC could not reach the cap: every remaining workspace over the limit belongs to a running agent',
      );
    }

    return reclaimed;
  }
}

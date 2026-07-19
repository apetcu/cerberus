import { readdir, rm, stat as fsStat } from 'node:fs/promises';
import type { WorkspaceUsage } from '@cerberus/protocol';
import type { ThreadStatus } from '../domain/thread.js';
import type { Logger } from '../observability/logger.js';
import type { ThreadRegistry } from '../registry/thread-registry.js';
import type { EventBus } from '../api/events.js';
import type { ThreadLocks } from './supervisor.js';

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
  /** The supervisor's own per-thread mutex, so eviction and spawn cannot interleave. */
  locks: ThreadLocks;
  log: Logger;
  events?: EventBus;
  /** Injected for tests; defaults to node:fs/promises. */
  fs?: WorkspaceFs;
  /** Injected for tests; defaults to the system clock. */
  now?: () => Date;
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
 * The only statuses whose workspaces may be deleted. An allowlist on purpose:
 * 'provisioning' is the supervisor mid-spawn, 'stopping' is the reaper's graceful-stop
 * window in which the agent has up to 30 more seconds and is still flushing
 * conversation.json, and a status added later is protected until someone decides
 * otherwise. Denying by default fails safe; a denylist of "running" did not.
 */
const EVICTABLE_STATUSES: ReadonlySet<ThreadStatus> = new Set(['stopped', 'failed']);

/**
 * Bounds total workspace disk by evicting the least recently touched workspace directories
 * once a cap is exceeded. Only workspaces whose thread status is in EVICTABLE_STATUSES may
 * be deleted: deleting the directory out from under a live agent would corrupt the
 * conversation it is mid-way through writing. Because the sweeper turns stopped threads
 * back into running ones on its own schedule, each delete re-reads that thread's status
 * under the supervisor's per-thread lock immediately before removing anything, so an
 * eviction can never interleave with a spawn on the same thread key. A directory with no
 * registry row at all is orphan data (every spawn path creates the row first and rows are
 * never deleted, and the boot reconciler re-adopts any live container into the registry):
 * it is evicted to keep the cap enforceable, but logged rather than published, because a
 * workspace_evicted event would surface the directory name as a pseudo-thread in the
 * Activity feed. If honoring the protections means the cap cannot be met, collect() logs
 * a warning naming the shortfall and stops. It never deletes a protected workspace to
 * satisfy a number.
 */
export class WorkspaceGC {
  /**
   * How long a `usage()` snapshot is served from cache before the workspace tree is walked
   * again. SystemView polls `/api/system` every 5 seconds, and each poll previously drove a
   * full recursive readdir and stat of everything under `WORKSPACES_ROOT`: a constant I/O
   * tax competing with the agents for the same disk, for every open console. 30 seconds is
   * long enough to cut that tax by roughly 6x for the common case of one open console
   * polling continuously, while staying short enough that disk pressure shown in the
   * console is never stale by more than half a minute, well inside the timescale an operator
   * reacts on.
   */
  private static readonly USAGE_CACHE_TTL_MS = 30_000;

  private readonly fs: WorkspaceFs;
  private readonly now: () => Date;
  private cachedUsage: WorkspaceUsage | null = null;
  private cachedAtMs = 0;

  constructor(private readonly deps: WorkspaceGCDeps, private readonly maxMb: number) {
    this.fs = deps.fs ?? nodeWorkspaceFs;
    this.now = deps.now ?? (() => new Date());
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

  /**
   * Reports current usage: total bytes, the configured cap, workspace count, and the oldest
   * touch time. Served from cache within `USAGE_CACHE_TTL_MS` of the last real walk rather
   * than re-reading the filesystem on every call; see that constant for why.
   */
  async usage(): Promise<WorkspaceUsage> {
    const nowMs = this.now().getTime();
    if (this.cachedUsage && nowMs - this.cachedAtMs < WorkspaceGC.USAGE_CACHE_TTL_MS) {
      return this.cachedUsage;
    }

    const entries = await this.listEntries();
    const totalBytes = entries.reduce((sum, e) => sum + e.bytes, 0);
    const count = entries.length;
    const oldestTouchedAt = entries.length === 0
      ? null
      : entries
        .reduce((oldest, e) => (e.lastTouchedAt < oldest ? e.lastTouchedAt : oldest), entries[0]!.lastTouchedAt)
        .toISOString();
    const usage: WorkspaceUsage = { totalBytes, capBytes: this.capBytes, count, oldestTouchedAt };
    this.cachedUsage = usage;
    this.cachedAtMs = nowMs;
    return usage;
  }

  /** True when this directory may be deleted right now: orphan, or an evictable status. */
  private async isEvictable(name: string): Promise<boolean> {
    const rec = await this.deps.registry.get(name);
    return rec === null || EVICTABLE_STATUSES.has(rec.status);
  }

  /**
   * Rechecks and deletes one workspace under the supervisor's per-thread lock. The status
   * snapshot taken while sorting candidates goes stale as deletes of large directories
   * take real time and the sweeper revives threads on its own schedule, so the decision
   * that matters is made here, immediately before the delete, where no spawn for the same
   * thread key can interleave.
   */
  private async evictLocked(entry: WorkspaceEntry): Promise<'skipped' | 'thread' | 'orphan'> {
    return this.deps.locks.withThreadLock(entry.name, async () => {
      const rec = await this.deps.registry.get(entry.name);
      if (rec !== null && !EVICTABLE_STATUSES.has(rec.status)) return 'skipped';
      await this.fs.remove(entry.path);
      return rec === null ? 'orphan' : 'thread';
    });
  }

  /** Evicts least recently touched, evictable workspaces until under the cap. Returns bytes reclaimed. */
  async collect(): Promise<number> {
    const { log } = this.deps;
    if (this.maxMb === 0) return 0;

    const capBytes = this.capBytes;
    const entries = await this.listEntries();
    let total = entries.reduce((sum, e) => sum + e.bytes, 0);
    if (total <= capBytes) return 0;

    const candidates: WorkspaceEntry[] = [];
    for (const entry of entries) {
      if (await this.isEvictable(entry.name)) candidates.push(entry);
    }
    candidates.sort((a, b) => a.lastTouchedAt.getTime() - b.lastTouchedAt.getTime());

    let reclaimed = 0;
    for (const entry of candidates) {
      if (total <= capBytes) break;
      const outcome = await this.evictLocked(entry);
      if (outcome === 'skipped') continue;
      total -= entry.bytes;
      reclaimed += entry.bytes;
      if (outcome === 'thread') {
        this.deps.events?.publish({
          kind: 'workspace_evicted',
          threadKey: entry.name,
          at: new Date().toISOString(),
          bytes: entry.bytes,
        });
      } else {
        // No registry row: not a thread, so no Activity event. Logged so the deletion is
        // still visible to an operator instead of a directory silently vanishing.
        log.warn(
          { directory: entry.name, bytes: entry.bytes, root: this.deps.root },
          'workspace GC evicted a directory with no registry row',
        );
      }
    }

    if (total > capBytes) {
      const shortfallBytes = total - capBytes;
      log.warn(
        { shortfallBytes, root: this.deps.root },
        'workspace GC could not reach the cap: every remaining workspace over the limit belongs to a thread that is not evictable',
      );
    }

    // A cached usage() snapshot taken before this run would understate disk freed by every
    // delete above; drop it so the very next usage() call re-walks the tree instead of
    // showing the console stale numbers right after a deletion.
    if (reclaimed > 0) this.cachedUsage = null;

    return reclaimed;
  }
}

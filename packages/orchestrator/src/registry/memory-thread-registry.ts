import type { ThreadRecord, ThreadStatus } from '../domain/thread.js';
import type { ThreadRegistry, UpsertParams } from './thread-registry.js';

export class MemoryThreadRegistry implements ThreadRegistry {
  private readonly rows = new Map<string, ThreadRecord>();

  async upsertActivity(p: UpsertParams): Promise<ThreadRecord> {
    const now = new Date();
    const existing = this.rows.get(p.threadKey);
    if (existing) {
      existing.lastActivityAt = now;
      existing.updatedAt = now;
      return { ...existing };
    }
    const rec: ThreadRecord = {
      ...p,
      status: 'provisioning',
      containerId: null,
      containerName: null,
      failureCount: 0,
      createdAt: now,
      lastActivityAt: now,
      updatedAt: now,
    };
    this.rows.set(p.threadKey, rec);
    return { ...rec };
  }

  async get(threadKey: string): Promise<ThreadRecord | null> {
    const rec = this.rows.get(threadKey);
    return rec ? { ...rec } : null;
  }

  async setStatus(
    threadKey: string,
    status: ThreadStatus,
    ids?: { containerId?: string | null; containerName?: string | null },
  ): Promise<void> {
    const rec = this.rows.get(threadKey);
    if (!rec) return;
    rec.status = status;
    rec.updatedAt = new Date();
    if (ids !== undefined) {
      rec.containerId = ids.containerId ?? null;
      rec.containerName = ids.containerName ?? null;
    }
  }

  async recordFailure(threadKey: string): Promise<number> {
    const rec = this.rows.get(threadKey);
    if (!rec) return 0;
    rec.failureCount += 1;
    rec.updatedAt = new Date();
    return rec.failureCount;
  }

  async countByStatus(status: ThreadStatus): Promise<number> {
    return [...this.rows.values()].filter((r) => r.status === status).length;
  }

  async listByStatus(status: ThreadStatus): Promise<ThreadRecord[]> {
    return [...this.rows.values()].filter((r) => r.status === status).map((r) => ({ ...r }));
  }

  async listRunningIdleSince(cutoff: Date): Promise<ThreadRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.status === 'running' && r.lastActivityAt < cutoff)
      .map((r) => ({ ...r }));
  }

  async listRecent(limit: number): Promise<ThreadRecord[]> {
    return [...this.rows.values()]
      .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime())
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
}

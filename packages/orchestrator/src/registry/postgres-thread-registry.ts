import type { Pool } from 'pg';
import type { ThreadRecord, ThreadStatus } from '../domain/thread.js';
import type { ThreadRegistry, UpsertParams } from './thread-registry.js';

interface Row {
  thread_key: string; team_id: string; channel_id: string; thread_ts: string;
  status: ThreadStatus; runtime: 'docker' | 'k8s';
  container_id: string | null; container_name: string | null;
  workspace_path: string; failure_count: number;
  created_at: Date; last_activity_at: Date; updated_at: Date;
}

function toRecord(r: Row): ThreadRecord {
  return {
    threadKey: r.thread_key, teamId: r.team_id, channelId: r.channel_id, threadTs: r.thread_ts,
    status: r.status, runtime: r.runtime,
    containerId: r.container_id, containerName: r.container_name,
    workspacePath: r.workspace_path, failureCount: r.failure_count,
    createdAt: r.created_at, lastActivityAt: r.last_activity_at, updatedAt: r.updated_at,
  };
}

export class PostgresThreadRegistry implements ThreadRegistry {
  constructor(private readonly pool: Pool) {}

  async upsertActivity(p: UpsertParams): Promise<ThreadRecord> {
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO threads (thread_key, team_id, channel_id, thread_ts, runtime, workspace_path)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (thread_key)
       DO UPDATE SET last_activity_at = now(), updated_at = now()
       RETURNING *`,
      [p.threadKey, p.teamId, p.channelId, p.threadTs, p.runtime, p.workspacePath],
    );
    return toRecord(rows[0]!);
  }

  async get(threadKey: string): Promise<ThreadRecord | null> {
    const { rows } = await this.pool.query<Row>('SELECT * FROM threads WHERE thread_key = $1', [threadKey]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async setStatus(
    threadKey: string,
    status: ThreadStatus,
    ids?: { containerId?: string | null; containerName?: string | null },
  ): Promise<void> {
    if (ids === undefined) {
      await this.pool.query(
        'UPDATE threads SET status = $2, updated_at = now() WHERE thread_key = $1',
        [threadKey, status],
      );
      return;
    }
    await this.pool.query(
      `UPDATE threads SET status = $2, container_id = $3, container_name = $4, updated_at = now()
       WHERE thread_key = $1`,
      [threadKey, status, ids.containerId ?? null, ids.containerName ?? null],
    );
  }

  async recordFailure(threadKey: string): Promise<number> {
    const { rows } = await this.pool.query<{ failure_count: number }>(
      `UPDATE threads SET failure_count = failure_count + 1, updated_at = now()
       WHERE thread_key = $1 RETURNING failure_count`,
      [threadKey],
    );
    return rows[0]?.failure_count ?? 0;
  }

  async countByStatus(status: ThreadStatus): Promise<number> {
    const { rows } = await this.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM threads WHERE status = $1', [status],
    );
    return rows[0]?.n ?? 0;
  }

  async listByStatus(status: ThreadStatus): Promise<ThreadRecord[]> {
    const { rows } = await this.pool.query<Row>('SELECT * FROM threads WHERE status = $1', [status]);
    return rows.map(toRecord);
  }

  async listRunningIdleSince(cutoff: Date): Promise<ThreadRecord[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM threads WHERE status = 'running' AND last_activity_at < $1`, [cutoff],
    );
    return rows.map(toRecord);
  }

  async listRecent(limit: number): Promise<ThreadRecord[]> {
    const { rows } = await this.pool.query<Row>(
      'SELECT * FROM threads ORDER BY last_activity_at DESC, thread_key ASC LIMIT $1', [limit],
    );
    return rows.map(toRecord);
  }
}

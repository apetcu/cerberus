import type { ThreadRecord, ThreadStatus } from '../domain/thread.js';

export interface UpsertParams {
  threadKey: string;
  teamId: string;
  channelId: string;
  threadTs: string;
  runtime: 'docker' | 'k8s';
  workspacePath: string;
}

export interface ThreadRegistry {
  upsertActivity(p: UpsertParams): Promise<ThreadRecord>;
  get(threadKey: string): Promise<ThreadRecord | null>;
  setStatus(
    threadKey: string,
    status: ThreadStatus,
    ids?: { containerId?: string | null; containerName?: string | null },
  ): Promise<void>;
  recordFailure(threadKey: string): Promise<number>;
  countByStatus(status: ThreadStatus): Promise<number>;
  listByStatus(status: ThreadStatus): Promise<ThreadRecord[]>;
  listRunningIdleSince(cutoff: Date): Promise<ThreadRecord[]>;
  /** Most recently active threads first. */
  listRecent(limit: number): Promise<ThreadRecord[]>;
}

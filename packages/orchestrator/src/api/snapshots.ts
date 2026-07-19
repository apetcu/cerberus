import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import {
  capabilitiesSchema, heartbeatKey, mailboxKey,
  type AgentDetail, type AgentSummary, type ConversationEntry, type OverviewSnapshot,
} from '@cerberus/protocol';
import type { ThreadRecord } from '../domain/thread.js';
import type { StreamsClient } from '../mailbox/redis-stores.js';
import type { Logger } from '../observability/logger.js';
import type { CapabilitiesRepo } from '../registry/capabilities-repo.js';
import type { ThreadRegistry } from '../registry/thread-registry.js';
import type { AgentHandle, AgentRuntime } from '../runtime/agent-runtime.js';

export interface SnapshotDeps {
  registry: ThreadRegistry;
  runtime: AgentRuntime;
  capabilities: CapabilitiesRepo;
  redis: StreamsClient;
  runtimeName: 'docker' | 'k8s';
  workspacesRoot: string;
  log: Logger;
}

const MAX_AGENTS = 200;
const REDIS_TIMEOUT_MS = 3000;

/**
 * Bounds one dashboard read. The Redis client deliberately has no global commandTimeout
 * (that would kill the outbox consumer's blocking XREADGROUP), so a stalled connection is
 * contained here instead: the field degrades to its fallback rather than hanging the snapshot.
 */
function withTimeout<T>(promise: Promise<T>, fallback: T, ms = REDIS_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(fallback); },
    );
  });
}

export class SnapshotBuilder {
  constructor(private readonly deps: SnapshotDeps) {}

  async overview(): Promise<OverviewSnapshot> {
    const records = await withTimeout(this.deps.registry.listRecent(MAX_AGENTS), [] as ThreadRecord[], 5000);
    const { live, healthy } = await this.liveHandles();
    // allSettled, not all: one malformed record must not blank the whole fleet view.
    const settled = await Promise.allSettled(records.map((r) => this.summarize(r, live)));
    const agents = settled.flatMap((result, index) => {
      if (result.status === 'fulfilled') return [result.value];
      this.deps.log.warn(
        { err: result.reason, threadKey: records[index]?.threadKey },
        'skipping agent in overview snapshot',
      );
      return [];
    });

    const counts = {
      total: agents.length,
      running: agents.filter((a) => a.status === 'running').length,
      provisioning: agents.filter((a) => a.status === 'provisioning').length,
      stopping: agents.filter((a) => a.status === 'stopping').length,
      stopped: agents.filter((a) => a.status === 'stopped').length,
      failed: agents.filter((a) => a.status === 'failed').length,
    };

    return {
      generatedAt: new Date().toISOString(),
      runtime: this.deps.runtimeName,
      runtimeHealthy: healthy,
      counts,
      agents,
    };
  }

  async detail(threadKey: string): Promise<AgentDetail | null> {
    const record = await this.deps.registry.get(threadKey);
    if (!record) return null;
    const { live } = await this.liveHandles();
    const summary = await this.summarize(record, live);
    const [conversation, stored] = await Promise.all([
      this.readConversation(record.workspacePath),
      // A capabilities-store failure degrades to defaults rather than blanking the whole view.
      this.deps.capabilities.get(threadKey).catch((err) => {
        this.deps.log.warn({ err, threadKey }, 'capabilities lookup failed; using defaults');
        return null;
      }),
    ]);
    return {
      ...summary,
      containerId: record.containerId,
      runtime: record.runtime,
      workspacePath: record.workspacePath,
      conversation,
      capabilities: stored ?? capabilitiesSchema.parse({}),
    };
  }

  /** Live containers keyed by threadKey; `healthy` is false when the runtime is unreachable. */
  private async liveHandles(): Promise<{ live: Map<string, AgentHandle>; healthy: boolean }> {
    try {
      const handles = await withTimeout(this.deps.runtime.list(), null as AgentHandle[] | null, 5000);
      if (handles === null) {
        this.deps.log.warn('runtime list timed out while building snapshot');
        return { live: new Map(), healthy: false };
      }
      return {
        live: new Map(handles.filter((h) => h.running).map((h) => [h.threadKey, h])),
        healthy: true,
      };
    } catch (err) {
      this.deps.log.warn({ err }, 'runtime unreachable while building snapshot');
      return { live: new Map(), healthy: false };
    }
  }

  private async summarize(record: ThreadRecord, live: Map<string, AgentHandle>): Promise<AgentSummary> {
    const [mailboxDepth, heartbeat] = await Promise.all([
      withTimeout(this.deps.redis.xlen(mailboxKey(record.threadKey)), 0),
      withTimeout(this.deps.redis.exists(heartbeatKey(record.threadKey)), 0),
    ]);
    return {
      threadKey: record.threadKey,
      teamId: record.teamId,
      channelId: record.channelId,
      threadTs: record.threadTs,
      status: record.status,
      containerName: record.containerName,
      containerRunning: live.has(record.threadKey),
      heartbeatFresh: heartbeat > 0,
      mailboxDepth,
      failureCount: record.failureCount,
      createdAt: record.createdAt.toISOString(),
      lastActivityAt: record.lastActivityAt.toISOString(),
    };
  }

  private async readConversation(workspacePath: string): Promise<ConversationEntry[]> {
    const root = resolve(this.deps.workspacesRoot);
    const target = resolve(workspacePath);
    if (target !== root && !target.startsWith(root + sep)) {
      this.deps.log.warn({ workspacePath }, 'workspace path outside the configured root; refusing to read');
      return [];
    }
    try {
      const raw = await readFile(join(target, 'conversation.json'), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      // Defensive: a hand-edited or truncated file must not white-screen the console.
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (e): e is ConversationEntry =>
          typeof e === 'object' && e !== null &&
          typeof (e as ConversationEntry).id === 'string' &&
          typeof (e as ConversationEntry).text === 'string',
      );
    } catch {
      return [];
    }
  }
}

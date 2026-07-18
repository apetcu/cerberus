import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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

export class SnapshotBuilder {
  constructor(private readonly deps: SnapshotDeps) {}

  async overview(): Promise<OverviewSnapshot> {
    const records = await this.deps.registry.listRecent(MAX_AGENTS);
    const { live, healthy } = await this.liveHandles();
    const agents = await Promise.all(records.map((r) => this.summarize(r, live)));

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
      this.deps.capabilities.get(threadKey),
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
      const handles = await this.deps.runtime.list();
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
      this.deps.redis.xlen(mailboxKey(record.threadKey)).catch(() => 0),
      this.deps.redis.exists(heartbeatKey(record.threadKey)).catch(() => 0),
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
    try {
      const raw = await readFile(join(workspacePath, 'conversation.json'), 'utf8');
      return JSON.parse(raw) as ConversationEntry[];
    } catch {
      // No conversation yet, or the workspace is not mounted here — an empty history is correct.
      return [];
    }
  }
}

import { chown, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ThreadRecord } from '../domain/thread.js';
import type { Logger } from '../observability/logger.js';
import type { ThreadRegistry } from '../registry/thread-registry.js';
import type { AgentRuntime, AgentSpec, ResourceLimits } from '../runtime/agent-runtime.js';
import { KeyedMutex } from './keyed-mutex.js';

const AGENT_UID = 1000; // matches USER node in packages/agent/Dockerfile

export interface SupervisorConfig {
  runtime: 'docker' | 'k8s';
  agentImage: string;
  agentRedisUrl: string;
  logLevel: string;
  workspacesRoot: string;
  /** Path prefix as seen by the container runtime backend ('' = workspacesRoot). */
  workspacesHostRoot: string;
  maxConcurrentAgents: number;
  limits: ResourceLimits;
}

export type EnsureOutcome = 'already-running' | 'spawned' | 'deferred' | 'failed';

export interface EnsureParams {
  threadKey: string;
  teamId: string;
  channelId: string;
  threadTs: string;
}

export interface SupervisorDeps {
  registry: ThreadRegistry;
  runtime: AgentRuntime;
  log: Logger;
  ensureDir?: (path: string) => Promise<void>;
}

export class ThreadSupervisor {
  private readonly mutex = new KeyedMutex();
  private readonly ensureDir: (path: string) => Promise<void>;

  constructor(private readonly deps: SupervisorDeps, private readonly cfg: SupervisorConfig) {
    this.ensureDir = deps.ensureDir ?? (async (p) => {
      await mkdir(p, { recursive: true });
      // Agents run as uid 1000 with a read-only rootfs: the orchestrator (root inside
      // its container) must hand the workspace over or the agent cannot write to it.
      // Best-effort: no-op when the orchestrator itself isn't root (local dev).
      await chown(p, AGENT_UID, AGENT_UID).catch(() => {});
    });
  }

  async ensureRunning(p: EnsureParams): Promise<{ record: ThreadRecord; outcome: EnsureOutcome }> {
    return this.mutex.run(p.threadKey, () => this.ensureLocked(p));
  }

  private async ensureLocked(p: EnsureParams): Promise<{ record: ThreadRecord; outcome: EnsureOutcome }> {
    const { registry, runtime, log } = this.deps;
    const workspacePath = join(this.cfg.workspacesRoot, p.threadKey);
    let record = await registry.upsertActivity({
      ...p, runtime: this.cfg.runtime, workspacePath,
    });

    if (record.status === 'running' && record.containerName) {
      const live = await runtime.inspect(record.containerName);
      if (live?.running) return { record, outcome: 'already-running' };
    }

    if ((await registry.countByStatus('running')) >= this.cfg.maxConcurrentAgents) {
      return { record, outcome: 'deferred' };
    }

    await registry.setStatus(p.threadKey, 'provisioning');
    try {
      await this.ensureDir(workspacePath);
      const handle = await runtime.spawn(this.specFor(p.threadKey));
      await registry.setStatus(p.threadKey, 'running', {
        containerId: handle.id, containerName: handle.name,
      });
      record = (await registry.get(p.threadKey))!;
      log.info({ threadKey: p.threadKey, container: handle.name }, 'agent spawned');
      return { record, outcome: 'spawned' };
    } catch (err) {
      await registry.recordFailure(p.threadKey);
      await registry.setStatus(p.threadKey, 'failed');
      record = (await registry.get(p.threadKey))!;
      log.error({ err, threadKey: p.threadKey }, 'agent spawn failed');
      return { record, outcome: 'failed' };
    }
  }

  private specFor(threadKey: string): AgentSpec {
    const hostRoot = this.cfg.workspacesHostRoot || this.cfg.workspacesRoot;
    return {
      threadKey,
      image: this.cfg.agentImage,
      // K8sRuntime uses only the threadKey (subPath); DockerRuntime binds the full host path.
      workspaceHostPath: this.cfg.runtime === 'k8s' ? threadKey : join(hostRoot, threadKey),
      env: {
        THREAD_KEY: threadKey,
        REDIS_URL: this.cfg.agentRedisUrl,
        WORKSPACE_PATH: '/workspace',
        LOG_LEVEL: this.cfg.logLevel,
      },
      limits: this.cfg.limits,
    };
  }
}

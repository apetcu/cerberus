import { heartbeatKey } from '@cerberus/protocol';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import type { ThreadRegistry } from '../registry/thread-registry.js';
import type { AgentRuntime } from '../runtime/agent-runtime.js';
import type { EventBus } from '../api/events.js';

export type DeathCause = 'container_gone' | 'container_exited' | 'heartbeat_stale';

export interface LivenessDeps {
  registry: ThreadRegistry;
  runtime: AgentRuntime;
  redis: { exists(key: string): Promise<number> };
  log: Logger;
  events?: EventBus;
  metrics?: Metrics;
  now?: () => Date;
}

/**
 * Detects agents that crashed (container gone or exited) or wedged (container alive but the
 * agent stopped heartbeating). Never spawns: it only marks the row stopped and publishes
 * `agent_died`. Reviving the thread is the MailboxSweeper's job so that the decision to
 * respawn lives in exactly one place.
 */
export class LivenessMonitor {
  private readonly now: () => Date;

  constructor(private readonly deps: LivenessDeps, private readonly heartbeatGraceMs: number) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Correct every stale running row. Returns how many were found dead. */
  async tick(): Promise<number> {
    const { registry, runtime, redis, log } = this.deps;
    const nowMs = this.now().getTime();
    const running = await registry.listByStatus('running');
    let dead = 0;

    for (const rec of running) {
      if (nowMs - rec.updatedAt.getTime() < this.heartbeatGraceMs) {
        // Booting containers have not written their first heartbeat yet; not wedged.
        continue;
      }
      if (!rec.containerName) continue;

      let handle;
      try {
        handle = await runtime.inspect(rec.containerName);
      } catch (err) {
        // A transport error is not evidence the agent is dead: leave this row untouched
        // and move on to the next one.
        log.error({ err, threadKey: rec.threadKey }, 'liveness inspect failed');
        continue;
      }

      let cause: DeathCause | null = null;
      if (!handle) {
        cause = 'container_gone';
      } else if (!handle.running) {
        cause = 'container_exited';
      } else {
        const heartbeat = await redis.exists(heartbeatKey(rec.threadKey));
        if (heartbeat === 0) {
          cause = 'heartbeat_stale';
          try {
            await runtime.stop(handle, true);
          } catch (err) {
            log.error({ err, threadKey: rec.threadKey }, 'liveness stop of wedged container failed');
          }
        }
      }

      if (cause === null) continue;

      await registry.setStatus(rec.threadKey, 'stopped', { containerId: null, containerName: null });
      dead += 1;
      log.warn({ threadKey: rec.threadKey, cause }, 'agent died');
      this.deps.events?.publish({
        kind: 'agent_died', threadKey: rec.threadKey, at: new Date().toISOString(), cause,
      });
    }

    return dead;
  }
}

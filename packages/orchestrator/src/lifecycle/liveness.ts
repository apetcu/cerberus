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

interface Unhealthy {
  /** When this thread was first observed unhealthy, per `now()`. */
  since: number;
  cause: DeathCause;
}

/**
 * Detects agents that crashed (container gone or exited) or wedged (container alive but the
 * agent stopped heartbeating). Never spawns: it only marks the row stopped and publishes
 * `agent_died`. Reviving the thread is the MailboxSweeper's job so that the decision to
 * respawn lives in exactly one place.
 *
 * The grace period is time spent unhealthy, tracked here, not time since the row's
 * `updatedAt`. `updatedAt` is bumped by `registry.upsertActivity` on every inbound Slack
 * message, so a user who keeps messaging a crashed or wedged thread would keep that column
 * moving forever and the row would never leave an `updatedAt`-based grace window. Measuring
 * how long the monitor has observed the row unhealthy, instead, tolerates both the spawn race
 * (a brand new container has not written its first heartbeat yet) and transient flapping,
 * while still catching a thread that stays broken no matter how often it is messaged.
 */
export class LivenessMonitor {
  private readonly now: () => Date;
  private readonly unhealthySince = new Map<string, Unhealthy>();

  constructor(private readonly deps: LivenessDeps, private readonly heartbeatGraceMs: number) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Correct every stale running row. Returns how many were found dead. */
  async tick(): Promise<number> {
    const { registry, runtime, redis, log } = this.deps;
    const nowMs = this.now().getTime();
    const running = await registry.listByStatus('running');
    const runningKeys = new Set(running.map((rec) => rec.threadKey));
    let dead = 0;

    // A thread that no longer appears in the running list cannot be observed again under
    // its old entry; drop it so the map cannot grow without bound.
    for (const threadKey of this.unhealthySince.keys()) {
      if (!runningKeys.has(threadKey)) this.unhealthySince.delete(threadKey);
    }

    for (const rec of running) {
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
        if (heartbeat === 0) cause = 'heartbeat_stale';
      }

      if (cause === null) {
        // Healthy: a recovered agent resets its own clock.
        this.unhealthySince.delete(rec.threadKey);
        continue;
      }

      const existing = this.unhealthySince.get(rec.threadKey);
      if (!existing) {
        // First sighting is never enough: record it and wait for the grace period to elapse.
        this.unhealthySince.set(rec.threadKey, { since: nowMs, cause });
        continue;
      }

      // Keep the original `since` but update to the newest observation: degrading from a
      // stale heartbeat to a gone container is the same illness progressing, not a fresh one.
      existing.cause = cause;

      if (nowMs - existing.since < this.heartbeatGraceMs) continue;

      if (existing.cause === 'heartbeat_stale') {
        try {
          await runtime.stop(handle!, true);
        } catch (err) {
          log.error({ err, threadKey: rec.threadKey }, 'liveness stop of wedged container failed');
        }
      }

      await registry.setStatus(rec.threadKey, 'stopped', { containerId: null, containerName: null });
      dead += 1;
      log.warn({ threadKey: rec.threadKey, cause: existing.cause }, 'agent died');
      this.deps.events?.publish({
        kind: 'agent_died', threadKey: rec.threadKey, at: new Date().toISOString(), cause: existing.cause,
      });
      this.unhealthySince.delete(rec.threadKey);
    }

    return dead;
  }
}

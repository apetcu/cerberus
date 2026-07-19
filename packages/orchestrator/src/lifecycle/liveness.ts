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
  /** When this thread was first observed unhealthy under `containerId`, per `now()`. */
  since: number;
  cause: DeathCause;
  /**
   * The container identity this entry was recorded against. `containerName` is a
   * deterministic hash of the thread key (see `agentName`), so it stays identical across a
   * respawn and cannot tell a crashed container apart from the healthy one that replaced
   * it. `containerId` changes on every spawn, so a mismatch here means this is a different
   * container's life, not a continuation of the one the grace period started measuring.
   */
  containerId: string | null;
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
 *
 * That grace is scoped to one container's life by `containerId`. Without that scoping, a
 * thread that crashes, gets recorded unhealthy, and is then respawned before the grace
 * elapses would keep the original entry: the row reads `running` across ticks (the
 * `provisioning` interlude is far shorter than a tick), and the new agent does not write its
 * first heartbeat until its own boot delay has passed. A tick landing in that window would
 * read the old entry, see its grace already elapsed, and stop the new, healthy container.
 * Resetting the entry whenever the observed `containerId` changes makes every container earn
 * its own grace.
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
      // The whole per-row body is one try/catch: a throw from inspect or from redis.exists
      // is contained here so it costs this row's tick, not the rows after it. A transport
      // error is not evidence the agent is dead, so this row is simply left untouched.
      try {
        let handle: Awaited<ReturnType<AgentRuntime['inspect']>> = null;
        let cause: DeathCause | null = null;

        if (!rec.containerName) {
          // A running row with no container name can never be inspected, so it would
          // otherwise sit invisible, and still counting against the concurrency cap,
          // forever. There is demonstrably no container to find: treat it as unhealthy
          // immediately so the normal grace and revival path handles it.
          cause = 'container_gone';
        } else {
          handle = await runtime.inspect(rec.containerName);
          if (!handle) {
            cause = 'container_gone';
          } else if (!handle.running) {
            cause = 'container_exited';
          } else {
            const heartbeat = await redis.exists(heartbeatKey(rec.threadKey));
            if (heartbeat === 0) cause = 'heartbeat_stale';
          }
        }

        if (cause === null) {
          // Healthy: a recovered agent resets its own clock.
          this.unhealthySince.delete(rec.threadKey);
          continue;
        }

        const existing = this.unhealthySince.get(rec.threadKey);
        if (!existing || existing.containerId !== rec.containerId) {
          // First sighting, or a respawn under a new containerId: either way this is a
          // fresh life and must earn its own grace rather than inherit a `since` recorded
          // against whatever container held this thread key before it.
          this.unhealthySince.set(rec.threadKey, { since: nowMs, cause, containerId: rec.containerId });
          continue;
        }

        // Keep the original `since` but update to the newest observation: degrading from a
        // stale heartbeat to a gone container is the same illness progressing, not a fresh one.
        existing.cause = cause;

        if (nowMs - existing.since < this.heartbeatGraceMs) continue;

        if (handle && (existing.cause === 'heartbeat_stale' || existing.cause === 'container_exited')) {
          // heartbeat_stale: the wedged container must not linger holding resources.
          // container_exited: the container already stopped on its own but still holds its
          // writable layer until removed, otherwise it lingers until the thread happens to
          // respawn, or forever if it never does. Graceful only for heartbeat_stale, since
          // an exited container needs no stop signal, just removal.
          try {
            await runtime.stop(handle, existing.cause === 'heartbeat_stale');
          } catch (err) {
            log.error({ err, threadKey: rec.threadKey }, 'liveness stop of dead container failed');
          }
        }

        await registry.setStatus(rec.threadKey, 'stopped', { containerId: null, containerName: null });
        dead += 1;
        log.warn({ threadKey: rec.threadKey, cause: existing.cause }, 'agent died');
        this.deps.events?.publish({
          kind: 'agent_died', threadKey: rec.threadKey, at: new Date().toISOString(), cause: existing.cause,
        });
        this.unhealthySince.delete(rec.threadKey);
      } catch (err) {
        log.error({ err, threadKey: rec.threadKey }, 'liveness tick failed for row');
      }
    }

    return dead;
  }
}

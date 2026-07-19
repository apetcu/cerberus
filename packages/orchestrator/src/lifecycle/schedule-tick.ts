import type { Logger } from '../observability/logger.js';

/**
 * Schedules `tick` on `intervalMs`, catching and logging so a failing tick never becomes an
 * unhandled rejection. `intervalMs === 0` disables the loop entirely: no timer is created.
 * Every timer this creates is cleared when `signal` aborts.
 *
 * Guards against overlap: if the previous invocation of `tick` has not resolved by the time
 * the next interval fires, that firing is skipped rather than left to queue up behind the
 * in-flight one. Dockerode has no call timeout on the Docker socket, and a tick that includes
 * a graceful container stop can itself take up to 30 seconds, so without this guard a single
 * hung or slow tick lets later firings pile up and run concurrently. That matters most for
 * LivenessMonitor: its unhealthy map is mutable state that two overlapping ticks reading and
 * writing at once could double-act on, publishing duplicate `agent_died` events or letting a
 * stale `setStatus('stopped')` clobber a row the sweeper just revived. Used for every
 * interval-driven loop (reaper, liveness, sweeper, workspace GC) so the guarantee covers all
 * four at once rather than depending on each class remembering it independently.
 *
 * A skipped tick is logged at debug, not warn: an occasional skip under a slow disk or a
 * loaded Docker daemon is expected, but the log line still exists so a loop that skips
 * *persistently* is diagnosable.
 */
export function scheduleTick(
  intervalMs: number,
  signal: AbortSignal,
  log: Logger,
  label: string,
  tick: () => Promise<unknown>,
): void {
  if (intervalMs === 0) return;
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) {
      log.debug({ label }, `${label} tick skipped: previous tick still running`);
      return;
    }
    inFlight = true;
    void tick()
      .catch((err) => log.error({ err }, `${label} tick failed`))
      .finally(() => { inFlight = false; });
  }, intervalMs);
  signal.addEventListener('abort', () => clearInterval(timer), { once: true });
}

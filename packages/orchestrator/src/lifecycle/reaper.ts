import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import type { ThreadRegistry } from '../registry/thread-registry.js';
import type { AgentRuntime } from '../runtime/agent-runtime.js';

export interface ReaperDeps {
  registry: ThreadRegistry;
  runtime: AgentRuntime;
  producer: { publishControl(threadKey: string, control: 'shutdown' | 'ping'): Promise<void> };
  log: Logger;
  metrics?: Metrics;
  now?: () => Date;
}

export class IdleReaper {
  private readonly now: () => Date;

  constructor(private readonly deps: ReaperDeps, private readonly idleTimeoutMs: number) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Stop every running thread idle past the timeout. Returns number reaped. */
  async tick(): Promise<number> {
    const { registry, runtime, producer, log, metrics } = this.deps;
    const cutoff = new Date(this.now().getTime() - this.idleTimeoutMs);
    const idle = await registry.listRunningIdleSince(cutoff);
    for (const rec of idle) {
      try {
        await registry.setStatus(rec.threadKey, 'stopping');
        await producer.publishControl(rec.threadKey, 'shutdown');
        if (rec.containerName) {
          const handle = await runtime.inspect(rec.containerName);
          if (handle) await runtime.stop(handle, true);
        }
        await registry.setStatus(rec.threadKey, 'stopped', { containerId: null, containerName: null });
        metrics?.reapedTotal.inc();
        log.info({ threadKey: rec.threadKey }, 'idle agent reaped');
      } catch (err) {
        log.error({ err, threadKey: rec.threadKey }, 'reap failed');
      }
    }
    return idle.length;
  }

  start(intervalMs: number, signal: AbortSignal): void {
    const timer = setInterval(() => {
      void this.tick().catch((err) => this.deps.log.error({ err }, 'reaper tick failed'));
    }, intervalMs);
    signal.addEventListener('abort', () => clearInterval(timer), { once: true });
  }
}

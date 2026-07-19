import { mailboxKey } from '@cerberus/protocol';
import type { Logger } from '../observability/logger.js';
import type { ThreadRegistry } from '../registry/thread-registry.js';
import type { ThreadSupervisor } from './supervisor.js';
import type { EventBus } from '../api/events.js';
import type { DrainState } from './drain.js';

export interface SweeperDeps {
  registry: ThreadRegistry;
  mailbox: { xlen(key: string): Promise<number> };
  supervisor: Pick<ThreadSupervisor, 'ensureRunning'>;
  drain: DrainState;
  log: Logger;
  events?: EventBus;
}

/**
 * Revives every thread holding unread mail with no running agent. This is the one place
 * respawn happens, closing three separate paths back to life: the crashed agent the
 * LivenessMonitor just marked stopped, a spawn deferred at the concurrency cap, and a
 * thread stranded while the fleet was draining. Each previously waited on the user to
 * speak again before anything brought the agent back.
 */
export class MailboxSweeper {
  constructor(private readonly deps: SweeperDeps) {}

  /** Revive every thread holding mail with no agent. Returns how many were revived. */
  async sweep(): Promise<number> {
    const { registry, mailbox, supervisor, drain, log } = this.deps;
    if (drain.enabled) return 0;

    const candidates = [
      ...(await registry.listByStatus('stopped')),
      ...(await registry.listByStatus('failed')),
    ];
    let revived = 0;

    for (const rec of candidates) {
      try {
        const pending = await mailbox.xlen(mailboxKey(rec.threadKey));
        if (pending <= 0) continue;

        const { outcome } = await supervisor.ensureRunning({
          threadKey: rec.threadKey,
          teamId: rec.teamId,
          channelId: rec.channelId,
          threadTs: rec.threadTs,
        });
        if (outcome === 'spawned') revived += 1;
      } catch (err) {
        log.error({ err, threadKey: rec.threadKey }, 'sweep failed for thread');
      }
    }

    return revived;
  }
}

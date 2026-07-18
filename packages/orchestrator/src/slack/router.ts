import { ulid } from 'ulid';
import { buildThreadKey } from '@cerberus/protocol';
import type { ThreadSupervisor } from '../lifecycle/supervisor.js';
import type { SlackPoster } from '../mailbox/outbox-consumer.js';
import type { DedupStore, MailboxProducer } from '../mailbox/redis-stores.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';

export interface NormalizedSlackMessage {
  teamId: string;
  channelId: string;
  /** Root ts of the thread (= message ts for a top-level mention). */
  threadTs: string;
  ts: string;
  text: string;
  userId: string;
  userDisplay: string;
}

export interface SlackReactor {
  addReaction(channelId: string, ts: string, emoji: string): Promise<void>;
}

export interface RouterDeps {
  dedup: DedupStore;
  producer: Pick<MailboxProducer, 'publish'>;
  supervisor: Pick<ThreadSupervisor, 'ensureRunning'>;
  poster: SlackPoster;
  reactor: SlackReactor;
  log: Logger;
  metrics?: Metrics;
}

export class EventRouter {
  constructor(private readonly deps: RouterDeps) {}

  async handle(evt: NormalizedSlackMessage): Promise<'duplicate' | 'accepted'> {
    const { dedup, producer, supervisor, poster, reactor, log, metrics } = this.deps;
    // Message identity, not Slack event_id: collapses app_mention+message double delivery and retries.
    if (!(await dedup.markSeen(`${evt.channelId}:${evt.ts}`))) return 'duplicate';

    // Instant "seen" ack; fire-and-forget so a failure (e.g. missing reactions:write scope)
    // never delays or breaks routing.
    void reactor.addReaction(evt.channelId, evt.ts, 'eyes').catch((err) => {
      log.warn({ err, channel: evt.channelId, ts: evt.ts }, 'failed to add seen reaction');
    });

    const threadKey = buildThreadKey({ teamId: evt.teamId, channelId: evt.channelId, threadTs: evt.threadTs });
    metrics?.messagesInbound.inc();

    // Mailbox-first: the message is durable before any container work happens.
    await producer.publish({
      id: ulid(), threadKey, kind: 'user_message', text: evt.text,
      user: { id: evt.userId, display: evt.userDisplay }, ts: evt.ts,
    });

    const { outcome } = await supervisor.ensureRunning({
      threadKey, teamId: evt.teamId, channelId: evt.channelId, threadTs: evt.threadTs,
    });
    metrics?.spawnsTotal.inc({ outcome });
    log.info({ threadKey, outcome }, 'inbound message routed');

    if (outcome === 'failed') {
      await poster.postToThread(threadKey, ':warning: Could not start your agent — I will retry on your next message.');
    } else if (outcome === 'deferred') {
      await poster.postToThread(threadKey, ':hourglass: All agent slots are busy — your message is queued and will be processed shortly.');
    }
    return 'accepted';
  }
}

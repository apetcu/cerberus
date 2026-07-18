import bolt from '@slack/bolt';
import { buildThreadKey, parseThreadKey } from '@cerberus/protocol';
import type { SlackPoster } from '../mailbox/outbox-consumer.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import type { ThreadRegistry } from '../registry/thread-registry.js';
import type { EventRouter } from './router.js';

export interface RouterRef {
  current: Pick<EventRouter, 'handle'> | null;
}

interface SlackMessageEvent {
  channel: string; ts: string; thread_ts?: string; text?: string;
  user?: string; bot_id?: string; subtype?: string;
}

export class SlackGateway implements SlackPoster {
  private readonly app: bolt.App;

  constructor(
    cfg: { botToken: string; appToken: string },
    private readonly registry: ThreadRegistry,
    private readonly routerRef: RouterRef,
    private readonly log: Logger,
    private readonly metrics?: Metrics,
  ) {
    this.app = new bolt.App({
      token: cfg.botToken,
      appToken: cfg.appToken,
      socketMode: true,
      logLevel: bolt.LogLevel.WARN,
    });

    this.app.event('app_mention', async ({ event, body }) => {
      const e = event as unknown as SlackMessageEvent;
      await this.dispatch((body as { team_id?: string }).team_id ?? '', e);
    });

    // Thread replies (no mention needed) — only for threads we already own.
    this.app.event('message', async ({ event, body }) => {
      const e = event as unknown as SlackMessageEvent;
      if (e.subtype || e.bot_id || !e.thread_ts || !e.user) return;
      try {
        const teamId = (body as { team_id?: string }).team_id ?? '';
        const threadKey = buildThreadKey({ teamId, channelId: e.channel, threadTs: e.thread_ts });
        if (!(await this.registry.get(threadKey))) return;
        await this.dispatch(teamId, e);
      } catch (err) {
        this.log.error({ err, channel: e.channel, ts: e.ts }, 'message event handling failed');
      }
    });
  }

  private async dispatch(teamId: string, e: SlackMessageEvent): Promise<void> {
    if (!this.routerRef.current) return;
    try {
      await this.routerRef.current.handle({
        teamId,
        channelId: e.channel,
        threadTs: e.thread_ts ?? e.ts,
        ts: e.ts,
        text: e.text ?? '',
        userId: e.user ?? '',
        userDisplay: e.user ?? '',
      });
    } catch (err) {
      this.log.error({ err, channel: e.channel, ts: e.ts }, 'event dispatch failed');
    }
  }

  async postToThread(threadKey: string, text: string): Promise<void> {
    const { channelId, threadTs } = parseThreadKey(threadKey);
    try {
      await this.app.client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text });
      this.metrics?.messagesOutbound.inc();
    } catch (err) {
      this.metrics?.slackErrors.inc();
      throw err;
    }
  }

  async start(): Promise<void> { await this.app.start(); }
  async stop(): Promise<void> { await this.app.stop(); }
}

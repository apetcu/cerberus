import { ulid } from 'ulid';
import {
  decodeInbound, dedupKey, deliveryGuardKey, encodePayload, MAILBOX_GROUP, mailboxKey,
  type AgentInbound,
} from '@cerberus/protocol';

export interface StreamsClient {
  xgroup(...args: (string | number)[]): Promise<unknown>;
  xreadgroup(...args: (string | number)[]): Promise<unknown>;
  xadd(...args: (string | number)[]): Promise<unknown>;
  xack(key: string, group: string, id: string): Promise<unknown>;
  xautoclaim(...args: (string | number)[]): Promise<unknown>;
  xinfo(...args: (string | number)[]): Promise<unknown>;
  xrange(...args: (string | number)[]): Promise<unknown>;
  xpending(...args: (string | number)[]): Promise<unknown>;
  set(...args: (string | number)[]): Promise<unknown>;
  del(key: string): Promise<unknown>;
  xlen(key: string): Promise<number>;
  exists(key: string): Promise<number>;
}

const DEDUP_TTL_S = 86_400;

export class MailboxProducer {
  constructor(private readonly redis: StreamsClient) {}

  async publish(msg: AgentInbound): Promise<void> {
    await this.redis.xadd(mailboxKey(msg.threadKey), 'MAXLEN', '~', 1000, '*', ...encodePayload(msg));
  }

  async publishControl(threadKey: string, control: 'shutdown' | 'ping'): Promise<void> {
    await this.publish({ id: ulid(), threadKey, kind: 'control', control, ts: `${Date.now()}` });
  }
}

const BATCH = 100;

type RangeEntry = [id: string, fields: string[]];

function isUserMessage(fields: string[]): boolean {
  try {
    return decodeInbound(fields).kind === 'user_message';
  } catch {
    // Malformed entries are acked and dropped by the agent, never processed; an
    // undelivered one is not a reason to bring an agent back to life.
    return false;
  }
}

/**
 * Answers "does this thread's mailbox hold genuine unprocessed user work?" from consumer
 * group state. XLEN cannot answer that: the stream retains every entry after the agent
 * consumes and acks it (the only trim is MAXLEN ~ 1000 on XADD), so XLEN counts history
 * and is nonzero forever after the first message. Work means a user message the agent
 * group has never been delivered, or one delivered but never acked (the agent crashed
 * mid-turn and must retry it on next boot). Control envelopes (shutdown, ping) never
 * count: the reaper leaves its shutdown control unconsumed whenever the container went
 * down before reading it, and treating that leftover as work would revive the exact
 * thread the reaper just stopped.
 *
 * Uses only XINFO GROUPS (name, pending, last-delivered-id), XRANGE with exclusive
 * ranges, and XPENDING, all available on the redis:7-alpine both deploy targets pin
 * (exclusive ranges need 6.2, which XAUTOCLAIM elsewhere in this file already requires).
 */
export class MailboxBacklog {
  constructor(private readonly redis: StreamsClient) {}

  async hasUserWork(threadKey: string): Promise<boolean> {
    const key = mailboxKey(threadKey);
    const group = await this.groupState(key);
    if (group === 'no-stream') return false;
    if (group === 'no-group') {
      // The stream exists but no agent ever created the group (spawn failed before the
      // agent booted): nothing has been delivered, so every user message is work.
      return this.rangeHasUserMessage(key, '-');
    }
    if (await this.rangeHasUserMessage(key, `(${group.lastDeliveredId}`)) return true;
    return group.pending > 0 && this.pendingHasUserMessage(key);
  }

  private async groupState(
    key: string,
  ): Promise<'no-stream' | 'no-group' | { lastDeliveredId: string; pending: number }> {
    let reply: unknown;
    try {
      reply = await this.redis.xinfo('GROUPS', key);
    } catch (err) {
      if (String(err).includes('no such key')) return 'no-stream';
      throw err;
    }
    for (const flat of reply as (string | number | null)[][]) {
      const fields = new Map<string, string | number | null>();
      for (let i = 0; i + 1 < flat.length; i += 2) fields.set(String(flat[i]), flat[i + 1] ?? null);
      if (fields.get('name') === MAILBOX_GROUP) {
        return {
          lastDeliveredId: String(fields.get('last-delivered-id') ?? '0-0'),
          pending: Number(fields.get('pending') ?? 0),
        };
      }
    }
    return 'no-group';
  }

  /** True when any entry in [from, +] is a user message. `(id` makes `from` exclusive. */
  private async rangeHasUserMessage(key: string, from: string): Promise<boolean> {
    let start = from;
    for (;;) {
      const batch = (await this.redis.xrange(key, start, '+', 'COUNT', BATCH)) as RangeEntry[];
      if (batch.length === 0) return false;
      if (batch.some(([, fields]) => isUserMessage(fields))) return true;
      start = `(${batch[batch.length - 1]![0]}`;
    }
  }

  /** True when any delivered-but-unacked entry still in the stream is a user message. */
  private async pendingHasUserMessage(key: string): Promise<boolean> {
    let start = '-';
    for (;;) {
      const batch = (await this.redis.xpending(key, MAILBOX_GROUP, start, '+', BATCH)) as
        [id: string, consumer: string, idleMs: number, deliveries: number][];
      if (!batch || batch.length === 0) return false;
      for (const [id] of batch) {
        const entries = (await this.redis.xrange(key, id, id)) as RangeEntry[];
        const fields = entries[0]?.[1];
        if (fields && isUserMessage(fields)) return true;
      }
      start = `(${batch[batch.length - 1]![0]}`;
    }
  }
}

export interface DedupStore {
  /** true if this id was never seen before (and is now recorded). */
  markSeen(id: string): Promise<boolean>;
}

export class RedisDedupStore implements DedupStore {
  constructor(private readonly redis: StreamsClient) {}
  async markSeen(id: string): Promise<boolean> {
    return (await this.redis.set(dedupKey(id), '1', 'EX', DEDUP_TTL_S, 'NX')) === 'OK';
  }
}

export interface DeliveryGuard {
  /** true if the caller now owns delivery of this outbound id. */
  claim(outboundId: string): Promise<boolean>;
  /** Undo a claim so a retry can post. */
  release(outboundId: string): Promise<void>;
}

export class RedisDeliveryGuard implements DeliveryGuard {
  constructor(private readonly redis: StreamsClient) {}
  async claim(outboundId: string): Promise<boolean> {
    return (await this.redis.set(deliveryGuardKey(outboundId), '1', 'EX', DEDUP_TTL_S, 'NX')) === 'OK';
  }

  async release(outboundId: string): Promise<void> {
    await this.redis.del(deliveryGuardKey(outboundId));
  }
}

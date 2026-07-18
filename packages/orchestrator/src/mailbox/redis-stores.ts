import { ulid } from 'ulid';
import {
  dedupKey, deliveryGuardKey, encodePayload, mailboxKey, type AgentInbound,
} from '@cerberus/protocol';

export interface StreamsClient {
  xgroup(...args: (string | number)[]): Promise<unknown>;
  xreadgroup(...args: (string | number)[]): Promise<unknown>;
  xadd(...args: (string | number)[]): Promise<unknown>;
  xack(key: string, group: string, id: string): Promise<unknown>;
  xautoclaim(...args: (string | number)[]): Promise<unknown>;
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

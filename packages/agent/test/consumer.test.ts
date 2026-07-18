import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodePayload, mailboxKey, OUTBOX_STREAM, type AgentInbound } from '@cerberus/protocol';
import { MailboxConsumer, type StreamsClient } from '../src/consumer.js';
import { StubBrain } from '../src/brain/stub-brain.js';
import { WorkspaceStore } from '../src/workspace.js';
import type { Brain } from '../src/brain/brain.js';

const KEY = 'T1-C1-1.2';

class FakeRedis implements StreamsClient {
  queue: [string, string[]][] = [];
  pending: [string, string[]][] = [];
  added: { stream: string; payload: string }[] = [];
  acked: string[] = [];
  groups: string[] = [];
  private seq = 0;

  push(msg: AgentInbound): void {
    this.queue.push([`${++this.seq}-0`, encodePayload(msg)]);
  }
  pendingPush(msg: AgentInbound): void {
    this.pending.push([`p${++this.seq}-0`, encodePayload(msg)]);
  }
  async xgroup(...args: (string | number)[]): Promise<unknown> {
    this.groups.push(args.join(' '));
    return 'OK';
  }
  async xreadgroup(...args: (string | number)[]): Promise<unknown> {
    // supports both the '>' (new) and '0' (pending) forms
    if (args[args.length - 1] === '0') {
      const batch = this.pending.splice(0, 10);
      return [[mailboxKey(KEY), batch]];
    }
    const entry = this.queue.shift();
    return entry ? [[mailboxKey(KEY), [entry]]] : null;
  }
  async xadd(...args: (string | number)[]): Promise<unknown> {
    this.added.push({ stream: String(args[0]), payload: String(args[args.length - 1]) });
    return '1-0';
  }
  async xack(_key: string, _group: string, id: string): Promise<unknown> {
    this.acked.push(id);
    return 1;
  }
}

describe('MailboxConsumer', () => {
  let root: string;
  let redis: FakeRedis;
  let consumer: MailboxConsumer;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cerberus-agent-'));
    redis = new FakeRedis();
    consumer = new MailboxConsumer(redis, new StubBrain(), new WorkspaceStore(root), KEY, root);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const userMsg = (id: string, text: string): AgentInbound => ({
    id, threadKey: KEY, kind: 'user_message', text, ts: '1.0',
  });

  it('processes a user message: persists, emits to outbox, acks', async () => {
    redis.push(userMsg('m1', 'hello'));
    expect(await consumer.runOnce(1)).toBe('processed');
    expect(redis.added.map((a) => a.stream)).toEqual([OUTBOX_STREAM, OUTBOX_STREAM]); // status + final
    expect(redis.acked).toEqual(['1-0']);
    const history = await new WorkspaceStore(root).load();
    expect(history.map((e) => e.role)).toEqual(['user', 'agent']);
  });

  it('returns idle when mailbox is empty', async () => {
    expect(await consumer.runOnce(1)).toBe('idle');
  });

  it('acks and returns shutdown on control shutdown', async () => {
    redis.push({ id: 'c1', threadKey: KEY, kind: 'control', control: 'shutdown', ts: '0' });
    expect(await consumer.runOnce(1)).toBe('shutdown');
    expect(redis.acked).toEqual(['1-0']);
    expect(redis.added).toEqual([]);
  });

  it('acks and drops malformed payloads', async () => {
    redis.queue.push(['9-0', ['payload', 'not-json']]);
    expect(await consumer.runOnce(1)).toBe('processed');
    expect(redis.acked).toEqual(['9-0']);
  });

  it('run() drains until shutdown', async () => {
    redis.push(userMsg('m1', 'one'));
    redis.push({ id: 'c1', threadKey: KEY, kind: 'control', control: 'shutdown', ts: '0' });
    await consumer.run(new AbortController().signal);
    expect(redis.acked.length).toBe(2);
    expect(redis.groups[0]).toBe(`CREATE ${mailboxKey(KEY)} agent 0 MKSTREAM`);
  });

  it('leaves entry unacked and propagates when the brain throws', async () => {
    const brain: Brain = {
      async *process() { throw new Error('brain boom'); },
    };
    const failing = new MailboxConsumer(redis, brain, new WorkspaceStore(root), KEY, root);
    redis.push(userMsg('m1', 'hello'));
    await expect(failing.runOnce(1)).rejects.toThrow('brain boom');
    expect(redis.acked).toEqual([]);
  });

  it('drainPending replays pending entries and honors shutdown', async () => {
    redis.pendingPush(userMsg('p1', 'old message'));
    redis.pendingPush({ id: 'c1', threadKey: KEY, kind: 'control', control: 'shutdown', ts: '0' });
    await consumer.run(new AbortController().signal);
    expect(redis.acked).toHaveLength(2);
    expect(redis.added.map((a) => a.stream)).toEqual([OUTBOX_STREAM, OUTBOX_STREAM]);
  });
});

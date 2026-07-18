import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { EventRouter, type NormalizedSlackMessage } from '../src/slack/router.js';

const log = pino({ level: 'silent' });
const evt: NormalizedSlackMessage = {
  teamId: 'T1', channelId: 'C1', threadTs: '1.2', ts: '1.3',
  text: 'hi bot', userId: 'U1', userDisplay: 'adrian',
};

function make(outcome: 'spawned' | 'deferred' | 'failed' | 'already-running' = 'spawned', firstSeen = true) {
  const seen = new Set<string>();
  const deps = {
    dedup: { markSeen: vi.fn(async (id: string) => firstSeen && !seen.has(id) && (seen.add(id), true)) },
    producer: { publish: vi.fn(async () => {}), publishControl: vi.fn(async () => {}) },
    supervisor: { ensureRunning: vi.fn(async () => ({ record: {} as never, outcome })) },
    poster: { postToThread: vi.fn(async () => {}) },
    log,
  };
  return { deps, router: new EventRouter(deps) };
}

describe('EventRouter.handle', () => {
  it('publishes to mailbox then ensures the agent (mailbox-first)', async () => {
    const { deps, router } = make();
    expect(await router.handle(evt)).toBe('accepted');
    expect(deps.producer.publish).toHaveBeenCalledWith(expect.objectContaining({
      threadKey: 'T1-C1-1.2', kind: 'user_message', text: 'hi bot',
      user: { id: 'U1', display: 'adrian' }, ts: '1.3',
    }));
    expect(deps.supervisor.ensureRunning).toHaveBeenCalledWith({
      threadKey: 'T1-C1-1.2', teamId: 'T1', channelId: 'C1', threadTs: '1.2',
    });
    expect(deps.poster.postToThread).not.toHaveBeenCalled();
  });

  it('drops duplicates by channel:ts', async () => {
    const { deps, router } = make();
    await router.handle(evt);
    expect(await router.handle(evt)).toBe('duplicate');
    expect(deps.producer.publish).toHaveBeenCalledTimes(1);
    expect(deps.dedup.markSeen).toHaveBeenCalledWith('C1:1.3');
  });

  it('notifies the thread when spawn fails but still queued the message', async () => {
    const { deps, router } = make('failed');
    await router.handle(evt);
    expect(deps.producer.publish).toHaveBeenCalledTimes(1);
    expect(deps.poster.postToThread).toHaveBeenCalledWith('T1-C1-1.2', expect.stringContaining('retry'));
  });

  it('notifies the thread when deferred by backpressure', async () => {
    const { deps, router } = make('deferred');
    await router.handle(evt);
    expect(deps.poster.postToThread).toHaveBeenCalledWith('T1-C1-1.2', expect.stringContaining('queued'));
  });
});

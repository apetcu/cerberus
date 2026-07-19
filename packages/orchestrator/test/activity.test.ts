import { describe, expect, it, vi } from 'vitest';
import { EventBus, type CerberusEvent } from '../src/api/events.js';
import { ActivityLog } from '../src/api/activity.js';

const evt = (threadKey: string, kind: CerberusEvent['kind'] = 'agent_spawned'): CerberusEvent => ({
  kind, threadKey, at: new Date().toISOString(),
});

describe('ActivityLog', () => {
  it('records published events newest first', () => {
    const bus = new EventBus();
    const log = new ActivityLog(bus);
    bus.publish(evt('k1'));
    bus.publish(evt('k2'));
    expect(log.recent().map((e) => e.threadKey)).toEqual(['k2', 'k1']);
  });

  it('stamps each event with a unique id', () => {
    const bus = new EventBus();
    const log = new ActivityLog(bus);
    bus.publish(evt('k1'));
    bus.publish(evt('k1'));
    const [a, b] = log.recent();
    expect(a!.id).not.toBe(b!.id);
  });

  it('drops the oldest entries beyond capacity', () => {
    const bus = new EventBus();
    const log = new ActivityLog(bus, 3);
    for (const k of ['a', 'b', 'c', 'd']) bus.publish(evt(k));
    expect(log.recent().map((e) => e.threadKey)).toEqual(['d', 'c', 'b']);
  });

  it('honours the limit argument', () => {
    const bus = new EventBus();
    const log = new ActivityLog(bus);
    for (const k of ['a', 'b', 'c']) bus.publish(evt(k));
    expect(log.recent(2).map((e) => e.threadKey)).toEqual(['c', 'b']);
  });

  it('notifies listeners of each new event and stops after unsubscribe', () => {
    const bus = new EventBus();
    const log = new ActivityLog(bus);
    const seen = vi.fn();
    const off = log.onEvent(seen);
    bus.publish(evt('k1'));
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0]![0]).toMatchObject({ threadKey: 'k1', kind: 'agent_spawned' });
    off();
    bus.publish(evt('k2'));
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('stop() detaches from the bus', () => {
    const bus = new EventBus();
    const log = new ActivityLog(bus);
    log.stop();
    bus.publish(evt('k1'));
    expect(log.recent()).toEqual([]);
  });

  it('copies cause through for agent_died and bytes through for workspace_evicted', () => {
    const bus = new EventBus();
    const log = new ActivityLog(bus);
    bus.publish({ kind: 'agent_died', threadKey: 'k1', at: new Date().toISOString(), cause: 'heartbeat_stale' });
    bus.publish({ kind: 'workspace_evicted', threadKey: 'k2', at: new Date().toISOString(), bytes: 4096 });
    const [evicted, died] = log.recent();
    expect(died).toMatchObject({ kind: 'agent_died', threadKey: 'k1', cause: 'heartbeat_stale' });
    expect(evicted).toMatchObject({ kind: 'workspace_evicted', threadKey: 'k2', bytes: 4096 });
  });

  it('leaves cause and bytes undefined for kinds that carry neither', () => {
    const bus = new EventBus();
    const log = new ActivityLog(bus);
    bus.publish(evt('k1'));
    const [entry] = log.recent();
    expect(entry!.cause).toBeUndefined();
    expect(entry!.bytes).toBeUndefined();
  });
});

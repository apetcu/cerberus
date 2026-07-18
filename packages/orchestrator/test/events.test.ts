import { describe, expect, it, vi } from 'vitest';
import { EventBus, type CerberusEvent } from '../src/api/events.js';

const evt = (threadKey: string): CerberusEvent => ({
  kind: 'agent_spawned', threadKey, at: new Date().toISOString(),
});

describe('EventBus', () => {
  it('delivers published events to every listener', () => {
    const bus = new EventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.onEvent(a);
    bus.onEvent(b);
    bus.publish(evt('k1'));
    expect(a).toHaveBeenCalledWith(expect.objectContaining({ threadKey: 'k1' }));
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('stops delivering after unsubscribe', () => {
    const bus = new EventBus();
    const fn = vi.fn();
    const off = bus.onEvent(fn);
    off();
    bus.publish(evt('k1'));
    expect(fn).not.toHaveBeenCalled();
  });

  it('isolates a throwing listener from the others', () => {
    const bus = new EventBus();
    const good = vi.fn();
    bus.onEvent(() => { throw new Error('bad listener'); });
    bus.onEvent(good);
    expect(() => bus.publish(evt('k1'))).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });
});

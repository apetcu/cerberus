import { act, cleanup, render, renderHook } from '@testing-library/react';
import { createElement, useLayoutEffect, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@cerberus/protocol';
import type { LogState } from '../src/lib/ws.js';

type WSListener = (event: { data?: string }) => void;

/**
 * A minimal fake WebSocket that mirrors the bits `ws.ts` actually touches:
 * readyState, addEventListener/removeEventListener, send, and close. Tests drive
 * `open`/`message`/`close` manually via the `emit*` helpers.
 */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  readonly sent: Array<{ type: string; channel: string }> = [];
  private readonly listeners = new Map<string, Set<WSListener>>();

  constructor(url: string) {
    this.url = url;
    instances.push(this);
  }

  addEventListener(type: string, listener: WSListener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: WSListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.emitClose();
  }

  emitOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatch('open', {});
  }

  emitMessage(message: ServerMessage): void {
    this.dispatch('message', { data: JSON.stringify(message) });
  }

  emitClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch('close', {});
  }

  private dispatch(type: string, event: { data?: string }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

let instances: FakeWebSocket[] = [];
let ws: typeof import('../src/lib/ws.js');

beforeEach(async () => {
  instances = [];
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  vi.resetModules();
  // Fresh module registry => a brand-new module-private ConnectionManager singleton per test.
  ws = await import('../src/lib/ws.js');
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('reconnect backoff', () => {
  it('does not open a second socket while a reconnect is already pending', () => {
    const { useChannel } = ws;
    renderHook(() => useChannel('overview'));
    expect(instances).toHaveLength(1);

    act(() => {
      instances[0]!.emitClose();
    });
    // The socket closed and a reconnect got scheduled, but hasn't fired yet.
    expect(instances).toHaveLength(1);

    // Another component mounts mid-outage and subscribes a different channel.
    renderHook(() => useChannel('thread:T1'));
    expect(instances).toHaveLength(1); // must NOT open a second socket immediately

    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(instances).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(instances).toHaveLength(2); // backoff elapsed, reconnect opens a new socket
  });

  it('grows 1s -> 2s -> 4s -> 8s -> 15s (capped), and a successful open resets it to 1s', () => {
    const { useChannel } = ws;
    renderHook(() => useChannel('overview'));
    expect(instances).toHaveLength(1);

    const closeLatest = () => act(() => instances.at(-1)!.emitClose());
    const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

    closeLatest(); // schedules at 1000ms, backoff grows to 2000ms for next time
    advance(999);
    expect(instances).toHaveLength(1);
    advance(1);
    expect(instances).toHaveLength(2);

    closeLatest(); // schedules at 2000ms, grows to 4000ms
    advance(1999);
    expect(instances).toHaveLength(2);
    advance(1);
    expect(instances).toHaveLength(3);

    closeLatest(); // schedules at 4000ms, grows to 8000ms
    advance(3999);
    expect(instances).toHaveLength(3);
    advance(1);
    expect(instances).toHaveLength(4);

    closeLatest(); // schedules at 8000ms, grows to min(16000, 15000) = 15000ms
    advance(7999);
    expect(instances).toHaveLength(4);
    advance(1);
    expect(instances).toHaveLength(5);

    closeLatest(); // schedules at 15000ms (cap holds: min(30000, 15000) = 15000ms)
    advance(14999);
    expect(instances).toHaveLength(5);
    advance(1);
    expect(instances).toHaveLength(6);

    // A successful open resets the backoff back to 1s.
    act(() => instances.at(-1)!.emitOpen());
    closeLatest(); // should schedule at 1000ms again, not 15000ms
    advance(999);
    expect(instances).toHaveLength(6);
    advance(1);
    expect(instances).toHaveLength(7);
  });

  it('re-subscribes every still-mounted channel after a reconnect', () => {
    const { useChannel } = ws;
    renderHook(() => useChannel('overview'));
    renderHook(() => useChannel('thread:T1'));
    expect(instances).toHaveLength(1);
    const first = instances[0]!;

    act(() => first.emitOpen());
    expect(first.sent).toHaveLength(2);
    expect(first.sent).toEqual(
      expect.arrayContaining([
        { type: 'subscribe', channel: 'overview' },
        { type: 'subscribe', channel: 'thread:T1' },
      ]),
    );

    act(() => first.emitClose());
    act(() => vi.advanceTimersByTime(1000));
    expect(instances).toHaveLength(2);
    const second = instances[1]!;

    act(() => second.emitOpen());
    expect(second.sent).toHaveLength(2);
    expect(second.sent).toEqual(
      expect.arrayContaining([
        { type: 'subscribe', channel: 'overview' },
        { type: 'subscribe', channel: 'thread:T1' },
      ]),
    );
  });
});

describe('channel reference counting', () => {
  it('sends one subscribe for two subscribers and one unsubscribe once both leave', () => {
    const { useChannel } = ws;
    const first = renderHook(() => useChannel('overview'));
    expect(instances).toHaveLength(1);
    const socket = instances[0]!;
    act(() => socket.emitOpen());
    expect(socket.sent).toEqual([{ type: 'subscribe', channel: 'overview' }]);

    const second = renderHook(() => useChannel('overview'));
    expect(instances).toHaveLength(1); // same socket reused
    expect(socket.sent).toEqual([{ type: 'subscribe', channel: 'overview' }]); // no duplicate subscribe

    act(() => first.unmount());
    expect(socket.sent).toEqual([{ type: 'subscribe', channel: 'overview' }]); // still one subscriber left, no unsubscribe

    act(() => second.unmount());
    expect(socket.sent).toEqual([
      { type: 'subscribe', channel: 'overview' },
      { type: 'unsubscribe', channel: 'overview' },
    ]);
  });
});

describe('useLogChannel', () => {
  it('resumes in strict arrival order: nothing lost, nothing duplicated', () => {
    // A plain renderHook + rerender cannot reproduce the real-world race (a message
    // arriving between the un-pause render and useLogChannel's own flush effect):
    // React's testing `act()` always flushes an update's render AND its effects together
    // as one atomic unit, so there is never an externally-observable gap to slot a message
    // into. `useLayoutEffect` runs synchronously right after commit but strictly *before*
    // passive effects (like useLogChannel's buffer-flush effect), so a companion layout
    // effect that fires the next message exactly on the paused:true -> false transition
    // reproduces that gap deterministically, in-process, with no reliance on real timers.
    const latest: { current: LogState | null } = { current: null };
    function Harness(props: { channel: string; paused: boolean }) {
      const state = ws.useLogChannel(props.channel, props.paused);
      latest.current = state;
      const wasPaused = useRef(props.paused);
      useLayoutEffect(() => {
        if (wasPaused.current && !props.paused) {
          instances[0]!.emitMessage({ type: 'log', channel: props.channel, lines: ['d', 'e'] });
        }
        wasPaused.current = props.paused;
      });
      return null;
    }

    const { rerender } = render(createElement(Harness, { channel: 'logs:T1', paused: true }));
    const socket = instances[0]!;

    act(() => {
      socket.emitMessage({ type: 'log', channel: 'logs:T1', lines: ['a', 'b'] });
    });
    act(() => {
      socket.emitMessage({ type: 'log', channel: 'logs:T1', lines: ['c'] });
    });
    expect(latest.current?.lines).toEqual([]); // still paused, nothing visible yet

    // Unpause. The layout effect fires synchronously mid-flush, before useLogChannel's own
    // [paused] flush effect runs, injecting ['d', 'e'] into the exact race window.
    act(() => {
      rerender(createElement(Harness, { channel: 'logs:T1', paused: false }));
    });

    expect(latest.current?.lines).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('caps the visible lines at 2000', () => {
    const { useLogChannel } = ws;
    const { result } = renderHook(() => useLogChannel('logs:T1', false));
    const socket = instances[0]!;

    act(() => {
      socket.emitMessage({
        type: 'log',
        channel: 'logs:T1',
        lines: Array.from({ length: 2500 }, (_, i) => `l${i}`),
      });
    });

    expect(result.current.lines).toHaveLength(2000);
    expect(result.current.lines[0]).toBe('l500');
    expect(result.current.lines[1999]).toBe('l2499');
  });

  it('bounds the pause buffer to the last 5000 lines', () => {
    const { useLogChannel } = ws;
    const spliceSpy = vi.spyOn(Array.prototype, 'splice');
    renderHook(() => useLogChannel('logs:T1', true));
    const socket = instances[0]!;

    act(() => {
      socket.emitMessage({
        type: 'log',
        channel: 'logs:T1',
        lines: Array.from({ length: 5000 }, (_, i) => `l${i}`),
      });
    });
    // Exactly at the cap: the `> 5000` guard must not trim yet.
    expect(spliceSpy).not.toHaveBeenCalled();

    act(() => {
      socket.emitMessage({ type: 'log', channel: 'logs:T1', lines: ['overflow'] });
    });
    // One line over: trims exactly the overflow amount (1) off the front.
    expect(spliceSpy).toHaveBeenCalledWith(0, 1);
  });
});

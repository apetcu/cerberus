import { afterEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { scheduleTick } from '../src/lifecycle/schedule-tick.js';

const log = pino({ level: 'silent' });

describe('scheduleTick', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('creates no timer at all when intervalMs is 0', async () => {
    vi.useFakeTimers();
    const tick = vi.fn(async () => {});
    const ac = new AbortController();

    scheduleTick(0, ac.signal, log, 'test', tick);
    await vi.advanceTimersByTimeAsync(1_000_000);

    expect(tick).not.toHaveBeenCalled();
  });

  it('runs tick on every interval and a rejection does not stop later firings', async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(log, 'error');
    let call = 0;
    const tick = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error('boom');
    });
    const ac = new AbortController();

    scheduleTick(1000, ac.signal, log, 'test', tick);

    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'test tick failed');

    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(2); // the earlier rejection never became an unhandled one
  });

  it('clears the timer once the signal aborts, so nothing fires afterward', async () => {
    vi.useFakeTimers();
    const tick = vi.fn(async () => {});
    const ac = new AbortController();

    scheduleTick(1000, ac.signal, log, 'test', tick);
    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(1);

    ac.abort();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('skips a firing while the previous tick is still in flight, and logs the skip at debug', async () => {
    vi.useFakeTimers();
    const debugSpy = vi.spyOn(log, 'debug');
    let resolveFirst!: () => void;
    const first = new Promise<void>((resolve) => { resolveFirst = resolve; });
    let calls = 0;
    const tick = vi.fn(async () => {
      calls += 1;
      if (calls === 1) await first;
    });
    const ac = new AbortController();

    scheduleTick(1000, ac.signal, log, 'slow-loop', tick);

    // First firing starts a tick that hangs, standing in for a hung Docker socket or a
    // graceful stop that takes up to 30 seconds.
    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(1);

    // Two more intervals fire while that tick is still in flight. Both must be skipped
    // outright, not queued behind it, or two ticks would end up running at once.
    await vi.advanceTimersByTimeAsync(2000);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledWith(
      { label: 'slow-loop' }, 'slow-loop tick skipped: previous tick still running',
    );

    // Once the in-flight tick resolves, the guard clears and the next firing runs normally.
    resolveFirst();
    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(2);
  });
});

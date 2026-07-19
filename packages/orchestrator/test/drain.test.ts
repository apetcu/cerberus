import { describe, expect, it, vi } from 'vitest';
import { DrainState } from '../src/lifecycle/drain.js';

describe('DrainState', () => {
  it('starts disabled with no timestamp', () => {
    const drain = new DrainState();
    expect(drain.enabled).toBe(false);
    expect(drain.since).toBeNull();
  });

  it('records when draining began and clears it on resume', () => {
    const drain = new DrainState();
    drain.set(true);
    expect(drain.enabled).toBe(true);
    expect(typeof drain.since).toBe('string');
    drain.set(false);
    expect(drain.enabled).toBe(false);
    expect(drain.since).toBeNull();
  });

  it('keeps the original timestamp when enabled twice', () => {
    const drain = new DrainState();
    drain.set(true);
    const first = drain.since;
    drain.set(true);
    expect(drain.since).toBe(first);
  });

  it('fires onResume listeners on a true transition from enabled to disabled', () => {
    const drain = new DrainState();
    drain.set(true);
    const fn = vi.fn();
    drain.onResume(fn);
    drain.set(false);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not fire onResume when already disabled', () => {
    const drain = new DrainState();
    const fn = vi.fn();
    drain.onResume(fn);
    drain.set(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it('unsubscribe stops delivery', () => {
    const drain = new DrainState();
    drain.set(true);
    const fn = vi.fn();
    const unsubscribe = drain.onResume(fn);
    unsubscribe();
    drain.set(false);
    expect(fn).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from 'vitest';
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
});

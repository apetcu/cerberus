import { describe, expect, it } from 'vitest';
import {
  capabilitiesSchema, clientMessageSchema, DEFAULT_TOOLS, logsChannel,
  OVERVIEW_CHANNEL, serverMessageSchema, threadChannel,
} from '../src/dashboard.js';

describe('channels', () => {
  it('builds channel names', () => {
    expect(OVERVIEW_CHANNEL).toBe('overview');
    expect(threadChannel('T1-C1-1.2')).toBe('thread:T1-C1-1.2');
    expect(logsChannel('T1-C1-1.2')).toBe('logs:T1-C1-1.2');
  });
});

describe('capabilitiesSchema', () => {
  it('applies defaults for a bare object', () => {
    const caps = capabilitiesSchema.parse({});
    expect(caps.tools).toEqual(DEFAULT_TOOLS);
    expect(caps.model).toBe('stub');
    expect(caps.cpu).toBeGreaterThan(0);
  });

  it('rejects unknown tools and out-of-range limits', () => {
    expect(() => capabilitiesSchema.parse({ tools: { nope: true } })).toThrow();
    expect(() => capabilitiesSchema.parse({ cpu: 0 })).toThrow();
    expect(() => capabilitiesSchema.parse({ memoryMb: 10 })).toThrow();
  });
});

describe('ws envelopes', () => {
  it('parses subscribe/unsubscribe from clients', () => {
    // Compare whole objects: `.channel` is absent on the `ping` member of the union.
    expect(clientMessageSchema.parse({ type: 'subscribe', channel: 'overview' }))
      .toEqual({ type: 'subscribe', channel: 'overview' });
    expect(clientMessageSchema.parse({ type: 'unsubscribe', channel: 'logs:k' }).type).toBe('unsubscribe');
    expect(() => clientMessageSchema.parse({ type: 'evil', channel: 'x' })).toThrow();
  });

  it('parses server messages', () => {
    expect(serverMessageSchema.parse({ type: 'log', channel: 'logs:k', line: 'hello' }))
      .toEqual({ type: 'log', channel: 'logs:k', line: 'hello' });
    const log = serverMessageSchema.parse({ type: 'log', channel: 'logs:k', line: 'hello' });
    expect(log.type).toBe('log');
    const err = serverMessageSchema.parse({ type: 'error', message: 'nope' });
    expect(err.type).toBe('error');
  });
});

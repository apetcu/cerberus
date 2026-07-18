import { describe, expect, it } from 'vitest';
import {
  buildThreadKey, dedupKey, deliveryGuardKey, heartbeatKey, mailboxKey, OUTBOX_STREAM, parseThreadKey,
} from '../src/keys.js';

describe('threadKey', () => {
  const parts = { teamId: 'T123', channelId: 'C456', threadTs: '1712345678.000100' };

  it('builds and parses round-trip', () => {
    const key = buildThreadKey(parts);
    expect(key).toBe('T123-C456-1712345678.000100');
    expect(parseThreadKey(key)).toEqual(parts);
  });

  it('rejects empty or dash-containing components', () => {
    expect(() => buildThreadKey({ ...parts, teamId: '' })).toThrow();
    expect(() => buildThreadKey({ ...parts, channelId: 'C-1' })).toThrow();
    expect(() => parseThreadKey('only-two')).toThrow();
  });
});

describe('redis keys', () => {
  it('builds namespaced keys', () => {
    expect(mailboxKey('a')).toBe('mailbox:a');
    expect(dedupKey('E1')).toBe('dedup:slack:E1');
    expect(deliveryGuardKey('O1')).toBe('delivered:O1');
    expect(heartbeatKey('a')).toBe('heartbeat:a');
    expect(OUTBOX_STREAM).toBe('outbox');
  });
});

import { describe, expect, it } from 'vitest';
import {
  agentInboundSchema, decodeInbound, decodeOutbound, encodePayload,
  type AgentInbound, type AgentOutbound,
} from '../src/messages.js';

describe('stream codec', () => {
  const inbound: AgentInbound = {
    id: '01J',
    threadKey: 'T1-C1-1.2',
    kind: 'user_message',
    text: 'hello',
    user: { id: 'U1', display: 'adrian' },
    ts: '1712345678.000200',
  };
  const outbound: AgentOutbound = {
    id: '01K', inReplyTo: '01J', threadKey: 'T1-C1-1.2', kind: 'message', text: 'hi', final: true,
  };

  it('round-trips inbound through payload field', () => {
    expect(decodeInbound(encodePayload(inbound))).toEqual(inbound);
  });

  it('round-trips outbound', () => {
    expect(decodeOutbound(encodePayload(outbound))).toEqual(outbound);
  });

  it('rejects garbage', () => {
    expect(() => decodeInbound(['payload', '{"nope":1}'])).toThrow();
    expect(() => decodeInbound(['other', 'x'])).toThrow();
  });

  it('accepts control messages without text', () => {
    const ctl = agentInboundSchema.parse({
      id: '1', threadKey: 'k', kind: 'control', control: 'shutdown', ts: '0',
    });
    expect(ctl.control).toBe('shutdown');
  });
});

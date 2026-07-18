import { describe, expect, it } from 'vitest';
import type { AgentInbound, AgentOutbound } from '@cerberus/protocol';
import { StubBrain } from '../src/brain/stub-brain.js';
import type { BrainContext } from '../src/brain/brain.js';

async function collect(it: AsyncIterable<AgentOutbound>): Promise<AgentOutbound[]> {
  const out: AgentOutbound[] = [];
  for await (const o of it) out.push(o);
  return out;
}

describe('StubBrain', () => {
  const msg: AgentInbound = {
    id: 'in-1', threadKey: 'T1-C1-1.2', kind: 'user_message', text: 'hello', ts: '1.3',
  };
  const ctx: BrainContext = {
    threadKey: 'T1-C1-1.2',
    workspacePath: '/workspace',
    history: [
      { id: 'a', role: 'user', text: 'earlier', ts: 'x' },
      { id: 'b', role: 'agent', text: 'reply', ts: 'x' },
      { id: 'in-1', role: 'user', text: 'hello', ts: 'x' },
    ],
  };

  it('yields a non-final status then a final echo counting user messages', async () => {
    const out = await collect(new StubBrain().process(msg, ctx));
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ kind: 'status', final: false, inReplyTo: 'in-1', threadKey: msg.threadKey });
    expect(out[1]).toMatchObject({ kind: 'message', final: true, inReplyTo: 'in-1' });
    expect(out[1]!.text).toContain('hello');
    expect(out[1]!.text).toContain('#2'); // 2 user messages in history
    expect(out[0]!.id).not.toBe(out[1]!.id);
  });
});

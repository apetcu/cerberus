import { ulid } from 'ulid';
import type { AgentInbound, AgentOutbound } from '@cerberus/protocol';
import type { Brain, BrainContext } from './brain.js';

export class StubBrain implements Brain {
  async *process(msg: AgentInbound, ctx: BrainContext): AsyncIterable<AgentOutbound> {
    const base = { inReplyTo: msg.id, threadKey: msg.threadKey };
    yield { id: ulid(), ...base, kind: 'status', text: '_thinking…_', final: false };
    const userCount = ctx.history.filter((e) => e.role === 'user').length;
    yield {
      id: ulid(),
      ...base,
      kind: 'message',
      text: `Echo: ${msg.text ?? ''} (user message #${userCount} in this thread)`,
      final: true,
    };
  }
}

import type { AgentInbound, AgentOutbound } from '@cerberus/protocol';
import type { ConversationEntry } from '../workspace.js';

export interface BrainContext {
  threadKey: string;
  workspacePath: string;
  /** Full conversation including the message being processed. */
  history: ConversationEntry[];
}

/** The swappable agent intelligence. v1: StubBrain. Later: Claude Agent SDK. */
export interface Brain {
  process(msg: AgentInbound, ctx: BrainContext): AsyncIterable<AgentOutbound>;
}

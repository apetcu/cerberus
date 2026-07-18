import { z } from 'zod';

export const agentInboundSchema = z.object({
  id: z.string().min(1),
  threadKey: z.string().min(1),
  kind: z.enum(['user_message', 'control']),
  text: z.string().optional(),
  control: z.enum(['shutdown', 'ping']).optional(),
  user: z.object({ id: z.string(), display: z.string() }).optional(),
  ts: z.string(),
});
export type AgentInbound = z.infer<typeof agentInboundSchema>;

export const agentOutboundSchema = z.object({
  id: z.string().min(1),
  inReplyTo: z.string(),
  threadKey: z.string().min(1),
  kind: z.enum(['message', 'status', 'error']),
  text: z.string(),
  final: z.boolean(),
});
export type AgentOutbound = z.infer<typeof agentOutboundSchema>;

export const PAYLOAD_FIELD = 'payload';

export function encodePayload(msg: AgentInbound | AgentOutbound): [string, string] {
  return [PAYLOAD_FIELD, JSON.stringify(msg)];
}

function payloadOf(fields: string[]): string {
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i] === PAYLOAD_FIELD) return fields[i + 1]!;
  }
  throw new Error('stream entry has no payload field');
}

export function decodeInbound(fields: string[]): AgentInbound {
  return agentInboundSchema.parse(JSON.parse(payloadOf(fields)));
}

export function decodeOutbound(fields: string[]): AgentOutbound {
  return agentOutboundSchema.parse(JSON.parse(payloadOf(fields)));
}

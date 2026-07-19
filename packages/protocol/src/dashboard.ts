import { z } from 'zod';

export const OVERVIEW_CHANNEL = 'overview';
export const threadChannel = (threadKey: string): string => `thread:${threadKey}`;
export const logsChannel = (threadKey: string): string => `logs:${threadKey}`;

export type ThreadStatusName = 'provisioning' | 'running' | 'stopping' | 'stopped' | 'failed';

export const DEFAULT_TOOLS = {
  web_search: false,
  code_execution: false,
  file_access: true,
  mcp_connectors: false,
} as const;

export const toolsSchema = z.object({
  web_search: z.boolean().default(DEFAULT_TOOLS.web_search),
  code_execution: z.boolean().default(DEFAULT_TOOLS.code_execution),
  file_access: z.boolean().default(DEFAULT_TOOLS.file_access),
  mcp_connectors: z.boolean().default(DEFAULT_TOOLS.mcp_connectors),
}).strict();

/** Mocked per-agent configuration: stored and displayed, not yet enforced by the runtime. */
export const capabilitiesSchema = z.object({
  tools: toolsSchema.default(DEFAULT_TOOLS),
  model: z.string().min(1).default('stub'),
  cpu: z.number().positive().max(8).default(0.5),
  memoryMb: z.number().int().min(64).max(16384).default(512),
  pidsLimit: z.number().int().min(16).max(4096).default(256),
  updatedAt: z.string().nullable().default(null),
}).strict();
export type Capabilities = z.infer<typeof capabilitiesSchema>;

export interface ConversationEntry {
  id: string;
  role: 'user' | 'agent';
  text: string;
  ts: string;
}

export interface AgentSummary {
  threadKey: string;
  teamId: string;
  channelId: string;
  threadTs: string;
  status: ThreadStatusName;
  containerName: string | null;
  containerRunning: boolean;
  /** heartbeat:<threadKey> present in Redis (agent alive within its 30s TTL). */
  heartbeatFresh: boolean;
  mailboxDepth: number;
  failureCount: number;
  createdAt: string;
  lastActivityAt: string;
}

export interface AgentDetail extends AgentSummary {
  containerId: string | null;
  runtime: 'docker' | 'k8s';
  workspacePath: string;
  conversation: ConversationEntry[];
  capabilities: Capabilities;
}

export interface OverviewSnapshot {
  generatedAt: string;
  runtime: 'docker' | 'k8s';
  runtimeHealthy: boolean;
  counts: {
    total: number;
    running: number;
    provisioning: number;
    stopping: number;
    stopped: number;
    failed: number;
  };
  agents: AgentSummary[];
}

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), channel: z.string().min(1) }),
  z.object({ type: z.literal('unsubscribe'), channel: z.string().min(1) }),
  z.object({ type: z.literal('ping') }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const serverMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), channel: z.string(), data: z.unknown() }),
  // Batched: the hub coalesces bursts so a chatty container cannot flood the socket.
  z.object({ type: z.literal('log'), channel: z.string(), lines: z.array(z.string()) }),
  z.object({ type: z.literal('log_end'), channel: z.string(), reason: z.string() }),
  z.object({
    type: z.literal('activity'),
    events: z.array(z.object({
      id: z.string(), kind: z.string(), threadKey: z.string(), at: z.string(),
    })),
  }),
  z.object({ type: z.literal('error'), channel: z.string().optional(), message: z.string() }),
  z.object({ type: z.literal('pong') }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

export const ACTIVITY_CHANNEL = 'activity';

export type ActivityKind =
  | 'agent_spawned' | 'agent_stopped' | 'agent_failed' | 'message_routed' | 'reply_posted';

export interface ActivityEvent {
  /** ULID, stable key for the UI. */
  id: string;
  kind: ActivityKind;
  threadKey: string;
  /** ISO-8601 */
  at: string;
}

export interface SystemInfo {
  runtime: 'docker' | 'k8s';
  agentImage: string;
  versions: { orchestrator: string; node: string };
  config: {
    idleTimeoutMs: number;
    reaperIntervalMs: number;
    maxConcurrentAgents: number;
    agentCpu: number;
    agentMemoryMb: number;
    agentPidsLimit: number;
    workspacesRoot: string;
    logLevel: string;
    dashboardEnabled: boolean;
    /** Never the token itself. */
    dashboardTokenSet: boolean;
  };
  slack: {
    connected: boolean;
    botUserId: string | null;
    botName: string | null;
    teamName: string | null;
    lastEventAt: string | null;
  };
  dependencies: { redis: 'ok' | 'error'; postgres: 'ok' | 'error'; runtime: 'ok' | 'error' };
  drain: { enabled: boolean; since: string | null };
}

import { createHash } from 'node:crypto';

export interface ResourceLimits {
  cpu: number;
  memoryBytes: number;
  pids: number;
}

export interface AgentSpec {
  threadKey: string;
  image: string;
  /** Path as understood by the runtime backend (Docker daemon host path / k8s subPath). */
  workspaceHostPath: string;
  env: Record<string, string>;
  limits: ResourceLimits;
  /** Test override; production images use their default CMD. */
  command?: string[];
}

export interface AgentHandle {
  id: string;
  name: string;
  threadKey: string;
  running: boolean;
}

export interface AgentRuntime {
  spawn(spec: AgentSpec): Promise<AgentHandle>;
  stop(handle: AgentHandle, graceful: boolean): Promise<void>;
  list(): Promise<AgentHandle[]>;
  inspect(name: string): Promise<AgentHandle | null>;
}

export const THREAD_LABEL = 'cerberus.thread-key';
export const ROLE_LABEL = 'cerberus.role';

/** Deterministic, DNS-safe name for a thread's container/pod. */
export function agentName(threadKey: string): string {
  return `cerberus-agent-${createHash('sha1').update(threadKey).digest('hex').slice(0, 12)}`;
}

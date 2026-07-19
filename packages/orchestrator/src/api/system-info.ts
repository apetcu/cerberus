import type { SystemInfo } from '@cerberus/protocol';
import type { Config } from '../config.js';
import type { SlackStatus } from '../slack/gateway.js';

export interface SystemInfoDeps {
  cfg: Config;
  slack: () => SlackStatus;
  drain: () => { enabled: boolean; since: string | null };
  checks: {
    redis: () => Promise<unknown>;
    postgres: () => Promise<unknown>;
    runtime: () => Promise<unknown>;
  };
}

/**
 * Builds the System payload. Deliberately enumerates every field rather than spreading
 * config: this function is the boundary that keeps secrets off the wire, and a spread
 * would let a future config key leak by accident.
 */
export async function buildSystemInfo(deps: SystemInfoDeps): Promise<SystemInfo> {
  const { cfg } = deps;
  const probe = async (fn: () => Promise<unknown>): Promise<'ok' | 'error'> => {
    try { await fn(); return 'ok'; } catch { return 'error'; }
  };
  const [redis, postgres, runtime] = await Promise.all([
    probe(deps.checks.redis), probe(deps.checks.postgres), probe(deps.checks.runtime),
  ]);
  return {
    runtime: cfg.RUNTIME,
    agentImage: cfg.AGENT_IMAGE,
    versions: { orchestrator: process.env.npm_package_version ?? '0.1.0', node: process.version },
    config: {
      idleTimeoutMs: cfg.IDLE_TIMEOUT_MS,
      reaperIntervalMs: cfg.REAPER_INTERVAL_MS,
      maxConcurrentAgents: cfg.MAX_CONCURRENT_AGENTS,
      agentCpu: cfg.AGENT_CPU,
      agentMemoryMb: cfg.AGENT_MEMORY_MB,
      agentPidsLimit: cfg.AGENT_PIDS_LIMIT,
      workspacesRoot: cfg.WORKSPACES_ROOT,
      logLevel: cfg.LOG_LEVEL,
      dashboardEnabled: cfg.DASHBOARD_ENABLED,
      // Boolean only: the token itself must never cross the wire.
      dashboardTokenSet: cfg.DASHBOARD_TOKEN.length > 0,
    },
    slack: deps.slack(),
    dependencies: { redis, postgres, runtime },
    drain: deps.drain(),
  };
}

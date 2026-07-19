import { z } from 'zod';

const schema = z.object({
  SLACK_BOT_TOKEN: z.string().min(1),
  SLACK_APP_TOKEN: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  /** Redis as reachable by the orchestrator. */
  REDIS_URL: z.string().min(1),
  /** Redis as reachable from inside agent containers (different host/creds). */
  AGENT_REDIS_URL: z.string().min(1),
  RUNTIME: z.enum(['docker', 'k8s']).default('docker'),
  AGENT_IMAGE: z.string().default('cerberus-agent:dev'),
  /** Docker network to attach agents to ('' = daemon default). */
  AGENT_NETWORK: z.string().default(''),
  IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(1_800_000),
  REAPER_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  MAX_CONCURRENT_AGENTS: z.coerce.number().int().positive().default(50),
  AGENT_CPU: z.coerce.number().positive().default(0.5),
  AGENT_MEMORY_MB: z.coerce.number().int().positive().default(512),
  AGENT_PIDS_LIMIT: z.coerce.number().int().positive().default(256),
  /** Workspace root as seen by the orchestrator process. */
  WORKSPACES_ROOT: z.string().default('/workspaces'),
  /** Same directory as seen by the Docker daemon (host path). '' = same as WORKSPACES_ROOT. */
  WORKSPACES_HOST_ROOT: z.string().default(''),
  K8S_NAMESPACE: z.string().default('cerberus'),
  K8S_WORKSPACE_PVC: z.string().default('cerberus-workspaces'),
  HEALTH_PORT: z.coerce.number().int().default(8080),
  LOG_LEVEL: z.string().default('info'),
  // NOT z.coerce.boolean(): it parses the string "false" as true (non-empty string).
  DASHBOARD_ENABLED: z.string().default('true').transform((v) => v !== 'false'),
  DASHBOARD_TOKEN: z.string().default(''),
  DASHBOARD_DIST: z.string().default(''),   // '' resolves to packages/dashboard/dist
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return schema.parse(env);
}

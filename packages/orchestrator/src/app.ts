import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Docker from 'dockerode';
import { CoreV1Api, KubeConfig } from '@kubernetes/client-node';
import { Redis } from 'ioredis';
import pg from 'pg';
import { WebSocketServer } from 'ws';
import { ActivityLog } from './api/activity.js';
import { EventBus } from './api/events.js';
import { DashboardHub, type HubSocket } from './api/hub.js';
import { createApiHandler, isAuthorized } from './api/routes.js';
import { SnapshotBuilder } from './api/snapshots.js';
import { createStaticHandler } from './api/static.js';
import { buildSystemInfo } from './api/system-info.js';
import type { Config } from './config.js';
import { DrainState } from './lifecycle/drain.js';
import { IdleReaper } from './lifecycle/reaper.js';
import { Reconciler } from './lifecycle/reconciler.js';
import { ThreadSupervisor } from './lifecycle/supervisor.js';
import { OutboxConsumer } from './mailbox/outbox-consumer.js';
import { MailboxProducer, RedisDedupStore, RedisDeliveryGuard, type StreamsClient } from './mailbox/redis-stores.js';
import { startHealthServer } from './observability/health.js';
import type { Logger } from './observability/logger.js';
import { Metrics } from './observability/metrics.js';
import { PostgresCapabilitiesRepo } from './registry/capabilities-repo.js';
import { migrate, MIGRATIONS_DIR } from './registry/migrate.js';
import { PostgresThreadRegistry } from './registry/postgres-thread-registry.js';
import type { AgentRuntime } from './runtime/agent-runtime.js';
import { DockerRuntime } from './runtime/docker-runtime.js';
import { K8sRuntime, type PodApi } from './runtime/k8s-runtime.js';
import { SlackGateway, type RouterRef } from './slack/gateway.js';
import { EventRouter } from './slack/router.js';

function makeRuntime(cfg: Config): AgentRuntime {
  if (cfg.RUNTIME === 'k8s') {
    const kc = new KubeConfig();
    kc.loadFromDefault(); // in-cluster service account or local kubeconfig
    const api = kc.makeApiClient(CoreV1Api) as unknown as PodApi;
    return new K8sRuntime(api, { namespace: cfg.K8S_NAMESPACE, workspacePvc: cfg.K8S_WORKSPACE_PVC });
  }
  return new DockerRuntime(new Docker({ socketPath: '/var/run/docker.sock' }),
    cfg.AGENT_NETWORK ? { network: cfg.AGENT_NETWORK } : {});
}

export async function buildApp(cfg: Config, log: Logger): Promise<{ start(): Promise<void>; shutdown(): Promise<void> }> {
  const pool = new pg.Pool({ connectionString: cfg.DATABASE_URL });
  // No global commandTimeout: the outbox consumer's XREADGROUP legitimately blocks for
  // seconds, and a client-wide deadline kills it every cycle. Dashboard reads are bounded
  // individually in SnapshotBuilder instead, where a stall must degrade one field only.
  const redisRaw = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: null });
  const redis = redisRaw as unknown as StreamsClient;
  // The outbox consumer parks on XREADGROUP ... BLOCK for seconds at a time, and a blocking
  // command owns its whole connection: every other command queues behind it. Sharing one
  // connection made dashboard reads (xlen/exists) miss their deadline and report a stale
  // heartbeat and an empty mailbox on a healthy agent. Blocking reads get their own socket.
  const redisBlockingRaw = redisRaw.duplicate();
  const redisBlocking = redisBlockingRaw as unknown as StreamsClient;
  const metrics = new Metrics();
  const events = new EventBus();
  const activity = new ActivityLog(events);
  const drain = new DrainState();

  const registry = new PostgresThreadRegistry(pool);
  const runtime = makeRuntime(cfg);
  const producer = new MailboxProducer(redis);
  const supervisor = new ThreadSupervisor({ registry, runtime, log, events, drain }, {
    runtime: cfg.RUNTIME, agentImage: cfg.AGENT_IMAGE, agentRedisUrl: cfg.AGENT_REDIS_URL,
    logLevel: cfg.LOG_LEVEL, workspacesRoot: cfg.WORKSPACES_ROOT, workspacesHostRoot: cfg.WORKSPACES_HOST_ROOT,
    maxConcurrentAgents: cfg.MAX_CONCURRENT_AGENTS,
    limits: { cpu: cfg.AGENT_CPU, memoryBytes: cfg.AGENT_MEMORY_MB * 1024 * 1024, pids: cfg.AGENT_PIDS_LIMIT },
  });

  const routerRef: RouterRef = { current: null };
  const gateway = new SlackGateway(
    { botToken: cfg.SLACK_BOT_TOKEN, appToken: cfg.SLACK_APP_TOKEN },
    registry, routerRef, log, metrics,
  );
  routerRef.current = new EventRouter({
    dedup: new RedisDedupStore(redis), producer, supervisor, poster: gateway, reactor: gateway, log, metrics, events,
  });

  const outbox = new OutboxConsumer(redisBlocking, gateway, new RedisDeliveryGuard(redis), log, events);
  const reaper = new IdleReaper({ registry, runtime, producer, log, metrics, events }, cfg.IDLE_TIMEOUT_MS);
  const reconciler = new Reconciler({ registry, runtime, log },
    { runtime: cfg.RUNTIME, workspacesRoot: cfg.WORKSPACES_ROOT });

  const capabilities = new PostgresCapabilitiesRepo(pool);
  const snapshots = new SnapshotBuilder({
    registry, runtime, capabilities, redis,
    runtimeName: cfg.RUNTIME, workspacesRoot: cfg.WORKSPACES_ROOT, log,
  });
  const hub = new DashboardHub({ snapshots, registry, runtime, events, activity, log });
  // Client messages are tiny subscribe/unsubscribe envelopes; cap frames so an oversized
  // payload is rejected by ws rather than buffered.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const distDir = cfg.DASHBOARD_DIST ||
    resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dashboard', 'dist');

  const ac = new AbortController();
  let health: { close(): Promise<void> } | null = null;
  let outboxDone: Promise<void> | null = null;
  let sampler: NodeJS.Timeout | null = null;

  const systemInfo = () => buildSystemInfo({
    cfg,
    slack: () => gateway.getStatus(),
    drain: () => ({ enabled: drain.enabled, since: drain.since }),
    checks: {
      redis: () => redisRaw.ping(),
      postgres: () => pool.query('SELECT 1'),
      runtime: () => runtime.list(),
    },
  });

  return {
    async start() {
      await migrate(pool, MIGRATIONS_DIR);
      const result = await reconciler.reconcile();
      log.info(result, 'reconciled');
      const dashboardHandlers = cfg.DASHBOARD_ENABLED
        ? [
            createApiHandler({
              snapshots, capabilities, registry, runtime, supervisor,
              activity, drain, system: systemInfo, events,
              token: cfg.DASHBOARD_TOKEN, log,
            }),
            createStaticHandler(distDir),
          ]
        : [];

      health = await startHealthServer({
        port: cfg.HEALTH_PORT, metrics, log,
        checks: {
          redis: async () => { await redisRaw.ping(); },
          postgres: async () => { await pool.query('SELECT 1'); },
        },
        handlers: dashboardHandlers,
        onUpgrade: cfg.DASHBOARD_ENABLED
          ? (req, socket, head) => {
              const url = new URL(req.url ?? '/', 'http://localhost');
              // Browsers cannot set headers on a WS handshake, so the token may arrive via the
              // query string here — REST stays header-only (see isAuthorized in api/routes.ts).
              if (url.pathname !== '/api/stream' || !isAuthorized(req, cfg.DASHBOARD_TOKEN, { allowQueryToken: true })) {
                socket.destroy();
                return;
              }
              wss.handleUpgrade(req, socket, head, (ws) => hub.addClient(ws as unknown as HubSocket));
            }
          : undefined,
      });
      if (cfg.DASHBOARD_ENABLED) hub.start();
      outboxDone = outbox.run(ac.signal).catch((err) => log.error({ err }, 'outbox consumer terminated'));
      reaper.start(cfg.REAPER_INTERVAL_MS, ac.signal);
      sampler = setInterval(() => {
        void registry.countByStatus('running')
          .then((n) => metrics.activeAgents.set(n))
          .catch(() => {});
      }, 15_000);
      await gateway.start();
      log.info('cerberus orchestrator started');
    },
    async shutdown() {
      // Agents keep running: they are independent actors; the reconciler re-adopts them on next boot.
      log.info('shutting down');
      await gateway.stop().catch(() => {});
      ac.abort();
      if (sampler) clearInterval(sampler);
      await outboxDone?.catch(() => {});
      hub.stop();
      activity.stop();
      // wss.close() only stops new upgrades; already-connected dashboards must be
      // terminated explicitly or they linger with an open socket through shutdown.
      for (const client of wss.clients) client.terminate();
      wss.close();
      await health?.close();
      redisBlockingRaw.disconnect();
      redisRaw.disconnect();
      await pool.end();
    },
  };
}

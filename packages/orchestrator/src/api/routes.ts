import type { IncomingMessage, ServerResponse } from 'node:http';
import { capabilitiesSchema } from '@cerberus/protocol';
import type { ThreadSupervisor } from '../lifecycle/supervisor.js';
import type { Logger } from '../observability/logger.js';
import type { CapabilitiesRepo } from '../registry/capabilities-repo.js';
import type { ThreadRegistry } from '../registry/thread-registry.js';
import type { AgentRuntime } from '../runtime/agent-runtime.js';
import type { SnapshotBuilder } from './snapshots.js';

export interface ApiDeps {
  snapshots: SnapshotBuilder;
  capabilities: CapabilitiesRepo;
  registry: ThreadRegistry;
  runtime: AgentRuntime;
  supervisor: Pick<ThreadSupervisor, 'ensureRunning'>;
  /** Empty string disables auth. */
  token: string;
  log: Logger;
}

export function isAuthorized(req: IncomingMessage, token: string): boolean {
  if (!token) return true;
  const header = req.headers.authorization ?? '';
  if (header === `Bearer ${token}`) return true;
  const url = new URL(req.url ?? '/', 'http://localhost');
  return url.searchParams.get('token') === token;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createApiHandler(deps: ApiDeps) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return false;

    if (!isAuthorized(req, deps.token)) {
      json(res, 401, { error: 'unauthorized' });
      return true;
    }

    try {
      const parts = url.pathname.split('/').filter(Boolean); // ['api', 'threads', key, sub?]
      const method = req.method ?? 'GET';

      if (parts[1] === 'overview' && method === 'GET') {
        json(res, 200, await deps.snapshots.overview());
        return true;
      }

      if (parts[1] === 'threads' && parts.length === 2 && method === 'GET') {
        json(res, 200, (await deps.snapshots.overview()).agents);
        return true;
      }

      const key = parts[2] ? decodeURIComponent(parts[2]) : '';
      const sub = parts[3];

      if (parts[1] === 'threads' && key) {
        if (!sub && method === 'GET') {
          const detail = await deps.snapshots.detail(key);
          if (!detail) { json(res, 404, { error: 'unknown thread' }); return true; }
          json(res, 200, detail);
          return true;
        }

        if (sub === 'capabilities' && method === 'GET') {
          const stored = await deps.capabilities.get(key);
          json(res, 200, stored ?? capabilitiesSchema.parse({}));
          return true;
        }

        if (sub === 'capabilities' && method === 'PUT') {
          if (!(await deps.registry.get(key))) { json(res, 404, { error: 'unknown thread' }); return true; }
          const parsed = capabilitiesSchema.safeParse(await readBody(req));
          if (!parsed.success) { json(res, 400, { error: 'invalid capabilities', issues: parsed.error.issues }); return true; }
          json(res, 200, await deps.capabilities.upsert(key, parsed.data));
          return true;
        }

        if (sub === 'logs' && method === 'GET') {
          const record = await deps.registry.get(key);
          const handle = record?.containerName ? await deps.runtime.inspect(record.containerName) : null;
          if (!handle) { json(res, 404, { error: 'no container for thread' }); return true; }
          const tail = Number(url.searchParams.get('tail') ?? '200');
          const lines: string[] = [];
          for await (const line of deps.runtime.logs(handle, { tail, follow: false })) lines.push(line);
          json(res, 200, { lines });
          return true;
        }

        if (sub === 'stop' && method === 'POST') {
          const record = await deps.registry.get(key);
          const handle = record?.containerName ? await deps.runtime.inspect(record.containerName) : null;
          if (!handle) { json(res, 404, { error: 'no container for thread' }); return true; }
          await deps.runtime.stop(handle, true);
          await deps.registry.setStatus(key, 'stopped', { containerId: null, containerName: null });
          json(res, 200, { stopped: true });
          return true;
        }

        if (sub === 'restart' && method === 'POST') {
          const record = await deps.registry.get(key);
          if (!record) { json(res, 404, { error: 'unknown thread' }); return true; }
          const result = await deps.supervisor.ensureRunning({
            threadKey: key, teamId: record.teamId, channelId: record.channelId, threadTs: record.threadTs,
          });
          json(res, 200, { outcome: result.outcome });
          return true;
        }
      }

      json(res, 404, { error: 'not found' });
      return true;
    } catch (err) {
      deps.log.error({ err, path: url.pathname }, 'api request failed');
      json(res, 500, { error: 'internal error' });
      return true;
    }
  };
}

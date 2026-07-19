import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { capabilitiesSchema, type SystemInfo } from '@cerberus/protocol';
import { z } from 'zod';
import type { DrainState } from '../lifecycle/drain.js';
import type { ThreadSupervisor } from '../lifecycle/supervisor.js';
import type { Logger } from '../observability/logger.js';
import type { CapabilitiesRepo } from '../registry/capabilities-repo.js';
import type { ThreadRegistry } from '../registry/thread-registry.js';
import type { AgentRuntime } from '../runtime/agent-runtime.js';
import type { ActivityLog } from './activity.js';
import type { EventBus } from './events.js';
import type { SnapshotBuilder } from './snapshots.js';

const MAX_BODY_BYTES = 64 * 1024;

/** Body exceeded MAX_BODY_BYTES; surfaced to the client as 413 rather than a generic 500. */
class PayloadTooLargeError extends Error {}

export interface ApiDeps {
  snapshots: SnapshotBuilder;
  capabilities: CapabilitiesRepo;
  registry: ThreadRegistry;
  runtime: AgentRuntime;
  supervisor: Pick<ThreadSupervisor, 'ensureRunning'>;
  activity: ActivityLog;
  drain: DrainState;
  system: () => Promise<SystemInfo>;
  events?: EventBus;
  /** Empty string disables auth. */
  token: string;
  log: Logger;
}

/** Constant-time compare. Length is not secret; content is. */
function secretEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function isAuthorized(
  req: IncomingMessage,
  token: string,
  opts: { allowQueryToken?: boolean } = {},
): boolean {
  if (!token) return true;

  const header = req.headers.authorization ?? '';
  if (header.startsWith('Bearer ') && secretEquals(header.slice('Bearer '.length), token)) return true;

  // Only the WebSocket upgrade may pass the token in the URL: browsers cannot set headers
  // on a WS handshake. REST clients must use the Authorization header so the secret never
  // lands in proxy logs, browser history, or a Referer.
  if (!opts.allowQueryToken) return false;
  const queryToken = new URL(req.url ?? '/', 'http://localhost').searchParams.get('token');
  return queryToken !== null && secretEquals(queryToken, token);
}

/**
 * Blocks cross-site browser requests to mutating routes. A browser always sends Origin on
 * these; non-browser clients (curl, probes) send none and are allowed through, so this
 * costs nothing operationally while removing the CSRF vector on a tokenless console.
 */
function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new PayloadTooLargeError();

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // Enforced while streaming too: Content-Length can lie or be absent (chunked encoding).
    if (size > MAX_BODY_BYTES) throw new PayloadTooLargeError();
    chunks.push(chunk as Buffer);
  }
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

    const method = req.method ?? 'GET';
    if (method !== 'GET' && !isSameOrigin(req)) {
      json(res, 403, { error: 'cross-origin request rejected' });
      return true;
    }

    try {
      const parts = url.pathname.split('/').filter(Boolean); // ['api', 'threads', key, sub?]

      if (parts[1] === 'overview' && method === 'GET') {
        json(res, 200, await deps.snapshots.overview());
        return true;
      }

      if (parts[1] === 'activity' && method === 'GET') {
        const rawLimit = Number(url.searchParams.get('limit') ?? '200');
        const limit = Number.isFinite(rawLimit)
          ? Math.min(Math.max(Math.trunc(rawLimit), 1), 500)
          : 200;
        json(res, 200, { events: deps.activity.recent(limit) });
        return true;
      }

      if (parts[1] === 'system' && parts.length === 2 && method === 'GET') {
        json(res, 200, await deps.system());
        return true;
      }

      if (parts[1] === 'system' && parts[2] === 'drain' && method === 'POST') {
        let body: unknown;
        try {
          body = await readBody(req);
        } catch (err) {
          if (err instanceof PayloadTooLargeError) { json(res, 413, { error: 'body too large' }); return true; }
          json(res, 400, { error: 'invalid json' });
          return true;
        }
        const parsed = z.object({ enabled: z.boolean() }).safeParse(body);
        if (!parsed.success) { json(res, 400, { error: 'expected { enabled: boolean }' }); return true; }
        deps.drain.set(parsed.data.enabled);
        deps.log.info({ enabled: parsed.data.enabled }, 'drain state changed');
        json(res, 200, { enabled: deps.drain.enabled, since: deps.drain.since });
        return true;
      }

      if (parts[1] === 'threads' && parts.length === 2 && method === 'GET') {
        json(res, 200, (await deps.snapshots.overview()).agents);
        return true;
      }

      let key = '';
      if (parts[2]) {
        try {
          key = decodeURIComponent(parts[2]);
        } catch {
          json(res, 400, { error: 'invalid thread key' });
          return true;
        }
      }
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
          let body: unknown;
          try {
            body = await readBody(req);
          } catch (err) {
            if (err instanceof PayloadTooLargeError) {
              json(res, 413, { error: 'body too large' });
              return true;
            }
            json(res, 400, { error: 'invalid json' });
            return true;
          }
          const parsed = capabilitiesSchema.safeParse(body);
          if (!parsed.success) { json(res, 400, { error: 'invalid capabilities', issues: parsed.error.issues }); return true; }
          json(res, 200, await deps.capabilities.upsert(key, parsed.data));
          return true;
        }

        if (sub === 'logs' && method === 'GET') {
          const record = await deps.registry.get(key);
          const handle = record?.containerName ? await deps.runtime.inspect(record.containerName) : null;
          if (!handle) { json(res, 404, { error: 'no container for thread' }); return true; }
          const rawTail = Number(url.searchParams.get('tail') ?? '200');
          const tail = Number.isFinite(rawTail)
            ? Math.min(Math.max(Math.trunc(rawTail), 1), 5000)
            : 200;
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
          deps.events?.publish({ kind: 'agent_stopped', threadKey: key, at: new Date().toISOString() });
          json(res, 200, { stopped: true });
          return true;
        }

        if (sub === 'restart' && method === 'POST') {
          const record = await deps.registry.get(key);
          if (!record) { json(res, 404, { error: 'unknown thread' }); return true; }
          const result = await deps.supervisor.ensureRunning({
            threadKey: key, teamId: record.teamId, channelId: record.channelId, threadTs: record.threadTs,
          });
          if (result.outcome === 'spawned') {
            deps.events?.publish({ kind: 'agent_spawned', threadKey: key, at: new Date().toISOString() });
          }
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

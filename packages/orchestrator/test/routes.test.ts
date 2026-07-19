import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { capabilitiesSchema, type AgentDetail, type OverviewSnapshot } from '@cerberus/protocol';
import { createApiHandler, isAuthorized, type ApiDeps } from '../src/api/routes.js';

const log = pino({ level: 'silent' });
const KEY = 'T1-C1-1.2';

const overview = { generatedAt: 'now', runtime: 'docker', runtimeHealthy: true,
  counts: { total: 0, running: 0, provisioning: 0, stopping: 0, stopped: 0, failed: 0 },
  agents: [] } as unknown as OverviewSnapshot;

function makeDeps(overrides: Partial<ApiDeps> = {}): ApiDeps {
  return {
    snapshots: {
      overview: vi.fn(async () => overview),
      detail: vi.fn(async (k: string) => (k === KEY ? ({ threadKey: k } as unknown as AgentDetail) : null)),
    } as never,
    capabilities: {
      get: vi.fn(async () => null),
      upsert: vi.fn(async (_k: string, c) => c),
      getMany: vi.fn(async () => new Map()),
    },
    registry: { get: vi.fn(async (k: string) => (k === KEY ? ({ threadKey: k } as never) : null)) } as never,
    runtime: { inspect: vi.fn(async () => null), stop: vi.fn() } as never,
    supervisor: { ensureRunning: vi.fn(async () => ({ record: {} as never, outcome: 'spawned' as const })) },
    token: '',
    log,
    ...overrides,
  };
}

let server: Server;
let base: string;

function serve(deps: ApiDeps) {
  const handler = createApiHandler(deps);
  server = createServer((req, res) => {
    void handler(req, res).then((handled) => { if (!handled) res.writeHead(404).end('nope'); });
  });
  return new Promise<void>((resolve) => {
    server.listen(0, () => { base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; resolve(); });
  });
}

afterEach(() => new Promise<void>((r) => server.close(() => r())));

describe('api routes', () => {
  it('GET /api/overview returns the snapshot', async () => {
    await serve(makeDeps());
    const res = await fetch(`${base}/api/overview`);
    expect(res.status).toBe(200);
    expect((await res.json() as OverviewSnapshot).runtime).toBe('docker');
  });

  it('GET /api/threads/:key returns detail, 404 for unknown', async () => {
    await serve(makeDeps());
    expect((await fetch(`${base}/api/threads/${KEY}`)).status).toBe(200);
    expect((await fetch(`${base}/api/threads/missing`)).status).toBe(404);
  });

  it('PUT capabilities validates the body and upserts', async () => {
    const deps = makeDeps();
    await serve(deps);
    const ok = await fetch(`${base}/api/threads/${KEY}/capabilities`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', cpu: 1 }),
    });
    expect(ok.status).toBe(200);
    expect(deps.capabilities.upsert).toHaveBeenCalled();

    const bad = await fetch(`${base}/api/threads/${KEY}/capabilities`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cpu: -1 }),
    });
    expect(bad.status).toBe(400);
  });

  it('PUT capabilities 404s for an unknown thread', async () => {
    await serve(makeDeps());
    const res = await fetch(`${base}/api/threads/missing/capabilities`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(capabilitiesSchema.parse({})),
    });
    expect(res.status).toBe(404);
  });

  it('POST restart calls ensureRunning', async () => {
    const deps = makeDeps();
    await serve(deps);
    const res = await fetch(`${base}/api/threads/${KEY}/restart`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(deps.supervisor.ensureRunning).toHaveBeenCalled();
  });

  it('requires a bearer token when one is configured', async () => {
    await serve(makeDeps({ token: 'sekret' }));
    expect((await fetch(`${base}/api/overview`)).status).toBe(401);
    const ok = await fetch(`${base}/api/overview`, { headers: { authorization: 'Bearer sekret' } });
    expect(ok.status).toBe(200);
  });

  it('returns false (unhandled) for non-api paths', async () => {
    await serve(makeDeps());
    expect((await fetch(`${base}/healthz`)).status).toBe(404); // our test server's fallthrough
  });

  it('rejects an oversized body with 413 without buffering it', async () => {
    await serve(makeDeps());
    const huge = JSON.stringify({ model: 'x'.repeat(100_000) });
    const res = await fetch(`${base}/api/threads/${KEY}/capabilities`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: huge,
    });
    expect(res.status).toBe(413);
  });

  it('returns 400 for malformed json rather than 500', async () => {
    await serve(makeDeps());
    const res = await fetch(`${base}/api/threads/${KEY}/capabilities`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{not json',
    });
    expect(res.status).toBe(400);
  });

  it('does not accept a query-param token on REST routes', async () => {
    await serve(makeDeps({ token: 'sekret' }));
    expect((await fetch(`${base}/api/overview?token=sekret`)).status).toBe(401);
    const ok = await fetch(`${base}/api/overview`, { headers: { authorization: 'Bearer sekret' } });
    expect(ok.status).toBe(200);
  });

  it('accepts a query-param token only when explicitly allowed (ws handshake path)', () => {
    const req = { headers: {}, url: '/api/stream?token=sekret' } as never;
    expect(isAuthorized(req, 'sekret')).toBe(false);
    expect(isAuthorized(req, 'sekret', { allowQueryToken: true })).toBe(true);
  });

  it('rejects a wrong bearer token', async () => {
    await serve(makeDeps({ token: 'sekret' }));
    expect((await fetch(`${base}/api/overview`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await fetch(`${base}/api/overview`, { headers: { authorization: 'Bearer sekretsekret' } })).status).toBe(401);
  });
});

import type { IncomingMessage, ServerResponse } from 'node:http';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { Metrics } from '../src/observability/metrics.js';
import { startHealthServer } from '../src/observability/health.js';

const log = pino({ level: 'silent' });
let server: { close(): Promise<void>; port: number };
afterEach(async () => { await server?.close(); });

describe('health server', () => {
  it('healthz 200, readyz 200 when checks pass, metrics exposed', async () => {
    const metrics = new Metrics();
    metrics.messagesInbound.inc();
    server = await startHealthServer({ port: 0, metrics, checks: { ok: async () => {} }, log });
    const base = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    const body = await (await fetch(`${base}/metrics`)).text();
    expect(body).toContain('cerberus_messages_inbound_total 1');
  });

  it('readyz 503 when a check fails', async () => {
    server = await startHealthServer({
      port: 0, metrics: new Metrics(),
      checks: { redis: async () => { throw new Error('down'); } }, log,
    });
    const res = await fetch(`http://127.0.0.1:${server.port}/readyz`);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('redis');
  });

  it('serves health, readiness and metrics even when a catch-all handler is installed', async () => {
    const metrics = new Metrics();
    metrics.messagesInbound.inc();
    // Mimics the dashboard SPA fallback: claims every request.
    const catchAll = async (_req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
      res.writeHead(200).end('<html>dashboard</html>');
      return true;
    };
    server = await startHealthServer({
      port: 0, metrics, log,
      checks: { ok: async () => {} },
      handlers: [catchAll],
    });
    const base = `http://127.0.0.1:${server.port}`;

    expect(await (await fetch(`${base}/healthz`)).text()).toBe('ok');
    expect(await (await fetch(`${base}/readyz`)).text()).toBe('ready');
    expect(await (await fetch(`${base}/metrics`)).text()).toContain('cerberus_messages_inbound_total');
    // Anything else still falls through to the handler.
    expect(await (await fetch(`${base}/`)).text()).toBe('<html>dashboard</html>');
  });

  it('readyz still reports 503 through a catch-all handler when a check fails', async () => {
    const catchAll = async (_req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
      res.writeHead(200).end('<html>dashboard</html>');
      return true;
    };
    server = await startHealthServer({
      port: 0, metrics: new Metrics(), log,
      checks: { redis: async () => { throw new Error('down'); } },
      handlers: [catchAll],
    });
    const res = await fetch(`http://127.0.0.1:${server.port}/readyz`);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('redis');
  });
});

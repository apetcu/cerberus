import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from './logger.js';
import type { Metrics } from './metrics.js';

export interface HealthServerOptions {
  port: number;
  metrics: Metrics;
  checks: Record<string, () => Promise<void>>;
  log: Logger;
}

export async function startHealthServer(
  opts: HealthServerOptions,
): Promise<{ close(): Promise<void>; port: number }> {
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/healthz') {
        res.writeHead(200).end('ok');
      } else if (req.url === '/readyz') {
        const failures: string[] = [];
        for (const [name, check] of Object.entries(opts.checks)) {
          try { await check(); } catch { failures.push(name); }
        }
        if (failures.length === 0) res.writeHead(200).end('ready');
        else res.writeHead(503).end(`not ready: ${failures.join(', ')}`);
      } else if (req.url === '/metrics') {
        res.writeHead(200, { 'content-type': opts.metrics.registry.contentType });
        res.end(await opts.metrics.registry.metrics());
      } else {
        res.writeHead(404).end();
      }
    } catch (err) {
      opts.log.error({ err }, 'health endpoint error');
      res.writeHead(500).end();
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

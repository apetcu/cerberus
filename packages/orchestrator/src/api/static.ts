import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

/**
 * Serves the built dashboard. Unknown paths fall back to index.html (SPA routing);
 * traversal attempts resolve outside distDir and are rejected before any read.
 */
export function createStaticHandler(distDir: string) {
  const root = resolve(distDir);

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if ((req.method ?? 'GET') !== 'GET') return false;
    const url = new URL(req.url ?? '/', 'http://localhost');

    const requested = resolve(join(root, normalize(url.pathname)));
    const inRoot = requested === root || requested.startsWith(root + sep);
    const target = inRoot && (await isFile(requested)) ? requested : join(root, 'index.html');

    try {
      const body = await readFile(target);
      const type = MIME[extname(target)] ?? 'application/octet-stream';
      const cache = target.includes(`${sep}assets${sep}`)
        ? 'public, max-age=31536000, immutable'   // vite emits content-hashed asset names
        : 'no-cache';
      res.writeHead(200, { 'content-type': type, 'content-length': body.length, 'cache-control': cache });
      res.end(body);
      return true;
    } catch {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Dashboard assets not built. Run: pnpm build:dashboard');
      return true;
    }
  };
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

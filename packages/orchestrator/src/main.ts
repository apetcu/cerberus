import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './observability/logger.js';

const cfg = loadConfig();
const log = createLogger(cfg.LOG_LEVEL);
const app = await buildApp(cfg, log);

let shuttingDown = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void app.shutdown().then(() => process.exit(0));
  });
}

await app.start();

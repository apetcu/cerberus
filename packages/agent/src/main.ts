import { Redis } from 'ioredis';
import pino from 'pino';
import { z } from 'zod';
import { heartbeatKey } from '@cerberus/protocol';
import { StubBrain } from './brain/stub-brain.js';
import { MailboxConsumer, type StreamsClient } from './consumer.js';
import { WorkspaceStore } from './workspace.js';

const env = z.object({
  THREAD_KEY: z.string().min(1),
  REDIS_URL: z.string().min(1),
  WORKSPACE_PATH: z.string().default('/workspace'),
  LOG_LEVEL: z.string().default('info'),
}).parse(process.env);

const log = pino({ level: env.LOG_LEVEL, base: { threadKey: env.THREAD_KEY } });
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
const consumer = new MailboxConsumer(
  redis as unknown as StreamsClient,
  new StubBrain(),
  new WorkspaceStore(env.WORKSPACE_PATH),
  env.THREAD_KEY,
  env.WORKSPACE_PATH,
  log,
);

const heartbeat = setInterval(() => {
  redis.set(heartbeatKey(env.THREAD_KEY), '1', 'EX', 30).catch(() => {});
}, 10_000);

const ac = new AbortController();
process.on('SIGTERM', () => ac.abort());
process.on('SIGINT', () => ac.abort());

log.info('agent starting');
try {
  await consumer.run(ac.signal);
  log.info('agent exiting cleanly');
} finally {
  clearInterval(heartbeat);
  redis.disconnect();
}

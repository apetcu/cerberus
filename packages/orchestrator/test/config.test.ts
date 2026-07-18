import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = {
  SLACK_BOT_TOKEN: 'xoxb-x', SLACK_APP_TOKEN: 'xapp-x',
  DATABASE_URL: 'postgres://u:p@h/db', REDIS_URL: 'redis://h',
  AGENT_REDIS_URL: 'redis://agents',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const cfg = loadConfig(base);
    expect(cfg.RUNTIME).toBe('docker');
    expect(cfg.IDLE_TIMEOUT_MS).toBe(1_800_000);
    expect(cfg.MAX_CONCURRENT_AGENTS).toBe(50);
    expect(cfg.AGENT_IMAGE).toBe('cerberus-agent:dev');
    expect(cfg.WORKSPACES_ROOT).toBe('/workspaces');
  });

  it('coerces numbers and validates enums', () => {
    expect(loadConfig({ ...base, IDLE_TIMEOUT_MS: '60000' }).IDLE_TIMEOUT_MS).toBe(60_000);
    expect(() => loadConfig({ ...base, RUNTIME: 'vm' })).toThrow();
  });

  it('fails fast on missing secrets', () => {
    expect(() => loadConfig({ ...base, SLACK_BOT_TOKEN: '' })).toThrow();
  });
});

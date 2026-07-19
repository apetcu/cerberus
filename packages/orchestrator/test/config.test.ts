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

  it('applies defaults for the operational-loop variables', () => {
    const cfg = loadConfig(base);
    expect(cfg.LIVENESS_INTERVAL_MS).toBe(15_000);
    expect(cfg.HEARTBEAT_GRACE_MS).toBe(60_000);
    expect(cfg.SWEEP_INTERVAL_MS).toBe(20_000);
    expect(cfg.WORKSPACE_GC_INTERVAL_MS).toBe(300_000);
    expect(cfg.WORKSPACES_MAX_MB).toBe(10_240);
  });

  it('allows 0 to disable each operational loop interval and the workspace cap', () => {
    const cfg = loadConfig({
      ...base,
      LIVENESS_INTERVAL_MS: '0',
      SWEEP_INTERVAL_MS: '0',
      WORKSPACE_GC_INTERVAL_MS: '0',
      WORKSPACES_MAX_MB: '0',
    });
    expect(cfg.LIVENESS_INTERVAL_MS).toBe(0);
    expect(cfg.SWEEP_INTERVAL_MS).toBe(0);
    expect(cfg.WORKSPACE_GC_INTERVAL_MS).toBe(0);
    expect(cfg.WORKSPACES_MAX_MB).toBe(0);
  });

  it('rejects a negative value for the new operational-loop variables', () => {
    expect(() => loadConfig({ ...base, LIVENESS_INTERVAL_MS: '-1' })).toThrow();
    expect(() => loadConfig({ ...base, HEARTBEAT_GRACE_MS: '0' })).toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildSystemInfo } from '../src/api/system-info.js';

const SECRETS = {
  SLACK_BOT_TOKEN: 'xoxb-SENTINEL-bot',
  SLACK_APP_TOKEN: 'xapp-SENTINEL-app',
  DATABASE_URL: 'postgres://SENTINELuser:SENTINELpass@db/cerberus',
  REDIS_URL: 'redis://SENTINELredis:SENTINELpw@redis:6379',
  AGENT_REDIS_URL: 'redis://SENTINELagent:SENTINELpw@redis:6379',
  DASHBOARD_TOKEN: 'SENTINEL-dashboard-token',
};

const deps = () => ({
  cfg: loadConfig({ ...SECRETS }),
  slack: () => ({ connected: true, botUserId: 'U1', botName: 'bot', teamName: 'T', lastEventAt: null }),
  drain: () => ({ enabled: false, since: null }),
  checks: { redis: async () => {}, postgres: async () => {}, runtime: async () => {} },
});

describe('buildSystemInfo', () => {
  it('never puts a secret on the wire', async () => {
    const raw = JSON.stringify(await buildSystemInfo(deps()));
    for (const secret of Object.values(SECRETS)) expect(raw).not.toContain(secret);
    for (const fragment of ['SENTINEL', 'xoxb-', 'xapp-', 'postgres://', 'redis://']) {
      expect(raw).not.toContain(fragment);
    }
    expect(raw).toContain('"dashboardTokenSet":true');
  });

  it('reports dashboardTokenSet false when no token is configured', async () => {
    const d = deps();
    d.cfg = loadConfig({ ...SECRETS, DASHBOARD_TOKEN: '' });
    expect((await buildSystemInfo(d)).config.dashboardTokenSet).toBe(false);
  });

  it('marks a failing dependency as error without failing the payload', async () => {
    const d = deps();
    d.checks.postgres = async () => { throw new Error('down'); };
    const info = await buildSystemInfo(d);
    expect(info.dependencies).toEqual({ redis: 'ok', postgres: 'error', runtime: 'ok' });
    expect(info.runtime).toBe('docker');
  });
});

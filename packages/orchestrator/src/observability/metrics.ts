import promClient from 'prom-client';

export class Metrics {
  readonly registry = new promClient.Registry();

  readonly activeAgents = new promClient.Gauge({
    name: 'cerberus_active_agents', help: 'Running agent containers', registers: [this.registry],
  });
  readonly spawnsTotal = new promClient.Counter({
    name: 'cerberus_agent_spawns_total', help: 'ensureRunning outcomes',
    labelNames: ['outcome'] as const, registers: [this.registry],
  });
  readonly messagesInbound = new promClient.Counter({
    name: 'cerberus_messages_inbound_total', help: 'Slack messages routed to mailboxes', registers: [this.registry],
  });
  readonly messagesOutbound = new promClient.Counter({
    name: 'cerberus_messages_outbound_total', help: 'Agent messages posted to Slack', registers: [this.registry],
  });
  readonly reapedTotal = new promClient.Counter({
    name: 'cerberus_agents_reaped_total', help: 'Idle agents stopped by the reaper', registers: [this.registry],
  });
  readonly slackErrors = new promClient.Counter({
    name: 'cerberus_slack_errors_total', help: 'Slack API failures', registers: [this.registry],
  });
}

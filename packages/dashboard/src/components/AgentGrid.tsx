import type { AgentSummary } from '@cerberus/protocol';
import { AgentCard } from './AgentCard';

export function AgentGrid({ agents, onOpen }: {
  agents: AgentSummary[];
  onOpen: (threadKey: string) => void;
}) {
  if (agents.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line bg-surface/50 px-6 py-16 text-center">
        <div className="text-sm text-muted">No threads yet</div>
        <div className="mt-1 text-xs text-dim">Mention the bot in Slack and its agent will appear here.</div>
      </div>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {agents.map((agent) => (
        <AgentCard key={agent.threadKey} agent={agent} onOpen={() => onOpen(agent.threadKey)} />
      ))}
    </div>
  );
}

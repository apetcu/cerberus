import type { ConversationEntry } from '@cerberus/protocol';

export function ConversationView({ entries }: { entries: ConversationEntry[] }) {
  if (entries.length === 0) {
    return <p className="text-sm text-dim">No messages yet in this thread's workspace.</p>;
  }
  return (
    <ol className="space-y-2">
      {entries.map((entry) => (
        <li
          key={entry.id}
          className={`rounded-lg border px-4 py-2.5 ${
            entry.role === 'user' ? 'border-line bg-surface' : 'border-accent/20 bg-accent/5'
          }`}
        >
          <div className="flex items-center justify-between gap-3">
            <span className="label">{entry.role}</span>
            <span className="text-xs text-dim">{new Date(entry.ts).toLocaleTimeString()}</span>
          </div>
          <p className="mt-1 whitespace-pre-wrap text-sm text-ink">{entry.text}</p>
        </li>
      ))}
    </ol>
  );
}

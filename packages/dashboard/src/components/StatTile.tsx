export function StatTile({ label, value, tone = 'ink' }: {
  label: string;
  value: number | string;
  tone?: 'ink' | 'ok' | 'warn' | 'bad';
}) {
  const color = { ink: 'text-ink', ok: 'text-ok', warn: 'text-warn', bad: 'text-bad' }[tone];
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <div className="label">{label}</div>
      <div className={`mt-1 text-3xl font-semibold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}

export function TabBar<T extends string>({ tabs, active, onChange }: {
  tabs: readonly T[];
  active: T;
  onChange: (tab: T) => void;
}) {
  return (
    <div className="flex gap-1 border-b border-line">
      {tabs.map((tab) => (
        <button
          key={tab}
          onClick={() => onChange(tab)}
          className={`-mb-px border-b-2 px-3 py-2 text-sm capitalize transition ${
            tab === active
              ? 'border-accent text-ink'
              : 'border-transparent text-muted hover:text-ink'
          }`}
        >
          {tab}
        </button>
      ))}
    </div>
  );
}

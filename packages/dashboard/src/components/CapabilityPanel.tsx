import { useEffect, useState } from 'react';
import { capabilitiesSchema, DEFAULT_TOOLS, type Capabilities } from '@cerberus/protocol';
import { api } from '../lib/api';

const TOOL_COPY: Record<keyof typeof DEFAULT_TOOLS, { name: string; hint: string }> = {
  web_search: { name: 'Web search', hint: 'Look things up online' },
  code_execution: { name: 'Code execution', hint: 'Run code in the workspace' },
  file_access: { name: 'File access', hint: 'Read and write /workspace' },
  mcp_connectors: { name: 'MCP connectors', hint: 'External tool servers' },
};

const MODELS = ['stub', 'claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'];

export function CapabilityPanel({ threadKey, initial }: { threadKey: string; initial: Capabilities }) {
  const [draft, setDraft] = useState<Capabilities>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(initial.updatedAt);

  useEffect(() => { setDraft(initial); setSavedAt(initial.updatedAt); }, [threadKey]);

  const dirty = JSON.stringify(draft) !== JSON.stringify({ ...initial, updatedAt: initial.updatedAt });

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const saved = await api.putCapabilities(threadKey, capabilitiesSchema.parse(draft));
      setDraft(saved);
      setSavedAt(saved.updatedAt);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-warn/30 bg-warn/10 px-4 py-2 text-xs text-warn">
        Configuration preview — stored for later, not yet enforced by the runtime.
      </div>

      <section className="rounded-lg border border-line bg-surface p-4">
        <h3 className="text-sm font-medium">Tools</h3>
        <p className="mt-0.5 text-xs text-dim">What this agent will be allowed to do.</p>
        <div className="mt-3 space-y-1">
          {(Object.keys(TOOL_COPY) as Array<keyof typeof DEFAULT_TOOLS>).map((tool) => (
            <label key={tool} className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover:bg-raised">
              <input
                type="checkbox"
                checked={draft.tools[tool]}
                onChange={(e) => setDraft({ ...draft, tools: { ...draft.tools, [tool]: e.target.checked } })}
                className="size-4 accent-[var(--color-accent)]"
              />
              <span className="flex-1">
                <span className="block text-sm text-ink">{TOOL_COPY[tool].name}</span>
                <span className="block text-xs text-dim">{TOOL_COPY[tool].hint}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-line bg-surface p-4">
        <h3 className="text-sm font-medium">Model</h3>
        <select
          value={draft.model}
          onChange={(e) => setDraft({ ...draft, model: e.target.value })}
          className="mt-2 w-full rounded-md border border-line-strong bg-bg px-3 py-2 font-mono text-sm text-ink"
        >
          {MODELS.map((model) => <option key={model} value={model}>{model}</option>)}
        </select>
      </section>

      <section className="rounded-lg border border-line bg-surface p-4">
        <h3 className="text-sm font-medium">Resource limits</h3>
        <div className="mt-3 space-y-4">
          <Slider label="CPU" unit="cores" min={0.25} max={4} step={0.25}
            value={draft.cpu} onChange={(cpu) => setDraft({ ...draft, cpu })} />
          <Slider label="Memory" unit="MB" min={128} max={4096} step={128}
            value={draft.memoryMb} onChange={(memoryMb) => setDraft({ ...draft, memoryMb })} />
          <Slider label="PIDs" unit="max" min={32} max={1024} step={32}
            value={draft.pidsLimit} onChange={(pidsLimit) => setDraft({ ...draft, pidsLimit })} />
        </div>
      </section>

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={!dirty || saving}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-bg disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {error && <span className="text-xs text-bad">{error}</span>}
        {!error && savedAt && (
          <span className="text-xs text-dim">Saved {new Date(savedAt).toLocaleTimeString()}</span>
        )}
      </div>
    </div>
  );
}

function Slider({ label, unit, min, max, step, value, onChange }: {
  label: string; unit: string; min: number; max: number; step: number;
  value: number; onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between">
        <span className="text-sm text-ink">{label}</span>
        <span className="font-mono text-sm text-muted tabular-nums">{value} {unit}</span>
      </span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-2 w-full accent-[var(--color-accent)]"
      />
    </label>
  );
}

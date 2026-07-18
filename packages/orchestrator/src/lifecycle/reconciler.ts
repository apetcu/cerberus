import { join } from 'node:path';
import { parseThreadKey } from '@cerberus/protocol';
import type { Logger } from '../observability/logger.js';
import type { ThreadRegistry } from '../registry/thread-registry.js';
import type { AgentRuntime } from '../runtime/agent-runtime.js';

export interface ReconcilerDeps {
  registry: ThreadRegistry;
  runtime: AgentRuntime;
  log: Logger;
}

export interface ReconcilerConfig {
  runtime: 'docker' | 'k8s';
  workspacesRoot: string;
}

export interface ReconcileResult {
  orphanedRows: number;
  adopted: number;
  stoppedUnknown: number;
}

/** Boot-time repair: make the registry agree with what is actually running. */
export class Reconciler {
  constructor(private readonly deps: ReconcilerDeps, private readonly cfg: ReconcilerConfig) {}

  async reconcile(): Promise<ReconcileResult> {
    const { registry, runtime, log } = this.deps;
    const result: ReconcileResult = { orphanedRows: 0, adopted: 0, stoppedUnknown: 0 };
    const handles = await runtime.list();
    const liveByKey = new Map(handles.filter((h) => h.running).map((h) => [h.threadKey, h]));

    for (const status of ['running', 'provisioning', 'stopping'] as const) {
      for (const rec of await registry.listByStatus(status)) {
        if (!liveByKey.has(rec.threadKey)) {
          await registry.setStatus(rec.threadKey, 'stopped', { containerId: null, containerName: null });
          result.orphanedRows += 1;
          log.warn({ threadKey: rec.threadKey, was: status }, 'reconciler: orphaned row marked stopped');
        }
      }
    }

    for (const handle of liveByKey.values()) {
      const rec = await registry.get(handle.threadKey);
      if (rec?.status === 'running' && rec.containerName === handle.name) continue;
      let parts;
      try {
        parts = parseThreadKey(handle.threadKey);
      } catch (err) {
        await runtime.stop(handle, false);
        result.stoppedUnknown += 1;
        log.warn({ err, container: handle.name }, 'reconciler: stopped unidentifiable container');
        continue;
      }
      if (!rec) {
        await registry.upsertActivity({
          threadKey: handle.threadKey,
          ...parts,
          runtime: this.cfg.runtime,
          workspacePath: join(this.cfg.workspacesRoot, handle.threadKey),
        });
      }
      await registry.setStatus(handle.threadKey, 'running', {
        containerId: handle.id, containerName: handle.name,
      });
      result.adopted += 1;
      log.info({ threadKey: handle.threadKey }, 'reconciler: adopted live container');
    }
    return result;
  }
}

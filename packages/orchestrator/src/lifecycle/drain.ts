/**
 * Fleet-wide pause on spawning, for deploys. Process-local and in-memory, matching the
 * single-replica orchestrator. Draining never stops running agents and never drops
 * messages: the mailbox write happens before ensureRunning, so anything arriving while
 * drained is processed once draining ends.
 */
export class DrainState {
  private draining = false;
  private startedAt: string | null = null;
  private readonly resumeListeners = new Set<() => void>();

  get enabled(): boolean {
    return this.draining;
  }

  get since(): string | null {
    return this.startedAt;
  }

  set(enabled: boolean): void {
    if (enabled === this.draining) return; // keep the original timestamp
    this.draining = enabled;
    this.startedAt = enabled ? new Date().toISOString() : null;
    if (!enabled) {
      for (const fn of this.resumeListeners) fn();
    }
  }

  /** Fires only on a real transition from draining to resumed, never on every set(false). */
  onResume(fn: () => void): () => void {
    this.resumeListeners.add(fn);
    return () => this.resumeListeners.delete(fn);
  }
}

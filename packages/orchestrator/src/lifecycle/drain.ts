/**
 * Fleet-wide pause on spawning, for deploys. Process-local and in-memory, matching the
 * single-replica orchestrator. Draining never stops running agents and never drops
 * messages: the mailbox write happens before ensureRunning, so anything arriving while
 * drained is processed once draining ends.
 */
export class DrainState {
  private draining = false;
  private startedAt: string | null = null;

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
  }
}

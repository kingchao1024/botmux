import { randomUUID } from 'node:crypto';
import {
  TaskControlPlaneStore,
  type AppendTaskControlEventInput,
  type AppendTaskControlObservationInput,
  type DeliveryOutboxRow,
  type PhaseFreezeValidation,
  type TaskControlEvent,
} from './task-control-plane-store.js';
import { DaemonTaskControlAuthority, type TaskControlAuthentication } from './task-control-plane-authority.js';

export interface TaskControlPlaneFlags {
  ledgerEnabled: boolean;
  shadowEnabled: boolean;
  pumpEnabled: boolean;
  freezeEnforcement: boolean;
}

export interface TaskControlPlaneLogger {
  warn(message: string): void;
}

export interface TaskControlPlaneDeliveryResult {
  kind: 'delivered' | 'retry' | 'degraded';
  error?: string;
  /** Exact provider receipt for this event/destination; required for delivered. */
  receiptRef?: string;
}

export interface TaskControlPlaneLifecycle {
  readonly enabled: boolean;
  /** Start timers/pump only after daemon-owned adapters are fully constructed. */
  activate(): void;
  append(input: Omit<AppendTaskControlEventInput, 'authentication'> & { authentication?: TaskControlAuthentication }): void;
  enqueueEvent(input: Omit<AppendTaskControlEventInput, 'authentication'> & { authentication: TaskControlAuthentication }): void;
  appendUnknownObservation(input: AppendTaskControlObservationInput): void;
  enqueueUnknownObservation(input: AppendTaskControlObservationInput): void;
  getStore(): TaskControlPlaneStore | undefined;
  freeze(input: {
    eventId: string; projectId: string; phaseId: string; authentication: TaskControlAuthentication; approval: unknown;
    idempotencyKey: string; occurredAt?: string; evidenceRef?: string;
  }): { kind: 'frozen'; validation: PhaseFreezeValidation; event: TaskControlEvent } | { kind: 'rejected'; validation: PhaseFreezeValidation };
  close(timeoutMs?: number): Promise<void>;
}

export class TaskControlPlaneFlagError extends Error {
  constructor(public readonly code: string) {
    super(`task_control_flag_invalid:${code}`);
    this.name = 'TaskControlPlaneFlagError';
  }
}

export function taskControlPlaneDatabasePath(dataDir: string): string {
  return `${dataDir.replace(/\/$/, '')}/botmux-task-control-plane.sqlite`;
}

export interface TaskControlPlaneRuntimeOptions {
  dataDir: string;
  /** Owning bot identity; shared dataDir pumps never claim another bot's rows. */
  larkAppId?: string;
  flags?: Partial<TaskControlPlaneFlags>;
  authority: DaemonTaskControlAuthority;
  logger: TaskControlPlaneLogger;
  deliver?: (row: DeliveryOutboxRow) => Promise<TaskControlPlaneDeliveryResult>;
  now?: () => number;
  intervalMs?: number;
  staleClaimMs?: number;
  maxAttempts?: number;
  /** Shadow only drives reference-only active collection; it never freezes. */
  collect?: () => Promise<void>;
  /** Defer activation for daemon bootstrap so recovery cannot beat adapter readiness. */
  deferStart?: boolean;
}

const DEFAULT_FLAGS: TaskControlPlaneFlags = Object.freeze({
  ledgerEnabled: false,
  shadowEnabled: false,
  pumpEnabled: false,
  freezeEnforcement: false,
});

export function taskControlPlaneFlags(env: NodeJS.ProcessEnv = process.env): TaskControlPlaneFlags {
  const enabled = (name: string): boolean => env[name]?.trim().toLowerCase() === 'true';
  return {
    ledgerEnabled: enabled('TASK_CONTROL_PLANE_LEDGER_ENABLED'),
    shadowEnabled: enabled('TASK_CONTROL_PLANE_SHADOW_ENABLED'),
    pumpEnabled: enabled('TASK_CONTROL_PLANE_PUMP_ENABLED'),
    freezeEnforcement: enabled('TASK_CONTROL_PLANE_FREEZE_ENFORCEMENT'),
  };
}

function validateFlags(flags: TaskControlPlaneFlags, hasDelivery: boolean, hasCollector: boolean): void {
  if (flags.shadowEnabled && !flags.ledgerEnabled) throw new TaskControlPlaneFlagError('shadow_requires_ledger');
  if (flags.shadowEnabled && !hasCollector) throw new TaskControlPlaneFlagError('shadow_collector_required');
  if (flags.freezeEnforcement && !flags.ledgerEnabled) throw new TaskControlPlaneFlagError('freeze_enforcement_requires_ledger');
  if (flags.pumpEnabled && !flags.ledgerEnabled) throw new TaskControlPlaneFlagError('pump_requires_ledger');
  if (flags.pumpEnabled && !hasDelivery) throw new TaskControlPlaneFlagError('pump_delivery_required');
  if (flags.shadowEnabled && flags.pumpEnabled) throw new TaskControlPlaneFlagError('shadow_pump_mutually_exclusive');
  if (flags.shadowEnabled && flags.freezeEnforcement) throw new TaskControlPlaneFlagError('shadow_freeze_mutually_exclusive');
  if (flags.pumpEnabled && flags.freezeEnforcement) throw new TaskControlPlaneFlagError('pump_freeze_mutually_exclusive');
}

function retryDelay(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), 60_000);
}

class DisabledTaskControlPlaneLifecycle implements TaskControlPlaneLifecycle {
  readonly enabled = false;
  activate(): void { /* disabled */ }
  append(): void { /* Default off: legacy daemon paths remain wholly unchanged. */ }
  enqueueEvent(): void { /* Default off: legacy daemon paths remain wholly unchanged. */ }
  appendUnknownObservation(): void { /* Default off: legacy daemon paths remain wholly unchanged. */ }
  enqueueUnknownObservation(): void { /* Default off: legacy daemon paths remain wholly unchanged. */ }
  getStore(): undefined { return undefined; }
  freeze(): never { throw new TaskControlPlaneFlagError('freeze_enforcement_disabled'); }
  async close(): Promise<void> { /* no resources */ }
}

class ActiveTaskControlPlaneLifecycle implements TaskControlPlaneLifecycle {
  readonly enabled = true;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private collecting = false;
  private stopped = false;
  private closed = false;
  private closeAfterInflight: Promise<void> | undefined;
  private readonly pendingSidecarWrites: Array<
    | { kind: 'observation'; input: AppendTaskControlObservationInput }
    | { kind: 'event'; input: Omit<AppendTaskControlEventInput, 'authentication'> & { authentication: TaskControlAuthentication } }
  > = [];
  private sidecarScheduled = false;
  private droppedSidecarWrites = 0;

  constructor(
    private readonly store: TaskControlPlaneStore,
    private readonly options: Required<Pick<TaskControlPlaneRuntimeOptions, 'logger' | 'now' | 'staleClaimMs' | 'maxAttempts'>>
      & Pick<TaskControlPlaneRuntimeOptions, 'deliver' | 'collect' | 'intervalMs'> & { freezeEnabled: boolean },
  ) {}

  start(): void {
    if (this.timer || (!this.options.deliver && !this.options.collect)) return;
    const tick = (): void => {
      if (this.options.deliver) void this.pump().catch(error => this.options.logger.warn(`[task-control] outbox pump failed: ${String(error)}`));
      if (this.options.collect && !this.stopped && !this.collecting) {
        this.collecting = true;
        void this.options.collect()
          .catch(error => this.options.logger.warn(`[task-control] shadow collector failed: ${String(error)}`))
          .finally(() => { this.collecting = false; });
      }
    };
    tick();
    this.timer = setInterval(tick, this.options.intervalMs ?? 5_000);
    this.timer.unref?.();
  }

  activate(): void { this.start(); }

  getStore(): TaskControlPlaneStore { return this.store; }

  append(input: Omit<AppendTaskControlEventInput, 'authentication'> & { authentication?: TaskControlAuthentication }): void {
    if (!input.authentication) {
      this.options.logger.warn('[task-control] event skipped: daemon authentication unavailable');
      return;
    }
    try { this.store.appendEvent({ ...input, authentication: input.authentication }); }
    catch (error) { this.options.logger.warn(`[task-control] ledger append failed (legacy path continued): ${String(error)}`); }
  }

  enqueueEvent(input: Omit<AppendTaskControlEventInput, 'authentication'> & { authentication: TaskControlAuthentication }): void {
    this.enqueueSidecarWrite({ kind: 'event', input });
  }

  appendUnknownObservation(input: AppendTaskControlObservationInput): void {
    try { this.store.appendUnknownObservation(input); }
    catch (error) { this.options.logger.warn(`[task-control] observation append failed (legacy path continued): ${String(error)}`); }
  }

  private tryAppendUnknownObservation(input: AppendTaskControlObservationInput): boolean {
    try { return this.store.tryAppendUnknownObservation(input) !== undefined; }
    catch (error) {
      this.options.logger.warn(`[task-control] observation append failed (legacy path continued): ${String(error)}`);
      return false;
    }
  }

  private tryAppendEvent(input: Omit<AppendTaskControlEventInput, 'authentication'> & { authentication: TaskControlAuthentication }): boolean {
    try { return this.store.tryAppendEvent(input) !== undefined; }
    catch (error) {
      this.options.logger.warn(`[task-control] ledger append failed (legacy path continued): ${String(error)}`);
      return false;
    }
  }

  enqueueUnknownObservation(input: AppendTaskControlObservationInput): void {
    this.enqueueSidecarWrite({ kind: 'observation', input });
  }

  private enqueueSidecarWrite(write: typeof this.pendingSidecarWrites[number]): void {
    if (this.stopped || this.closed) {
      this.droppedSidecarWrites++;
      this.options.logger.warn('[task-control] sidecar write dropped after shutdown');
      return;
    }
    if (this.pendingSidecarWrites.length >= 128) {
      this.droppedSidecarWrites++;
      this.options.logger.warn('[task-control] sidecar queue full; write dropped');
      return;
    }
    this.pendingSidecarWrites.push(write);
    this.pumpSidecarWrites();
  }


  freeze(input: {
    eventId: string; projectId: string; phaseId: string; authentication: TaskControlAuthentication; approval: unknown;
    idempotencyKey: string; occurredAt?: string; evidenceRef?: string;
  }): { kind: 'frozen'; validation: PhaseFreezeValidation; event: TaskControlEvent } | { kind: 'rejected'; validation: PhaseFreezeValidation } {
    if (!this.options.freezeEnabled) throw new TaskControlPlaneFlagError('freeze_enforcement_disabled');
    if (this.stopped || this.closed) throw new Error('task_control_runtime_closed');
    return this.store.freezePhase(input);
  }

  private pumpSidecarWrites(): void {
    if (this.sidecarScheduled) return;
    this.sidecarScheduled = true;
    setImmediate(() => {
      this.sidecarScheduled = false;
      const next = this.pendingSidecarWrites.shift();
      if (next && !this.stopped && !this.closed) {
        const written = next.kind === 'event' ? this.tryAppendEvent(next.input) : this.tryAppendUnknownObservation(next.input);
        if (!written) {
          this.droppedSidecarWrites++;
          this.options.logger.warn(`[task-control] ${next.kind} write busy; sidecar write dropped`);
        }
      }
      if (this.pendingSidecarWrites.length > 0 && !this.stopped && !this.closed) {
        this.pumpSidecarWrites();
      }
    });
  }

  private async pump(): Promise<void> {
    if (this.stopped || this.running || !this.options.deliver) return;
    this.running = (async () => {
      const now = this.options.now();
      try { this.store.resetExpiredOutboxClaims(now, this.options.staleClaimMs); }
      catch (error) { this.options.logger.warn(`[task-control] claim recovery failed: ${String(error)}`); }
      const token = randomUUID();
      let rows: DeliveryOutboxRow[];
      try { rows = this.store.claimOutbox({ now, limit: 10, claimToken: token }); }
      catch (error) { this.options.logger.warn(`[task-control] outbox claim failed: ${String(error)}`); return; }
      for (const row of rows) {
        if (this.stopped) break;
        try {
          const result = await this.options.deliver!(row);
          if (result.kind === 'delivered') {
            if (!result.receiptRef) {
              this.store.rescheduleOutbox(row.outboxId, token, {
                error: 'delivery_receipt_missing', nextAttemptAt: this.options.now() + retryDelay(row.attempts),
              });
            } else {
              this.store.settleOutboxDelivered(row.outboxId, token, {
                receiptRef: TaskControlPlaneStore.providerReceiptRef(row.eventId, row.destinationId, result.receiptRef),
                deliveredAt: new Date(this.options.now()).toISOString(),
              });
            }
          } else if (result.kind === 'degraded' || row.attempts >= this.options.maxAttempts) {
            this.store.settleOutboxDegraded(row.outboxId, token, { error: result.error ?? 'delivery_retry_exhausted' });
          } else {
            this.store.rescheduleOutbox(row.outboxId, token, {
              error: result.error ?? 'delivery_retry',
              nextAttemptAt: this.options.now() + retryDelay(row.attempts),
            });
          }
        } catch (error) {
          const message = String(error);
          if (row.attempts >= this.options.maxAttempts) {
            this.store.settleOutboxDegraded(row.outboxId, token, { error: message });
          } else {
            this.store.rescheduleOutbox(row.outboxId, token, { error: message, nextAttemptAt: this.options.now() + retryDelay(row.attempts) });
          }
        }
      }
    })().finally(() => { this.running = undefined; });
    await this.running;
  }

  private closeStore(): void {
    if (this.closed) return;
    this.closed = true;
    this.store.close();
  }

  private deferCloseUntilInflightSettles(inflight: Promise<void>): void {
    if (this.closeAfterInflight) return;
    this.closeAfterInflight = inflight.then(
      () => { this.closeStore(); },
      () => { this.closeStore(); },
    );
  }

  async close(timeoutMs = 2_000): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.pendingSidecarWrites.length > 0) {
      this.droppedSidecarWrites += this.pendingSidecarWrites.length;
      this.pendingSidecarWrites.length = 0;
    }
    if (this.droppedSidecarWrites > 0) {
      this.options.logger.warn(`[task-control] ${this.droppedSidecarWrites} queued sidecar writes dropped during shutdown`);
    }
    const inflight = this.running;
    if (!inflight) { this.closeStore(); return; }
    const settled = await Promise.race([
      inflight.then(() => true, () => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), Math.max(0, timeoutMs))),
    ]);
    if (settled) { this.closeStore(); return; }
    // Keep the database open: the in-flight delivery owns its claim and must
    // settle (or leave it for crash/restart recovery) without touching a closed
    // handle. The process may exit before this continuation; then stale-claim
    // recovery is the only subsequent writer.
    this.deferCloseUntilInflightSettles(inflight);
  }
}

/**
 * Best-effort bootstrap. Ledger failure deliberately returns a disabled handle
 * so no existing daemon dispatch/report route is made less available.
 */
export async function startTaskControlPlaneRuntime(options: TaskControlPlaneRuntimeOptions): Promise<TaskControlPlaneLifecycle> {
  const flags = { ...DEFAULT_FLAGS, ...options.flags };
  validateFlags(flags, !!options.deliver, !!options.collect);
  if (!flags.ledgerEnabled) return new DisabledTaskControlPlaneLifecycle();
  try {
    const store = await TaskControlPlaneStore.open(options.dataDir, options.authority, options.larkAppId);
    const lifecycle = new ActiveTaskControlPlaneLifecycle(store, {
      logger: options.logger,
      now: options.now ?? Date.now,
      staleClaimMs: options.staleClaimMs ?? 60_000,
      maxAttempts: options.maxAttempts ?? 5,
      deliver: flags.pumpEnabled ? options.deliver : undefined,
      collect: flags.shadowEnabled ? options.collect : undefined,
      freezeEnabled: flags.freezeEnforcement,
      intervalMs: options.intervalMs,
    });
    if (!options.deferStart) lifecycle.activate();
    return lifecycle;
  } catch (error) {
    options.logger.warn(`[task-control] bootstrap failed; continuing with ledger disabled: ${String(error)}`);
    return new DisabledTaskControlPlaneLifecycle();
  }
}

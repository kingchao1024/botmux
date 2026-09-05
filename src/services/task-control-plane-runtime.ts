import { randomUUID } from 'node:crypto';
import {
  TaskControlPlaneStore,
  type AppendTaskControlEventInput,
  type AppendTaskControlObservationInput,
  type DeliveryOutboxRow,
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
}

export interface TaskControlPlaneLifecycle {
  readonly enabled: boolean;
  append(input: Omit<AppendTaskControlEventInput, 'authentication'> & { authentication?: TaskControlAuthentication }): void;
  appendUnknownObservation(input: AppendTaskControlObservationInput): void;
  close(timeoutMs?: number): Promise<void>;
}

export function taskControlPlaneDatabasePath(dataDir: string): string {
  return `${dataDir.replace(/\/$/, '')}/botmux-task-control-plane.sqlite`;
}

export interface TaskControlPlaneRuntimeOptions {
  dataDir: string;
  flags?: Partial<TaskControlPlaneFlags>;
  authority: DaemonTaskControlAuthority;
  logger: TaskControlPlaneLogger;
  deliver?: (row: DeliveryOutboxRow) => Promise<TaskControlPlaneDeliveryResult>;
  now?: () => number;
  intervalMs?: number;
  staleClaimMs?: number;
  maxAttempts?: number;
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

function retryDelay(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), 60_000);
}

class DisabledTaskControlPlaneLifecycle implements TaskControlPlaneLifecycle {
  readonly enabled = false;
  append(): void { /* Default off: legacy daemon paths remain wholly unchanged. */ }
  appendUnknownObservation(): void { /* Default off: legacy daemon paths remain wholly unchanged. */ }
  async close(): Promise<void> { /* no resources */ }
}

class ActiveTaskControlPlaneLifecycle implements TaskControlPlaneLifecycle {
  readonly enabled = true;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly store: TaskControlPlaneStore,
    private readonly options: Required<Pick<TaskControlPlaneRuntimeOptions, 'logger' | 'now' | 'staleClaimMs' | 'maxAttempts'>>
      & Pick<TaskControlPlaneRuntimeOptions, 'deliver' | 'intervalMs'>,
  ) {}

  start(): void {
    if (!this.options.deliver || this.timer) return;
    const tick = (): void => { void this.pump().catch(error => this.options.logger.warn(`[task-control] outbox pump failed: ${String(error)}`)); };
    tick();
    this.timer = setInterval(tick, this.options.intervalMs ?? 5_000);
    this.timer.unref?.();
  }

  append(input: Omit<AppendTaskControlEventInput, 'authentication'> & { authentication?: TaskControlAuthentication }): void {
    if (!input.authentication) {
      this.options.logger.warn('[task-control] event skipped: daemon authentication unavailable');
      return;
    }
    try { this.store.appendEvent({ ...input, authentication: input.authentication }); }
    catch (error) { this.options.logger.warn(`[task-control] ledger append failed (legacy path continued): ${String(error)}`); }
  }

  appendUnknownObservation(input: AppendTaskControlObservationInput): void {
    try { this.store.appendUnknownObservation(input); }
    catch (error) { this.options.logger.warn(`[task-control] observation append failed (legacy path continued): ${String(error)}`); }
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
        try {
          const result = await this.options.deliver!(row);
          if (result.kind === 'delivered') {
            this.store.settleOutboxDelivered(row.outboxId, token, new Date(this.options.now()).toISOString());
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

  async close(timeoutMs = 2_000): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    const running = this.running;
    if (running && timeoutMs > 0) {
      await Promise.race([running, new Promise<void>(resolve => setTimeout(resolve, timeoutMs))]);
    }
    this.store.close();
  }
}

/**
 * Best-effort bootstrap. Ledger failure deliberately returns a disabled handle
 * so no existing daemon dispatch/report route is made less available.
 */
export async function startTaskControlPlaneRuntime(options: TaskControlPlaneRuntimeOptions): Promise<TaskControlPlaneLifecycle> {
  const flags = { ...DEFAULT_FLAGS, ...options.flags };
  if (!flags.ledgerEnabled) return new DisabledTaskControlPlaneLifecycle();
  try {
    const store = await TaskControlPlaneStore.open(options.dataDir, options.authority);
    const lifecycle = new ActiveTaskControlPlaneLifecycle(store, {
      logger: options.logger,
      now: options.now ?? Date.now,
      staleClaimMs: options.staleClaimMs ?? 60_000,
      maxAttempts: options.maxAttempts ?? 5,
      deliver: flags.pumpEnabled ? options.deliver : undefined,
      intervalMs: options.intervalMs,
    });
    lifecycle.start();
    return lifecycle;
  } catch (error) {
    options.logger.warn(`[task-control] bootstrap failed; continuing with ledger disabled: ${String(error)}`);
    return new DisabledTaskControlPlaneLifecycle();
  }
}

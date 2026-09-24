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
import { parseKeyIdSet } from './task-control-plane-mapping-trust.js';

export interface TaskControlPlaneFlags {
  ledgerEnabled: boolean;
  shadowEnabled: boolean;
  pumpEnabled: boolean;
  freezeEnforcement: boolean;
}

export interface ScopedTaskControlPlaneConfig {
  flags: TaskControlPlaneFlags;
  /** Present only for the one exact app+task read-only Shadow canary. */
  shadowTaskGuid?: string;
  /** Legacy fixed P2-7 integration scope, retained while production is opt-in. */
  canary?: TaskControlPlaneCanaryScope;
  disabledReason?: string;
}

export type TaskControlPlaneCanaryRole = 'controller' | 'worker' | 'reviewer';

export interface TaskControlPlaneCanaryScope {
  role: TaskControlPlaneCanaryRole;
  projectId: string;
  phaseId: string;
  taskGuids: readonly string[];
  controllerAppId: string;
  workerAppId: string;
  reviewerAppId: string;
  docToken: string;
}

export const P2_7_TASK_CONTROL_CANARY = Object.freeze({
  projectId: 'p2-7-canary',
  phaseId: 'phase-1',
  taskGuids: [
    'dddcc370-e210-4dd1-b7b9-9dabddc38ddf',
    '7637c5bc-729e-4e58-978d-20ab9f9679a8',
    'a151cdaa-fb8f-4800-be3c-cdf273e56d23',
  ] as readonly string[],
  controllerAppId: 'cli_aac926f0eb795bc1',
  workerAppId: 'cli_aa1e53f7aaf81bc6',
  reviewerAppId: 'cli_aa1e4c5508f8dbd3',
  docToken: 'Rk2VdXPb8oRcBFxdZp9morIlyZc',
});

export interface ProductionTaskControlPlaneConfig {
  flags: TaskControlPlaneFlags;
  allowedKeyIds?: readonly string[];
  revokedKeyIds?: readonly string[];
  disabledReason?: string;
}

export interface TaskControlPlaneLogger {
  warn(message: string): void;
}

export interface TaskControlPlaneDeliveryResult {
  kind: 'delivered' | 'retry' | 'degraded';
  error?: string;
  /** Exact provider receipt for this event/destination; required for delivered. */
  receiptRef?: string;
  /** Durable controlled fallback queued before the primary row is degraded. */
  fallbackDestinationId?: string;
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

const LARK_APP_ID_PATTERN = /^cli_[A-Za-z0-9]{16,64}$/;
const TASK_GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPED_SHADOW_LARK_APP_ID = 'cli_aac926f0eb795bc1';
const SCOPED_SHADOW_TASK_GUID = '2cd616e9-910b-47e1-a081-349b4808ee5a';
const P2_7_SCOPE_ENV_NAMES = [
  'TASK_CONTROL_PLANE_PROJECT_ID', 'TASK_CONTROL_PLANE_PHASE_ID', 'TASK_CONTROL_PLANE_TASK_GUIDS',
  'TASK_CONTROL_PLANE_CONTROLLER_LARK_APP_ID', 'TASK_CONTROL_PLANE_WORKER_LARK_APP_ID',
  'TASK_CONTROL_PLANE_REVIEWER_LARK_APP_ID', 'TASK_CONTROL_PLANE_DOC_TOKEN',
] as const;
const P2_7_GATE_ENV_NAMES = ['TASK_CONTROL_PLANE_PUMP_CANARY_ENABLED', 'TASK_CONTROL_PLANE_FREEZE_CANARY_ENABLED'] as const;

function exactTaskSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && new Set(actual).size === actual.length && actual.every(taskGuid => expected.includes(taskGuid));
}

function parseTaskGuids(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const taskGuids = value.split(',').map(item => item.trim());
  return taskGuids.length > 0 && taskGuids.every(taskGuid => TASK_GUID_PATTERN.test(taskGuid)) ? taskGuids : undefined;
}

/** Exact, set-based legacy-canary mapping check; duplicate task values reject. */
export function matchesTaskControlPlaneCanaryMapping(
  canary: TaskControlPlaneCanaryScope,
  mapping: { projectId: string; phaseId: string; phaseTaskGuids: readonly string[]; taskGuid: string; docToken?: string },
): boolean {
  return mapping.projectId === canary.projectId
    && mapping.phaseId === canary.phaseId
    && mapping.docToken === canary.docToken
    && canary.taskGuids.includes(mapping.taskGuid)
    && exactTaskSet(mapping.phaseTaskGuids, canary.taskGuids);
}

/**
 * Production daemon gate for the first real Shadow canary. Any enabled flag
 * requires one exact app+task scope and the read-only ledger+shadow flag set.
 * Missing, malformed, cross-app or write-capable configurations fail closed.
 */
export function scopedTaskControlPlaneConfig(
  selfLarkAppId: string,
  env: NodeJS.ProcessEnv = process.env,
): ScopedTaskControlPlaneConfig {
  const flags = taskControlPlaneFlags(env);
  const disabled = (): TaskControlPlaneFlags => ({ ...DEFAULT_FLAGS });
  const flagNames = [
    'TASK_CONTROL_PLANE_LEDGER_ENABLED',
    'TASK_CONTROL_PLANE_SHADOW_ENABLED',
    'TASK_CONTROL_PLANE_PUMP_ENABLED',
    'TASK_CONTROL_PLANE_FREEZE_ENFORCEMENT',
  ];
  if (flagNames.some(name => env[name] !== undefined && !/^(true|false)$/i.test(env[name]!.trim()))) {
    return { flags: disabled(), disabledReason: 'flag_value_invalid' };
  }
  if (!Object.values(flags).some(Boolean)) return { flags: disabled() };

  // Preserve the already-released exact P2-7 integration contract. The new
  // production path is selected by TASK_CONTROL_PLANE_PRODUCTION in daemon.ts.
  if (P2_7_SCOPE_ENV_NAMES.some(name => env[name] !== undefined)) {
    const knownNames = new Set<string>([...flagNames, ...P2_7_SCOPE_ENV_NAMES, ...P2_7_GATE_ENV_NAMES]);
    if (Object.keys(env).some(name => name.startsWith('TASK_CONTROL_PLANE_') && !knownNames.has(name))) {
      return { flags: disabled(), disabledReason: 'canary_scope_extra' };
    }
    if (P2_7_GATE_ENV_NAMES.some(name => env[name] !== undefined && !/^(true|false)$/i.test(env[name]!.trim()))) {
      return { flags: disabled(), disabledReason: 'flag_value_invalid' };
    }
    if (P2_7_SCOPE_ENV_NAMES.some(name => !env[name]?.trim())) return { flags: disabled(), disabledReason: 'canary_scope_required' };
    const taskGuids = parseTaskGuids(env.TASK_CONTROL_PLANE_TASK_GUIDS);
    const controllerAppId = env.TASK_CONTROL_PLANE_CONTROLLER_LARK_APP_ID?.trim();
    const workerAppId = env.TASK_CONTROL_PLANE_WORKER_LARK_APP_ID?.trim();
    const reviewerAppId = env.TASK_CONTROL_PLANE_REVIEWER_LARK_APP_ID?.trim();
    const projectId = env.TASK_CONTROL_PLANE_PROJECT_ID?.trim();
    const phaseId = env.TASK_CONTROL_PLANE_PHASE_ID?.trim();
    const docToken = env.TASK_CONTROL_PLANE_DOC_TOKEN?.trim();
    if (!taskGuids || !controllerAppId || !workerAppId || !reviewerAppId || !docToken
      || !LARK_APP_ID_PATTERN.test(controllerAppId) || !LARK_APP_ID_PATTERN.test(workerAppId) || !LARK_APP_ID_PATTERN.test(reviewerAppId)) {
      return { flags: disabled(), disabledReason: 'canary_scope_invalid' };
    }
    if (projectId !== P2_7_TASK_CONTROL_CANARY.projectId || phaseId !== P2_7_TASK_CONTROL_CANARY.phaseId
      || !exactTaskSet(taskGuids, P2_7_TASK_CONTROL_CANARY.taskGuids)
      || controllerAppId !== P2_7_TASK_CONTROL_CANARY.controllerAppId || workerAppId !== P2_7_TASK_CONTROL_CANARY.workerAppId
      || reviewerAppId !== P2_7_TASK_CONTROL_CANARY.reviewerAppId || docToken !== P2_7_TASK_CONTROL_CANARY.docToken) {
      return { flags: disabled(), disabledReason: 'canary_scope_unauthorized' };
    }
    const role = selfLarkAppId === controllerAppId ? 'controller' : selfLarkAppId === workerAppId ? 'worker' : selfLarkAppId === reviewerAppId ? 'reviewer' : undefined;
    if (!role) return { flags: disabled(), disabledReason: 'target_app_mismatch' };
    if (!flags.ledgerEnabled || !flags.shadowEnabled) return { flags: disabled(), disabledReason: 'canary_ledger_shadow_required' };
    if (flags.pumpEnabled && (role !== 'controller' || env.TASK_CONTROL_PLANE_PUMP_CANARY_ENABLED?.trim().toLowerCase() !== 'true')) {
      return { flags: disabled(), disabledReason: 'pump_canary_gate_required' };
    }
    if (flags.freezeEnforcement && (role !== 'controller' || env.TASK_CONTROL_PLANE_FREEZE_CANARY_ENABLED?.trim().toLowerCase() !== 'true')) {
      return { flags: disabled(), disabledReason: 'freeze_canary_gate_required' };
    }
    return {
      flags: { ...flags, shadowEnabled: flags.shadowEnabled && role === 'controller' },
      canary: { role, projectId, phaseId, taskGuids: [...P2_7_TASK_CONTROL_CANARY.taskGuids], controllerAppId, workerAppId, reviewerAppId, docToken },
    };
  }

  const targetLarkAppId = env.TASK_CONTROL_PLANE_TARGET_LARK_APP_ID?.trim();
  const targetTaskGuid = env.TASK_CONTROL_PLANE_TARGET_TASK_GUID?.trim();
  if (!targetLarkAppId || !targetTaskGuid) {
    return { flags: disabled(), disabledReason: 'target_scope_required' };
  }
  if (!LARK_APP_ID_PATTERN.test(targetLarkAppId) || !TASK_GUID_PATTERN.test(targetTaskGuid)) {
    return { flags: disabled(), disabledReason: 'target_scope_invalid' };
  }
  if (targetLarkAppId !== SCOPED_SHADOW_LARK_APP_ID || targetTaskGuid !== SCOPED_SHADOW_TASK_GUID) {
    return { flags: disabled(), disabledReason: 'target_scope_unauthorized' };
  }
  if (targetLarkAppId !== selfLarkAppId) {
    return { flags: disabled(), disabledReason: 'target_app_mismatch' };
  }
  if (!flags.ledgerEnabled || !flags.shadowEnabled || flags.pumpEnabled || flags.freezeEnforcement) {
    return { flags: disabled(), disabledReason: 'scoped_shadow_read_only_required' };
  }
  return { flags, shadowTaskGuid: targetTaskGuid };
}

/**
 * Production is opt-in. Mapping facts arrive only through the authenticated
 * controller route and are then signed/persisted by the daemon; no comma-list
 * environment value becomes a control-plane fact.
 */
export function productionTaskControlPlaneConfig(input: {
  larkAppId: string;
  env?: NodeJS.ProcessEnv;
}): ProductionTaskControlPlaneConfig {
  const env = input.env ?? process.env;
  const flags = taskControlPlaneFlags(env);
  const disabled = (disabledReason: string): ProductionTaskControlPlaneConfig => ({ flags: { ...DEFAULT_FLAGS }, disabledReason });
  const flagNames = ['TASK_CONTROL_PLANE_LEDGER_ENABLED', 'TASK_CONTROL_PLANE_SHADOW_ENABLED', 'TASK_CONTROL_PLANE_PUMP_ENABLED', 'TASK_CONTROL_PLANE_FREEZE_ENFORCEMENT'];
  if (flagNames.some(name => env[name] !== undefined && !/^(true|false)$/i.test(env[name]!.trim()))) return disabled('flag_value_invalid');
  if (!Object.values(flags).some(Boolean)) return { flags: { ...DEFAULT_FLAGS } };
  if (env.TASK_CONTROL_PLANE_PRODUCTION !== 'true') return disabled('production_mode_required');
  if (!flags.ledgerEnabled || flags.shadowEnabled) return disabled('production_ledger_required');
  const allowedKeyIds = parseKeyIdSet(env.TASK_CONTROL_PLANE_ALLOWED_KEY_IDS);
  const revokedKeyIds = parseKeyIdSet(env.TASK_CONTROL_PLANE_REVOKED_KEY_IDS);
  if ((env.TASK_CONTROL_PLANE_ALLOWED_KEY_IDS !== undefined && !allowedKeyIds)
    || (env.TASK_CONTROL_PLANE_REVOKED_KEY_IDS !== undefined && !revokedKeyIds)) return disabled('production_key_set_invalid');
  return { flags, allowedKeyIds, revokedKeyIds };
}

function validateFlags(flags: TaskControlPlaneFlags, hasDelivery: boolean, hasCollector: boolean): void {
  if (flags.shadowEnabled && !flags.ledgerEnabled) throw new TaskControlPlaneFlagError('shadow_requires_ledger');
  if (flags.shadowEnabled && !hasCollector) throw new TaskControlPlaneFlagError('shadow_collector_required');
  if (flags.freezeEnforcement && !flags.ledgerEnabled) throw new TaskControlPlaneFlagError('freeze_enforcement_requires_ledger');
  if (flags.pumpEnabled && !flags.ledgerEnabled) throw new TaskControlPlaneFlagError('pump_requires_ledger');
  if (flags.pumpEnabled && !hasDelivery) throw new TaskControlPlaneFlagError('pump_delivery_required');
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
            if (result.fallbackDestinationId) {
              this.store.degradeOutboxWithFallback({
                eventId: row.eventId, sourceDestinationId: row.destinationId, fallbackDestinationId: result.fallbackDestinationId,
                claimToken: token, error: result.error ?? 'delivery_retry_exhausted', now: this.options.now(),
              });
              continue;
            }
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
      // Production reuses the same bounded read-only collector; a supplied
      // collector never writes an external object by itself.
      collect: options.collect,
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

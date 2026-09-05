import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  AuthenticatedTaskControlPrincipal,
  TaskControlAuthority,
  VerifiedTaskControlApproval,
} from './task-control-plane-store.js';

/**
 * Opaque, daemon-minted authentication handle.  Its private symbol payload is
 * intentionally unreachable to callers, so no event adapter can choose the
 * actor or role written to the ledger.
 */
const daemonAuthenticationBrand: unique symbol = Symbol('daemon-task-control-authentication');
export interface TaskControlAuthentication {
  readonly [daemonAuthenticationBrand]: true;
}

/** A signed durable-gate observation after the daemon has verified its source. */
export interface TaskControlApprovalObservation {
  keyId: string;
  approvalRef: string;
  projectId: string;
  phaseId: string;
  taskSetSnapshot: readonly string[];
  acceptorId: string;
  approvedAt: string;
  expiresAt: string;
  signature: string;
}

interface DaemonAuthorityInput {
  /** Resolve the current daemon-owned session/generation/capability principal. */
  resolvePrincipal(authenticationId: string): AuthenticatedTaskControlPrincipal | undefined;
  /** Fixed daemon-owned verification keys, selected only by a known key id. */
  approvalKeys: ReadonlyMap<string, Buffer | string>;
  now?: () => number;
}

interface StoredAuthentication {
  authenticationId: string;
  principal?: AuthenticatedTaskControlPrincipal;
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function canonicalTaskSet(value: readonly string[]): string[] {
  const set = new Set<string>();
  for (const taskGuid of value) {
    const normalized = nonBlank(taskGuid);
    if (!normalized) throw new Error('task_control_approval_task_set_invalid');
    set.add(normalized);
  }
  return [...set].sort();
}

function approvalMaterial(input: Omit<TaskControlApprovalObservation, 'signature'>): string {
  return JSON.stringify({
    keyId: input.keyId,
    approvalRef: input.approvalRef,
    projectId: input.projectId,
    phaseId: input.phaseId,
    taskSetSnapshot: canonicalTaskSet(input.taskSetSnapshot),
    acceptorId: input.acceptorId,
    approvedAt: input.approvedAt,
    expiresAt: input.expiresAt,
  });
}

function signatureFor(key: Buffer | string, input: Omit<TaskControlApprovalObservation, 'signature'>): Buffer {
  return createHmac('sha256', key).update(approvalMaterial(input)).digest();
}

function sameSignature(actual: string, expected: Buffer): boolean {
  if (!/^[0-9a-f]{64}$/i.test(actual)) return false;
  const supplied = Buffer.from(actual, 'hex');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/**
 * Daemon-owned trust adapter used by the default-off task-control runtime.
 * Authentication and approval proofs are opaque capabilities, accepted only
 * after a final liveness/expiry/domain check.  Approval references are consumed
 * before returning success, making replay fail closed.
 */
export class DaemonTaskControlAuthority implements TaskControlAuthority {
  private readonly authentications = new WeakMap<object, StoredAuthentication>();

  constructor(private readonly input: DaemonAuthorityInput) {}

  issueAuthentication(authenticationIdInput: string): TaskControlAuthentication | undefined {
    const authenticationId = nonBlank(authenticationIdInput);
    const principal = authenticationId ? this.input.resolvePrincipal(authenticationId) : undefined;
    if (!authenticationId || !principal || !nonBlank(principal.actorId)) return undefined;
    const token = Object.freeze({
      [daemonAuthenticationBrand]: true,
    }) as TaskControlAuthentication;
    this.authentications.set(token, { authenticationId });
    return token;
  }

  /**
   * Internal daemon bridge capability.  No user-facing IPC accepts this token
   * or its principal fields; event adapters receive only the opaque token.
   */
  issueBridgePrincipal(principal: AuthenticatedTaskControlPrincipal): TaskControlAuthentication | undefined {
    const actorId = nonBlank(principal.actorId);
    if (!actorId || !['controller', 'worker', 'reviewer', 'collector', 'acceptor'].includes(principal.actorRole)) {
      return undefined;
    }
    const token = Object.freeze({ [daemonAuthenticationBrand]: true }) as TaskControlAuthentication;
    this.authentications.set(token, { authenticationId: `bridge:${actorId}`, principal: { actorId, actorRole: principal.actorRole } });
    return token;
  }

  authenticate(authentication: unknown): AuthenticatedTaskControlPrincipal | undefined {
    if (!authentication || typeof authentication !== 'object') return undefined;
    const stored = this.authentications.get(authentication);
    if (stored?.principal) return { ...stored.principal };
    const principal = stored ? this.input.resolvePrincipal(stored.authenticationId) : undefined;
    return principal ? { ...principal } : undefined;
  }

  verifyApproval(input: {
    approval: unknown;
    projectId: string;
    phaseId: string;
    taskSetSnapshot: readonly string[];
    acceptorId: string;
    now: string;
  }): VerifiedTaskControlApproval | undefined {
    const proof = input.approval;
    if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return undefined;
    const raw = proof as Partial<TaskControlApprovalObservation>;
    const approvalRef = nonBlank(raw.approvalRef);
    const projectId = nonBlank(raw.projectId);
    const phaseId = nonBlank(raw.phaseId);
    const acceptorId = nonBlank(raw.acceptorId);
    const approvedAt = nonBlank(raw.approvedAt);
    const expiresAt = nonBlank(raw.expiresAt);
    const keyId = nonBlank(raw.keyId);
    if (!keyId || !approvalRef || !projectId || !phaseId || !acceptorId || !approvedAt || !expiresAt
      || typeof raw.signature !== 'string' || !Array.isArray(raw.taskSetSnapshot)) return undefined;
    let taskSetSnapshot: string[];
    let now: number;
    try {
      taskSetSnapshot = canonicalTaskSet(raw.taskSetSnapshot);
      now = Date.parse(input.now);
    } catch { return undefined; }
    const approvedAtMs = Date.parse(approvedAt);
    const expiresAtMs = Date.parse(expiresAt);
    const key = this.input.approvalKeys.get(keyId);
    if (!key || !Number.isFinite(now) || !Number.isFinite(approvedAtMs) || !Number.isFinite(expiresAtMs)
      || approvedAtMs > now || expiresAtMs <= now || expiresAtMs <= approvedAtMs
      || projectId !== input.projectId
      || phaseId !== input.phaseId
      || acceptorId !== input.acceptorId
      || JSON.stringify(taskSetSnapshot) !== JSON.stringify(canonicalTaskSet(input.taskSetSnapshot))) return undefined;
    const unsigned = { keyId, approvalRef, projectId, phaseId, taskSetSnapshot, acceptorId, approvedAt, expiresAt };
    if (!sameSignature(raw.signature, signatureFor(key, unsigned))) return undefined;
    return { ...unsigned };
  }
}

/** Test/daemon helper: signs the normalized proof payload without exposing the verifier key through a receipt. */
export function signTaskControlApproval(
  key: Buffer | string,
  input: Omit<TaskControlApprovalObservation, 'signature'>,
): TaskControlApprovalObservation {
  const normalized = { ...input, taskSetSnapshot: canonicalTaskSet(input.taskSetSnapshot) };
  return { ...normalized, signature: signatureFor(key, normalized).toString('hex') };
}

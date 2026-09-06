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

/**
 * A v3 humanGate resolution after its wait file and journal have been verified
 * by the daemon. This is source material only: it is never accepted from IPC
 * and becomes an opaque one-shot verifier handle below.
 */
export interface VerifiedTaskControlGateResolution {
  approvalRef: string;
  projectId: string;
  phaseId: string;
  taskSetSnapshot: readonly string[];
  acceptorId: string;
  approvedAt: string;
  expiresAt: string;
  runId: string;
  nodeId: string;
  instanceId: string;
  waitId: string;
  operatorId: string;
}

interface DaemonAuthorityInput {
  /** Resolve the current daemon-owned session/generation/capability principal. */
  resolvePrincipal(authenticationId: string): AuthenticatedTaskControlPrincipal | undefined;
  now?: () => number;
}

interface StoredAuthentication {
  authenticationId: string;
  principal?: AuthenticatedTaskControlPrincipal;
}

interface StoredApproval {
  approval: VerifiedTaskControlApproval;
}

export interface VerifiedWriteExecutionGrant {
  grantRef: string;
  projectId: string;
  phaseId: string;
  taskGuid: string;
  candidate: string;
  action: string;
  attempt: number;
  operatorId: string;
  issuedAt: string;
  expiresAt: string;
}

interface StoredWriteExecutionGrant {
  grant: VerifiedWriteExecutionGrant;
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

/**
 * Daemon-owned trust adapter used by the default-off task-control runtime.
 * Authentication and approval proofs are opaque capabilities. A v3 durable
 * wait+journal adapter is the only production path that can mint an approval
 * handle; a transport HMAC, request body, or deserialized proof has no value.
 */
export class DaemonTaskControlAuthority implements TaskControlAuthority {
  private readonly authentications = new WeakMap<object, StoredAuthentication>();
  private readonly approvals = new WeakMap<object, StoredApproval>();
  private readonly writeExecutionGrants = new WeakMap<object, StoredWriteExecutionGrant>();

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

  /**
   * Mint an opaque verifier handle only after the bridge has independently
   * checked a v3 durable humanGate resolution. The extra provenance fields are
   * intentionally not persisted in the ledger payload, but their presence here
   * prevents a generic signed JSON blob from becoming a phase approval.
   */
  issueVerifiedGateApproval(source: VerifiedTaskControlGateResolution): unknown | undefined {
    const approvalRef = nonBlank(source.approvalRef);
    const projectId = nonBlank(source.projectId);
    const phaseId = nonBlank(source.phaseId);
    const acceptorId = nonBlank(source.acceptorId);
    const approvedAt = nonBlank(source.approvedAt);
    const expiresAt = nonBlank(source.expiresAt);
    if (!approvalRef || !projectId || !phaseId || !acceptorId || !approvedAt || !expiresAt
      || !nonBlank(source.runId) || !nonBlank(source.nodeId) || !nonBlank(source.instanceId)
      || !nonBlank(source.waitId) || !nonBlank(source.operatorId)) return undefined;
    let taskSetSnapshot: string[];
    try { taskSetSnapshot = canonicalTaskSet(source.taskSetSnapshot); } catch { return undefined; }
    const approvedAtMs = Date.parse(approvedAt);
    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(approvedAtMs) || !Number.isFinite(expiresAtMs) || expiresAtMs <= approvedAtMs) return undefined;
    const token = Object.freeze({}) as object;
    this.approvals.set(token, { approval: {
      approvalRef, projectId, phaseId, taskSetSnapshot, acceptorId, approvedAt, expiresAt,
    } });
    return token;
  }

  /** An opaque daemon-only capability for one exact write execution. */
  issueVerifiedWriteExecutionGrant(source: VerifiedWriteExecutionGrant): unknown | undefined {
    const fields = [source.grantRef, source.projectId, source.phaseId, source.taskGuid, source.candidate, source.action, source.operatorId, source.issuedAt, source.expiresAt];
    if (fields.some(value => !nonBlank(value)) || !Number.isSafeInteger(source.attempt) || source.attempt < 1
      || !Number.isFinite(Date.parse(source.issuedAt)) || !Number.isFinite(Date.parse(source.expiresAt))
      || Date.parse(source.expiresAt) <= Date.parse(source.issuedAt)) return undefined;
    const token = Object.freeze({}) as object;
    this.writeExecutionGrants.set(token, { grant: { ...source } });
    return token;
  }

  verifyWriteExecutionGrant(input: {
    grant: unknown; projectId: string; phaseId: string; taskGuid: string; candidate: string; action: string; attempt: number; operatorId: string; now: string;
  }): VerifiedWriteExecutionGrant | undefined {
    if (!input.grant || typeof input.grant !== 'object') return undefined;
    const stored = this.writeExecutionGrants.get(input.grant);
    const grant = stored?.grant;
    const now = Date.parse(input.now);
    if (!grant || !Number.isFinite(now) || Date.parse(grant.expiresAt) <= now
      || grant.projectId !== input.projectId || grant.phaseId !== input.phaseId || grant.taskGuid !== input.taskGuid
      || grant.candidate !== input.candidate || grant.action !== input.action || grant.attempt !== input.attempt
      || grant.operatorId !== input.operatorId) return undefined;
    return { ...grant };
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
    if (!input.approval || typeof input.approval !== 'object') return undefined;
    const stored = this.approvals.get(input.approval);
    if (!stored) return undefined;
    const proof = stored.approval;
    let expectedTaskSet: string[];
    let now: number;
    try {
      expectedTaskSet = canonicalTaskSet(input.taskSetSnapshot);
      now = Date.parse(input.now);
    } catch { return undefined; }
    const approvedAtMs = Date.parse(proof.approvedAt);
    const expiresAtMs = Date.parse(proof.expiresAt);
    if (!Number.isFinite(now) || !Number.isFinite(approvedAtMs) || !Number.isFinite(expiresAtMs)
      || approvedAtMs > now || expiresAtMs <= now || expiresAtMs <= approvedAtMs
      || proof.projectId !== input.projectId
      || proof.phaseId !== input.phaseId
      || proof.acceptorId !== input.acceptorId
      || JSON.stringify(proof.taskSetSnapshot) !== JSON.stringify(expectedTaskSet)) return undefined;
    return { ...proof, taskSetSnapshot: [...proof.taskSetSnapshot] };
  }
}

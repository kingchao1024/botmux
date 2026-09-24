import { createHash, timingSafeEqual } from 'node:crypto';
import type { AuthenticatedTaskControlPrincipal, TrustedTaskControlMappingRecord } from './task-control-plane-store.js';
import {
  type TaskControlAuthentication,
  DaemonTaskControlAuthority,
  type VerifiedTaskControlGateResolution,
  type VerifiedWriteExecutionGrant,
} from './task-control-plane-authority.js';
import type { TaskControlEventObservation } from './task-control-plane-events.js';
import { taskControlMappingFacts, type TaskControlMappingProof } from './task-control-plane-mapping-trust.js';

export interface DaemonTaskControlMapping {
  controllerId: string;
  projectId: string;
  phaseId: string;
  phaseTaskGuids: readonly string[];
  taskGuid: string;
  topicRootId: string;
  ownerId: string;
  reviewerId: string;
  acceptorId: string;
  /** The controller-owned registration reference, never a task title or body. */
  registrationRef: string;
  registrationVersion?: string;
  phaseRegistrationRefs?: Record<string, string>;
  /** Exact durable v3 humanGate that may authorize phase freeze. */
  approvalGate: TaskControlApprovalGateBinding;
  docToken?: string;
  docRevision?: number;
  /** Controller-issued, app/purpose-scoped proof; never sourced from worker payload. */
  mappingProof?: TaskControlMappingProof;
}

export interface TaskControlApprovalGateBinding {
  approvalRef: string;
  runId: string;
  nodeId: string;
  instanceId: string;
  waitId: string;
  operatorId: string;
  /** Sorted snapshot from the authorized DAG, not caller-selected at freeze. */
  approverPolicy: readonly string[];
}

export type TaskControlApprovalGateRegistration = Omit<TaskControlApprovalGateBinding, 'approvalRef'>;
export type DaemonTaskControlMappingRegistration = Omit<DaemonTaskControlMapping, 'controllerId' | 'approvalGate'> & {
  approvalGate: TaskControlApprovalGateRegistration;
};

export interface TaskControlProductionMappingVerifier {
  readonly minimumTaskCount: number;
  verifyMapping(proof: TaskControlMappingProof | undefined, facts: Record<string, unknown>): boolean;
}

export interface DaemonTaskControlApprovalSource {
  validateBinding(input: { larkAppId: string; gate: TaskControlApprovalGateRegistration }): boolean;
  get(input: {
    approvalRef: string;
    larkAppId: string;
    gate: TaskControlApprovalGateBinding;
  }): Omit<VerifiedTaskControlGateResolution,
    'approvalRef' | 'projectId' | 'phaseId' | 'taskSetSnapshot' | 'acceptorId'> | undefined;
  /** Durable human authorization for one exact write; absent means fail closed. */
  getWriteExecution?(input: {
    grantRef: string; larkAppId: string; projectId: string; phaseId: string; taskGuid: string; candidate: string; action: string; attempt: number; operatorId: string;
    gate: TaskControlApprovalGateBinding;
  }): Pick<VerifiedWriteExecutionGrant, 'issuedAt' | 'expiresAt'> | undefined;
}

export type TaskControlBridgeEvent = Omit<TaskControlEventObservation, 'authentication' | 'projectId' | 'phaseId' | 'taskGuid' | 'topicRootId'> & {
  dispatchRoot: string;
  principal: 'controller' | 'worker' | 'reviewer' | 'acceptor' | 'collector';
};

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function sameId(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Daemon-owned bridge from independently registered project bindings and live
 * session principals into the narrow control-plane types. It intentionally has
 * no parser for titles, reports, task state, or message body. A source that
 * cannot prove a binding or principal yields undefined and callers must emit
 * UNKNOWN rather than manufacture an advancing event.
 */
export class DaemonTaskControlBridge {
  readonly authority: DaemonTaskControlAuthority;
  private readonly mappings = new Map<string, DaemonTaskControlMapping>();
  private readonly principals = new Map<string, AuthenticatedTaskControlPrincipal>();

  constructor(private readonly input: {
    approvals: DaemonTaskControlApprovalSource;
    larkAppId: string;
    productionMapping?: TaskControlProductionMappingVerifier;
    now?: () => number;
  }) {
    this.authority = new DaemonTaskControlAuthority({
      resolvePrincipal: authenticationId => this.principals.get(authenticationId),
      now: input.now,
    });
  }

  restoreMapping(record: TrustedTaskControlMappingRecord): boolean {
    return this.registerMapping(record.dispatchRoot, {
      controllerId: record.controllerId, projectId: record.projectId, phaseId: record.phaseId, phaseTaskGuids: record.phaseTaskGuids,
      taskGuid: record.taskGuid, topicRootId: record.topicRootId, ownerId: record.ownerId,
      reviewerId: record.reviewerId, acceptorId: record.acceptorId, registrationRef: record.registrationRef, ...(record.registrationVersion ? { registrationVersion: record.registrationVersion } : {}),
      ...(record.phaseRegistrationRefs ? { phaseRegistrationRefs: record.phaseRegistrationRefs } : {}),
      approvalGate: record.approvalGate,
      ...(record.docToken ? { docToken: record.docToken } : {}),
      ...(record.docRevision ? { docRevision: record.docRevision } : {}),
      ...(record.mappingProof ? { mappingProof: record.mappingProof } : {}),
    }, record.controllerId);
  }

  registerMapping(dispatchRoot: string, mapping: DaemonTaskControlMapping, controllerId: string): boolean {
    const root = nonBlank(dispatchRoot);
    const controller = nonBlank(controllerId);
    if (!root || !controller || !/^om_[A-Za-z0-9_-]{1,128}$/.test(root)) return false;
    const fields = [
      mapping.controllerId, mapping.projectId, mapping.phaseId, mapping.taskGuid, mapping.topicRootId, mapping.ownerId,
      mapping.reviewerId, mapping.acceptorId, mapping.registrationRef, mapping.approvalGate?.runId, mapping.approvalGate?.nodeId,
      mapping.approvalGate?.instanceId, mapping.approvalGate?.waitId, mapping.approvalGate?.operatorId,
    ];
    if (fields.some(field => !nonBlank(field)) || mapping.topicRootId !== root
      || mapping.ownerId === mapping.reviewerId || mapping.reviewerId === mapping.acceptorId
      || mapping.ownerId === mapping.acceptorId
      || !Array.isArray(mapping.phaseTaskGuids)
      || !mapping.phaseTaskGuids.every(taskGuid => !!nonBlank(taskGuid))
      || new Set(mapping.phaseTaskGuids).size !== mapping.phaseTaskGuids.length
      || !mapping.phaseTaskGuids.includes(mapping.taskGuid)
      || !Array.isArray(mapping.approvalGate?.approverPolicy)
      || !mapping.approvalGate.approverPolicy.every(approver => !!nonBlank(approver))
      || mapping.approvalGate.operatorId !== mapping.acceptorId
      || !this.input.approvals.validateBinding({
        larkAppId: this.input.larkAppId,
        gate: {
          runId: mapping.approvalGate.runId, nodeId: mapping.approvalGate.nodeId,
          instanceId: mapping.approvalGate.instanceId, waitId: mapping.approvalGate.waitId,
          operatorId: mapping.approvalGate.operatorId, approverPolicy: mapping.approvalGate.approverPolicy,
        },
      })) return false;
    const production = this.input.productionMapping;
    if (production && (mapping.phaseTaskGuids.length < production.minimumTaskCount
      || !production.verifyMapping(mapping.mappingProof, taskControlMappingFacts({
        dispatchRoot: root, projectId: mapping.projectId, phaseId: mapping.phaseId, phaseTaskGuids: mapping.phaseTaskGuids,
        taskGuid: mapping.taskGuid, topicRootId: mapping.topicRootId, ownerId: mapping.ownerId, reviewerId: mapping.reviewerId,
        acceptorId: mapping.acceptorId, registrationRef: mapping.registrationRef, registrationVersion: mapping.registrationVersion, controllerId: controller,
        ...(mapping.phaseRegistrationRefs ? { phaseRegistrationRefs: mapping.phaseRegistrationRefs } : {}), approvalGate: mapping.approvalGate, docToken: mapping.docToken, docRevision: mapping.docRevision,
      })))) return false;
    const prior = this.mappings.get(root);
    if (prior && JSON.stringify(prior) !== JSON.stringify(mapping)) return false;
    this.mappings.set(root, {
      ...mapping, controllerId: controller, phaseTaskGuids: [...new Set(mapping.phaseTaskGuids)].sort(),
      approvalGate: { ...mapping.approvalGate, approverPolicy: [...new Set(mapping.approvalGate.approverPolicy)].sort() },
    });
    const register = (kind: TaskControlBridgeEvent['principal'], actorId: string, actorRole: AuthenticatedTaskControlPrincipal['actorRole']): void => {
      this.principals.set(`${root}:${kind}`, { actorId, actorRole });
    };
    register('controller', controller, 'controller');
    register('worker', mapping.ownerId, 'worker');
    register('reviewer', mapping.reviewerId, 'reviewer');
    register('acceptor', mapping.acceptorId, 'acceptor');
    register('collector', `collector:${root}`, 'collector');
    return true;
  }

  mapping(dispatchRoot: string): DaemonTaskControlMapping | undefined {
    const mapping = this.mappings.get(dispatchRoot);
    return mapping ? { ...mapping } : undefined;
  }

  removeMapping(dispatchRoot: string): void {
    this.mappings.delete(dispatchRoot);
    for (const principal of ['controller', 'worker', 'reviewer', 'acceptor', 'collector'] as const) {
      this.principals.delete(`${dispatchRoot}:${principal}`);
    }
  }

  listMappings(): Array<{ dispatchRoot: string; mapping: DaemonTaskControlMapping }> {
    return [...this.mappings.entries()].map(([dispatchRoot, mapping]) => ({ dispatchRoot, mapping: { ...mapping } }));
  }

  issueAuthentication(dispatchRoot: string, principal: TaskControlBridgeEvent['principal']): TaskControlAuthentication | undefined {
    const stored = this.principals.get(`${dispatchRoot}:${principal}`);
    return stored ? this.authority.issueBridgePrincipal(stored) : undefined;
  }

  /**
   * The controller registers this only after a signed designation has been
   * verified and persisted. Reviewer open IDs are app-scoped, so the initial
   * mapping principal cannot be reused after the reviewer daemon resolved the
   * source in its own app domain.
   */
  setDesignatedReviewerPrincipal(dispatchRoot: string, reviewerId: string): boolean {
    const mapping = this.mappings.get(dispatchRoot);
    const actorId = nonBlank(reviewerId);
    if (!mapping || !actorId) return false;
    this.principals.set(`${dispatchRoot}:reviewer`, { actorId, actorRole: 'reviewer' });
    return true;
  }

  event(input: TaskControlBridgeEvent): TaskControlEventObservation | undefined {
    const mapping = this.mappings.get(input.dispatchRoot);
    const authentication = this.issueAuthentication(input.dispatchRoot, input.principal);
    if (!mapping || !authentication || !nonBlank(input.eventId) || !nonBlank(input.idempotencyKey)
      || !nonBlank(input.sourceRef) || !nonBlank(mapping.registrationRef)) return undefined;
    return {
      eventId: input.eventId,
      idempotencyKey: input.idempotencyKey,
      sourceRef: input.sourceRef,
      payload: input.payload,
      evidenceRef: input.evidenceRef,
      authentication,
      projectId: mapping.projectId,
      phaseId: mapping.phaseId,
      taskGuid: mapping.taskGuid,
      topicRootId: mapping.topicRootId,
    };
  }

  /**
   * P2 approval adapter: the caller supplies only a stable v3 gate reference.
   * The daemon verifies its wait+journal evidence and mints an opaque proof
   * bound to this exact mapping; a request body or host HMAC cannot become a
   * phase approval. The store rechecks exact binding and consumes it atomically.
   */
  approval(dispatchRoot: string, approvalRef: string): unknown | undefined {
    const mapping = this.mappings.get(dispatchRoot);
    const ref = nonBlank(approvalRef);
    if (!mapping || !ref || !sameId(ref, mapping.approvalGate.approvalRef)) return undefined;
    const source = this.input.approvals.get({ approvalRef: ref, larkAppId: this.input.larkAppId, gate: mapping.approvalGate });
    if (!source
      || !sameId(source.runId, mapping.approvalGate.runId)
      || !sameId(source.nodeId, mapping.approvalGate.nodeId)
      || !sameId(source.instanceId, mapping.approvalGate.instanceId)
      || !sameId(source.waitId, mapping.approvalGate.waitId)
      || !sameId(source.operatorId, mapping.approvalGate.operatorId)) return undefined;
    return this.authority.issueVerifiedGateApproval({
      ...source, approvalRef: ref, projectId: mapping.projectId, phaseId: mapping.phaseId,
      taskSetSnapshot: mapping.phaseTaskGuids, acceptorId: mapping.acceptorId,
    });
  }

  /** Explicit daemon-only write authority; no dispatch brief or report text is parsed. */
  issueWriteExecutionGrant(input: Omit<VerifiedWriteExecutionGrant, 'issuedAt' | 'expiresAt'> & { dispatchRoot: string }): unknown | undefined {
    const mapping = this.mappings.get(input.dispatchRoot);
    if (!mapping || mapping.projectId !== input.projectId || mapping.phaseId !== input.phaseId || mapping.taskGuid !== input.taskGuid
      || mapping.acceptorId !== input.operatorId || !nonBlank(input.candidate) || !nonBlank(input.action)
      || !Number.isSafeInteger(input.attempt) || input.attempt < 1) return undefined;
    const source = this.input.approvals.getWriteExecution?.({
      grantRef: input.grantRef, larkAppId: this.input.larkAppId, projectId: input.projectId, phaseId: input.phaseId, taskGuid: input.taskGuid,
      candidate: input.candidate, action: input.action, attempt: input.attempt, operatorId: input.operatorId,
      gate: mapping.approvalGate,
    });
    if (!source) return undefined;
    return this.authority.issueVerifiedWriteExecutionGrant({
      grantRef: input.grantRef, projectId: input.projectId, phaseId: input.phaseId, taskGuid: input.taskGuid,
      candidate: input.candidate, action: input.action, attempt: input.attempt, operatorId: input.operatorId,
      issuedAt: source.issuedAt, expiresAt: source.expiresAt,
    });
  }

  static bindApprovalGate(gate: TaskControlApprovalGateRegistration): TaskControlApprovalGateBinding {
    const material = [gate.runId, gate.nodeId, gate.instanceId, gate.waitId, gate.operatorId,
      ...[...new Set(gate.approverPolicy)].sort()].join('\0');
    return {
      ...gate,
      approvalRef: `approval:gate-${createHash('sha256').update(material).digest('hex').slice(0, 48)}`,
      approverPolicy: [...new Set(gate.approverPolicy)].sort(),
    };
  }

  /** Stable payload-safe identifier for references captured from a daemon source. */
  static observationId(kind: string, sourceRef: string): string {
    return `tcp-observation:${kind}:${createHash('sha256').update(sourceRef).digest('hex').slice(0, 32)}`;
  }
}

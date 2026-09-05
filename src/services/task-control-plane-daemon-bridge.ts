import { createHash, timingSafeEqual } from 'node:crypto';
import type { AuthenticatedTaskControlPrincipal, TrustedTaskControlMappingRecord } from './task-control-plane-store.js';
import {
  type TaskControlApprovalObservation,
  type TaskControlAuthentication,
  DaemonTaskControlAuthority,
} from './task-control-plane-authority.js';
import type { TaskControlEventObservation } from './task-control-plane-events.js';

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
  docToken?: string;
}

export interface DaemonTaskControlApprovalSource {
  get(approvalRef: string): TaskControlApprovalObservation | undefined;
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
    approvalKeys: ReadonlyMap<string, Buffer | string>;
    now?: () => number;
  }) {
    this.authority = new DaemonTaskControlAuthority({
      resolvePrincipal: authenticationId => this.principals.get(authenticationId),
      approvalKeys: input.approvalKeys,
      now: input.now,
    });
  }

  restoreMapping(record: TrustedTaskControlMappingRecord): boolean {
    return this.registerMapping(record.dispatchRoot, {
      controllerId: record.controllerId, projectId: record.projectId, phaseId: record.phaseId, phaseTaskGuids: record.phaseTaskGuids,
      taskGuid: record.taskGuid, topicRootId: record.topicRootId, ownerId: record.ownerId,
      reviewerId: record.reviewerId, acceptorId: record.acceptorId, registrationRef: record.registrationRef,
      ...(record.docToken ? { docToken: record.docToken } : {}),
    }, record.controllerId);
  }

  registerMapping(dispatchRoot: string, mapping: DaemonTaskControlMapping, controllerId: string): boolean {
    const root = nonBlank(dispatchRoot);
    const controller = nonBlank(controllerId);
    if (!root || !controller || !/^om_[A-Za-z0-9_-]{1,128}$/.test(root)) return false;
    const fields = [
      mapping.controllerId, mapping.projectId, mapping.phaseId, mapping.taskGuid, mapping.topicRootId, mapping.ownerId,
      mapping.reviewerId, mapping.acceptorId, mapping.registrationRef,
    ];
    if (fields.some(field => !nonBlank(field)) || mapping.topicRootId !== root
      || mapping.ownerId === mapping.reviewerId || mapping.reviewerId === mapping.acceptorId
      || mapping.ownerId === mapping.acceptorId
      || !Array.isArray(mapping.phaseTaskGuids)
      || !mapping.phaseTaskGuids.every(taskGuid => !!nonBlank(taskGuid))
      || !mapping.phaseTaskGuids.includes(mapping.taskGuid)) return false;
    const prior = this.mappings.get(root);
    if (prior && JSON.stringify(prior) !== JSON.stringify(mapping)) return false;
    this.mappings.set(root, { ...mapping, controllerId: controller, phaseTaskGuids: [...new Set(mapping.phaseTaskGuids)].sort() });
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
   * P2 approval adapter: the caller selects a stable approval reference, but
   * the signed material comes only from the daemon-owned durable source. The
   * verifier re-checks exact phase/task/acceptor binding when freeze is tried.
   */
  approval(approvalRef: string): TaskControlApprovalObservation | undefined {
    const ref = nonBlank(approvalRef);
    if (!ref) return undefined;
    const proof = this.input.approvals.get(ref);
    if (!proof || !sameId(proof.approvalRef, ref)) return undefined;
    return { ...proof, taskSetSnapshot: [...proof.taskSetSnapshot] };
  }

  /** Stable payload-safe identifier for references captured from a daemon source. */
  static observationId(kind: string, sourceRef: string): string {
    return `tcp-observation:${kind}:${createHash('sha256').update(sourceRef).digest('hex').slice(0, 32)}`;
  }
}

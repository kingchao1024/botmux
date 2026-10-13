import { createHash, randomUUID } from 'node:crypto';
import type { RepositoryIdentity } from './git-worktree.js';
import {
  mutateRepositoryControlState,
  normalizeRepositoryReleaseSnapshot,
  readRepositoryControlState,
  type RepositoryControlState,
  type RepositoryLeaseRef,
  type RepositoryReleaseBarrier,
  type RepositoryReleaseSnapshot,
  type RepositoryWriterLease,
} from './repository-control-store.js';

export type {
  RepositoryControlState,
  RepositoryLeaseRef,
  RepositoryReleaseSnapshot,
  RepositoryWriterLease,
};
export interface RepositoryWriterOwner {
  chatId: string; dispatchRoot: string; taskGuid: string; controllerAppId: string;
  workerAppId: string; sessionId: string; workerGeneration: number;
  workingDir: string; declaredScopes: string[];
}
interface OperationBase { identity: RepositoryIdentity; operationId: string; now: string }
function hashInput(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}
function withOperation<R>(
  dataDir: string,
  input: OperationBase,
  apply: (state: RepositoryControlState, nextRevision: number) => R,
): R {
  if (!input.operationId || input.operationId.length > 256) throw new Error('repository_operation_id_invalid');
  const { now: _serverTime, ...stableInput } = input;
  const inputHash = hashInput(stableInput);
  return mutateRepositoryControlState(dataDir, input.identity, (state, nextRevision) => {
    const prior = state.operations[input.operationId];
    if (prior) {
      if (prior.inputHash !== inputHash) throw new Error('repository_operation_input_conflict');
      return { result: structuredClone(prior.result) as R };
    }
    const result = apply(state, nextRevision);
    state.operations[input.operationId] = { inputHash, result: structuredClone(result) };
    const operationIds = Object.keys(state.operations);
    for (const old of operationIds.slice(0, Math.max(0, operationIds.length - 256))) delete state.operations[old];
    state.updatedAt = input.now;
    return { next: state, result };
  });
}
function requireLease(state: RepositoryControlState, leaseId: string, fencingToken: number): RepositoryWriterLease {
  const lease = state.writerLease;
  if (!lease || lease.leaseId !== leaseId || lease.fencingToken !== fencingToken) {
    throw new Error('repository_lease_stale_token');
  }
  return lease;
}
export function readRepositoryControl(dataDir: string, identity: RepositoryIdentity): RepositoryControlState {
  return readRepositoryControlState(dataDir, identity);
}
export function acquireRepositoryWriter(
  dataDir: string,
  input: OperationBase & { owner: RepositoryWriterOwner },
): { revision: number; lease: RepositoryWriterLease; leaseRef: RepositoryLeaseRef } {
  return withOperation(dataDir, input, (state, nextRevision) => {
    if (state.releaseBarrier.state !== 'open') throw new Error('repository_barrier_blocks_writer');
    if (state.writerLease) throw new Error('repository_writer_conflict');
    const fencingToken = state.nextFencingToken;
    const lease: RepositoryWriterLease = {
      repoKey: input.identity.repoKey, leaseId: randomUUID(), fencingToken,
      operationId: input.operationId, ...input.owner,
      declaredScopes: [...input.owner.declaredScopes], acquiredAt: input.now,
      heartbeatAt: input.now, state: 'active',
    };
    state.writerLease = lease;
    state.nextFencingToken = fencingToken + 1;
    const leaseRef = { repoKey: lease.repoKey, leaseId: lease.leaseId,
      fencingToken: lease.fencingToken, workingDir: lease.workingDir };
    return { revision: nextRevision, lease, leaseRef };
  });
}
export function heartbeatRepositoryWriter(
  dataDir: string,
  input: OperationBase & { leaseId: string; fencingToken: number; sessionId: string; workerGeneration: number },
): { revision: number; lease: RepositoryWriterLease } {
  return withOperation(dataDir, input, (state, nextRevision) => {
    const lease = requireLease(state, input.leaseId, input.fencingToken);
    if (lease.sessionId !== input.sessionId || lease.workerGeneration !== input.workerGeneration) {
      throw new Error('repository_lease_generation_mismatch');
    }
    lease.heartbeatAt = input.now;
    return { revision: nextRevision, lease: structuredClone(lease) };
  });
}
export function bindRepositoryWriterGeneration(
  dataDir: string,
  input: OperationBase & { leaseId: string; fencingToken: number; dispatchRoot: string;
    workerAppId: string; workingDir: string; sessionId: string; workerGeneration: number },
): { revision: number; lease: RepositoryWriterLease } {
  return withOperation(dataDir, input, (state, nextRevision) => {
    const lease = requireLease(state, input.leaseId, input.fencingToken);
    if (lease.dispatchRoot !== input.dispatchRoot
        || lease.workerAppId !== input.workerAppId
        || lease.workingDir !== input.workingDir) {
      throw new Error('repository_lease_binding_mismatch');
    }
    if (!input.sessionId || !Number.isSafeInteger(input.workerGeneration) || input.workerGeneration < 1) {
      throw new Error('repository_lease_generation_invalid');
    }
    if (lease.generationBoundAt !== undefined) {
      throw new Error('repository_lease_generation_already_bound');
    }
    lease.sessionId = input.sessionId;
    lease.workerGeneration = input.workerGeneration;
    lease.generationBoundAt = input.now;
    lease.heartbeatAt = input.now;
    return { revision: nextRevision, lease: structuredClone(lease) };
  });
}

export function rebindRepositoryWriterDispatchRoot(
  dataDir: string,
  input: OperationBase & { leaseId: string; fencingToken: number; reservationId: string; dispatchRoot: string },
): { revision: number; lease: RepositoryWriterLease } {
  return withOperation(dataDir, input, (state, nextRevision) => {
    const lease = requireLease(state, input.leaseId, input.fencingToken);
    if (lease.dispatchRoot !== input.reservationId || lease.generationBoundAt !== undefined) {
      throw new Error('repository_lease_binding_mismatch');
    }
    if (!/^om_[A-Za-z0-9_-]{1,128}$/.test(input.dispatchRoot)) {
      throw new Error('repository_lease_dispatch_root_invalid');
    }
    lease.dispatchRoot = input.dispatchRoot;
    lease.heartbeatAt = input.now;
    return { revision: nextRevision, lease: structuredClone(lease) };
  });
}
export function releaseRepositoryWriter(
  dataDir: string,
  input: OperationBase & { leaseId: string; fencingToken: number },
): { revision: number; releasedLeaseId: string } {
  return withOperation(dataDir, input, (state, nextRevision) => {
    const lease = requireLease(state, input.leaseId, input.fencingToken);
    state.writerLease = null;
    return { revision: nextRevision, releasedLeaseId: lease.leaseId };
  });
}

export function recordRepositoryLeaseReconcileRequired(
  dataDir: string,
  input: OperationBase & { leaseId: string; fencingToken: number; reason: string },
): { revision: number; status: 'unknown'; leaseId: string; fencingToken: number; reason: string } {
  return withOperation(dataDir, input, (_state, nextRevision) => ({
    revision: nextRevision,
    status: 'unknown',
    leaseId: input.leaseId,
    fencingToken: input.fencingToken,
    reason: input.reason,
  }));
}
export function abandonRepositoryWriter(
  dataDir: string,
  input: OperationBase & { leaseId: string; fencingToken: number; sessionId: string;
    workerGeneration: number; terminationEvidence: Record<string, unknown> },
): { revision: number; abandonedLeaseId: string; terminationEvidence: Record<string, unknown> } {
  return withOperation(dataDir, input, (state, nextRevision) => {
    const lease = requireLease(state, input.leaseId, input.fencingToken);
    if (lease.sessionId !== input.sessionId || lease.workerGeneration !== input.workerGeneration) {
      throw new Error('repository_lease_generation_mismatch');
    }
    if (!input.terminationEvidence || Object.keys(input.terminationEvidence).length === 0) {
      throw new Error('repository_lease_termination_evidence_required');
    }
    state.writerLease = null;
    return { revision: nextRevision, abandonedLeaseId: lease.leaseId,
      terminationEvidence: structuredClone(input.terminationEvidence) };
  });
}
export function beginRepositoryFreeze(
  dataDir: string,
  input: OperationBase & { barrierId: string; authorizationRef: string;
    expectedRevision?: number; snapshot?: Record<string, unknown> },
): { revision: number; barrier: RepositoryReleaseBarrier } {
  return withOperation(dataDir, input, (state, nextRevision) => {
    if (input.expectedRevision !== undefined && state.revision !== input.expectedRevision) {
      throw new Error('repository_revision_conflict');
    }
    if (state.releaseBarrier.state !== 'open') throw new Error('repository_barrier_transition_invalid');
    state.releaseBarrier = { state: 'draining', barrierId: input.barrierId,
      authorizationRef: input.authorizationRef,
      ...(input.snapshot
        ? { snapshot: normalizeRepositoryReleaseSnapshot(input.snapshot, input.identity) }
        : {}),
      updatedAt: input.now };
    return { revision: nextRevision, barrier: structuredClone(state.releaseBarrier) };
  });
}

export function releaseRepositoryBarrier(
  dataDir: string,
  input: OperationBase & { barrierId: string; expectedRevision: number; authorizationRef: string },
): { revision: number; barrier: RepositoryReleaseBarrier } {
  return withOperation(dataDir, input, (state, nextRevision) => {
    if (state.revision !== input.expectedRevision) throw new Error('repository_revision_conflict');
    if (state.releaseBarrier.state !== 'released'
        || state.releaseBarrier.barrierId !== input.barrierId
        || state.releaseBarrier.authorizationRef !== input.authorizationRef) {
      throw new Error('repository_barrier_transition_invalid');
    }
    state.releaseBarrier = { state: 'open', updatedAt: input.now };
    return { revision: nextRevision, barrier: structuredClone(state.releaseBarrier) };
  });
}
export function finalizeRepositoryFreeze(
  dataDir: string,
  input: OperationBase & { barrierId: string; expectedRevision: number;
    snapshot: Record<string, unknown> | RepositoryReleaseSnapshot },
): { revision: number; barrier: RepositoryReleaseBarrier } {
  return withOperation(dataDir, input, (state, nextRevision) => {
    if (state.revision !== input.expectedRevision) throw new Error('repository_revision_conflict');
    if (state.releaseBarrier.state !== 'draining' || state.releaseBarrier.barrierId !== input.barrierId) {
      throw new Error('repository_barrier_transition_invalid');
    }
    if (state.writerLease) throw new Error('repository_writer_still_active');
    const snapshot = normalizeRepositoryReleaseSnapshot(input.snapshot, input.identity);
    state.releaseBarrier = { ...state.releaseBarrier, state: 'frozen',
      snapshot, updatedAt: input.now };
    return { revision: nextRevision, barrier: structuredClone(state.releaseBarrier) };
  });
}
export function cancelRepositoryFreeze(
  dataDir: string,
  input: OperationBase & { barrierId: string; expectedRevision: number; authorizationRef: string },
): { revision: number; barrier: RepositoryReleaseBarrier } {
  return withOperation(dataDir, input, (state, nextRevision) => {
    if (state.revision !== input.expectedRevision) throw new Error('repository_revision_conflict');
    if (!['draining', 'frozen'].includes(state.releaseBarrier.state)
        || state.releaseBarrier.barrierId !== input.barrierId) throw new Error('repository_barrier_transition_invalid');
    if (state.releaseBarrier.authorizationRef !== input.authorizationRef) {
      throw new Error('repository_barrier_authorization_mismatch');
    }
    if (state.writerLease) throw new Error('repository_writer_still_active');
    state.releaseBarrier = { state: 'open', updatedAt: input.now };
    return { revision: nextRevision, barrier: structuredClone(state.releaseBarrier) };
  });
}
export function beginRepositoryTransaction(
  dataDir: string,
  input: OperationBase & { barrierId: string; expectedRevision: number; transactionId: string },
): { revision: number; barrier: RepositoryReleaseBarrier } {
  return withOperation(dataDir, input, (state, nextRevision) => {
    if (state.revision !== input.expectedRevision) throw new Error('repository_revision_conflict');
    if (state.releaseBarrier.state !== 'frozen' || state.releaseBarrier.barrierId !== input.barrierId) {
      throw new Error('repository_barrier_transition_invalid');
    }
    state.releaseBarrier = { ...state.releaseBarrier, state: 'transaction_active',
      transactionId: input.transactionId, updatedAt: input.now };
    return { revision: nextRevision, barrier: structuredClone(state.releaseBarrier) };
  });
}
export function completeRepositoryTransaction(
  dataDir: string,
  input: OperationBase & { barrierId: string; expectedRevision: number; transactionId: string;
    outcome: 'verified' | 'rolled_back' | 'unknown' },
): { revision: number; barrier: RepositoryReleaseBarrier } {
  return withOperation(dataDir, input, (state, nextRevision) => {
    if (state.revision !== input.expectedRevision) throw new Error('repository_revision_conflict');
    if (state.releaseBarrier.state !== 'transaction_active'
        || state.releaseBarrier.barrierId !== input.barrierId
        || state.releaseBarrier.transactionId !== input.transactionId) {
      throw new Error('repository_barrier_transition_invalid');
    }
    state.releaseBarrier = { ...state.releaseBarrier,
      state: input.outcome === 'verified' ? 'released'
        : input.outcome === 'rolled_back' ? 'frozen' : 'transaction_active',
      updatedAt: input.now };
    return { revision: nextRevision, barrier: structuredClone(state.releaseBarrier) };
  });
}

export function markRepositoryTransactionUnknown(
  dataDir: string,
  input: OperationBase & { barrierId: string; expectedRevision: number; transactionId: string },
): { revision: number; barrier: RepositoryReleaseBarrier } {
  return withOperation(dataDir, input, (state, nextRevision) => {
    if (state.revision !== input.expectedRevision) throw new Error('repository_revision_conflict');
    if (!['released', 'frozen', 'transaction_active'].includes(state.releaseBarrier.state)
        || state.releaseBarrier.barrierId !== input.barrierId
        || state.releaseBarrier.transactionId !== input.transactionId) {
      throw new Error('repository_barrier_transition_invalid');
    }
    state.releaseBarrier = {
      ...state.releaseBarrier, state: 'transaction_active', updatedAt: input.now,
    };
    return { revision: nextRevision, barrier: structuredClone(state.releaseBarrier) };
  });
}

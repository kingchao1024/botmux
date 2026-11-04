import { join } from 'node:path';
import { withSecureHostParentSync } from '../platform/secure-host-file.js';
import type { RepositoryIdentity } from './git-worktree.js';

export interface RepositoryLeaseRef {
  repoKey: string;
  leaseId: string;
  fencingToken: number;
  workingDir: string;
}
export interface RepositoryWriterLease extends RepositoryLeaseRef {
  operationId: string;
  chatId: string;
  dispatchRoot: string;
  taskGuid: string;
  controllerAppId: string;
  workerAppId: string;
  sessionId: string;
  workerGeneration: number;
  declaredScopes: string[];
  acquiredAt: string;
  heartbeatAt: string;
  generationBoundAt?: string;
  state: 'active';
}
export interface RepositoryReleaseBarrier {
  state: 'open' | 'draining' | 'frozen' | 'transaction_active' | 'released';
  barrierId?: string;
  authorizationRef?: string;
  snapshot?: RepositoryReleaseSnapshot;
  transactionId?: string;
  updatedAt: string;
}
export interface RepositoryReleaseSnapshot {
  repoKey: string;
  canonicalCommonDir: string;
  worktreePath: string;
  transactionId: string;
  commitSha: string;
  treeSha: string;
  remoteRef: string;
  remoteCommitSha: string;
  worktreeClean: true;
  bunVersion: string;
  buildToolchainHash: string;
  artifactPath: string;
  artifactTreeHash: string;
  rollbackArtifactPath: string;
  rollbackTreeHash: string;
  targetRuntimeHash: string;
  oldRuntimeHash: string;
  requiredChecksHash: string;
  independentReviewHash: string;
  deploymentPath: string;
  unit: string;
  host: string;
  releaseVerification: {
    projectChatId: string;
    stageAdvanceFingerprint: string;
    completionGateId: string;
    expectedFleetAppIds: string[];
  };
}
export interface RepositoryControlState {
  schemaVersion: 1;
  revision: number;
  repoKey: string;
  canonicalCommonDir: string;
  nextFencingToken: number;
  writerLease: RepositoryWriterLease | null;
  releaseBarrier: RepositoryReleaseBarrier;
  operations: Record<string, { inputHash: string; result: unknown }>;
  updatedAt: string;
}

const MAX_STATE_BYTES = 4 * 1024 * 1024;
const RELEASE_SNAPSHOT_KEYS = [
  'artifactPath', 'artifactTreeHash', 'buildToolchainHash', 'bunVersion', 'canonicalCommonDir',
  'commitSha', 'deploymentPath', 'host', 'independentReviewHash', 'oldRuntimeHash', 'releaseVerification', 'remoteCommitSha', 'remoteRef', 'repoKey',
  'requiredChecksHash', 'rollbackArtifactPath', 'rollbackTreeHash', 'targetRuntimeHash',
  'transactionId', 'treeSha', 'unit', 'worktreeClean', 'worktreePath',
] as const;
const RELEASE_VERIFICATION_KEYS = [
  'completionGateId', 'expectedFleetAppIds', 'projectChatId', 'stageAdvanceFingerprint',
] as const;

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

export function normalizeRepositoryReleaseSnapshot(
  value: Record<string, unknown> | RepositoryReleaseSnapshot,
  identity: RepositoryIdentity,
): RepositoryReleaseSnapshot {
  const snapshot = value as unknown as Record<string, unknown>;
  const verification = snapshot.releaseVerification;
  if (!hasExactKeys(snapshot, RELEASE_SNAPSHOT_KEYS)
      || !verification || typeof verification !== 'object' || Array.isArray(verification)
      || !hasExactKeys(verification as Record<string, unknown>, RELEASE_VERIFICATION_KEYS)) {
    throw new Error('repository_release_snapshot_invalid');
  }
  const releaseVerification = verification as Record<string, unknown>;
  const expectedFleetAppIds = releaseVerification.expectedFleetAppIds;
  if (snapshot.repoKey !== identity.repoKey || snapshot.canonicalCommonDir !== identity.canonicalCommonDir) {
    throw new Error('repository_release_snapshot_identity_mismatch');
  }
  if (!/^[a-f0-9]{64}$/.test(String(snapshot.repoKey))
      || typeof snapshot.canonicalCommonDir !== 'string' || !snapshot.canonicalCommonDir.startsWith('/')
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(String(snapshot.transactionId))
      || !/^[a-f0-9]{40}$/.test(String(snapshot.commitSha))
      || !/^[a-f0-9]{40}$/.test(String(snapshot.treeSha))
      || typeof snapshot.worktreePath !== 'string' || !snapshot.worktreePath.startsWith('/')
      || typeof snapshot.remoteRef !== 'string' || !/^refs\/remotes\/[A-Za-z0-9._/-]+$/.test(snapshot.remoteRef)
      || !/^[a-f0-9]{40}$/.test(String(snapshot.remoteCommitSha))
      || snapshot.worktreeClean !== true
      || snapshot.bunVersion !== '1.4.2'
      || !/^[a-f0-9]{64}$/.test(String(snapshot.buildToolchainHash))
      || !/^[a-f0-9]{64}$/.test(String(snapshot.artifactTreeHash))
      || !/^[a-f0-9]{64}$/.test(String(snapshot.rollbackTreeHash))
      || !/^[a-f0-9]{64}$/.test(String(snapshot.targetRuntimeHash))
      || !/^[a-f0-9]{64}$/.test(String(snapshot.oldRuntimeHash))
      || !/^[a-f0-9]{64}$/.test(String(snapshot.requiredChecksHash))
      || !/^[a-f0-9]{64}$/.test(String(snapshot.independentReviewHash))
      || typeof snapshot.artifactPath !== 'string' || !snapshot.artifactPath.startsWith('/')
      || typeof snapshot.rollbackArtifactPath !== 'string' || !snapshot.rollbackArtifactPath.startsWith('/')
      || typeof snapshot.deploymentPath !== 'string' || !snapshot.deploymentPath.startsWith('/')
      || typeof snapshot.unit !== 'string' || !snapshot.unit
      || typeof snapshot.host !== 'string' || !snapshot.host
      || typeof releaseVerification.projectChatId !== 'string' || !releaseVerification.projectChatId
      || typeof releaseVerification.stageAdvanceFingerprint !== 'string'
      || !releaseVerification.stageAdvanceFingerprint.startsWith('psa1:')
      || typeof releaseVerification.completionGateId !== 'string' || !releaseVerification.completionGateId
      || !Array.isArray(expectedFleetAppIds) || expectedFleetAppIds.length === 0
      || expectedFleetAppIds.some(appId => typeof appId !== 'string' || !appId)) {
    throw new Error('repository_release_snapshot_invalid');
  }
  return structuredClone(snapshot) as unknown as RepositoryReleaseSnapshot;
}

function assertRepoKey(repoKey: string): void {
  if (!/^[a-f0-9]{64}$/.test(repoKey)) throw new Error('repository_control_invalid_repo_key');
}
export function repositoryControlStatePath(dataDir: string, repoKey: string): string {
  assertRepoKey(repoKey);
  return join(dataDir, 'repository-control', 'v1', `${repoKey}.json`);
}
function initialState(identity: RepositoryIdentity): RepositoryControlState {
  return {
    schemaVersion: 1, revision: 0, repoKey: identity.repoKey,
    canonicalCommonDir: identity.canonicalCommonDir, nextFencingToken: 1,
    writerLease: null, releaseBarrier: { state: 'open', updatedAt: new Date(0).toISOString() },
    operations: {}, updatedAt: new Date(0).toISOString(),
  };
}
function parseState(raw: string | null, identity: RepositoryIdentity): RepositoryControlState {
  if (raw === null) return initialState(identity);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('repository_control_state_corrupt'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('repository_control_state_corrupt');
  const state = value as Partial<RepositoryControlState>;
  if (state.schemaVersion !== 1
      || !Number.isSafeInteger(state.revision) || (state.revision as number) < 0
      || state.repoKey !== identity.repoKey
      || state.canonicalCommonDir !== identity.canonicalCommonDir
      || !Number.isSafeInteger(state.nextFencingToken) || (state.nextFencingToken as number) < 1
      || !state.releaseBarrier || typeof state.releaseBarrier !== 'object'
      || !['open', 'draining', 'frozen', 'transaction_active', 'released']
        .includes((state.releaseBarrier as RepositoryReleaseBarrier).state)
      || !state.operations || typeof state.operations !== 'object' || Array.isArray(state.operations)
      || typeof state.updatedAt !== 'string') throw new Error('repository_control_state_corrupt');
  if (state.writerLease !== null && (!state.writerLease || typeof state.writerLease !== 'object'
      || typeof state.writerLease.leaseId !== 'string'
      || !Number.isSafeInteger(state.writerLease.fencingToken)
      || state.writerLease.repoKey !== identity.repoKey)) throw new Error('repository_control_state_corrupt');
  const barrier = state.releaseBarrier as RepositoryReleaseBarrier;
  try {
    if (barrier.snapshot !== undefined) {
      barrier.snapshot = normalizeRepositoryReleaseSnapshot(barrier.snapshot, identity);
    } else if (['frozen', 'transaction_active', 'released'].includes(barrier.state)) {
      throw new Error('repository_release_snapshot_missing');
    }
    if (barrier.transactionId !== undefined
        && barrier.transactionId !== barrier.snapshot?.transactionId) {
      throw new Error('repository_release_transaction_mismatch');
    }
    if (['transaction_active', 'released'].includes(barrier.state) && !barrier.transactionId) {
      throw new Error('repository_release_transaction_missing');
    }
  } catch {
    throw new Error('repository_control_state_corrupt');
  }
  return state as RepositoryControlState;
}
export function readRepositoryControlState(dataDir: string, identity: RepositoryIdentity): RepositoryControlState {
  const file = repositoryControlStatePath(dataDir, identity.repoKey);
  return withSecureHostParentSync(file, parent => parseState(parent.readLeaf(MAX_STATE_BYTES), identity), {
    exactParentMode: 0o700,
  });
}
export function mutateRepositoryControlState<R>(
  dataDir: string,
  identity: RepositoryIdentity,
  transition: (current: RepositoryControlState, nextRevision: number) => {
    next?: RepositoryControlState; result: R;
  },
): R {
  const file = repositoryControlStatePath(dataDir, identity.repoKey);
  return withSecureHostParentSync<unknown>(file, parent => parent.withLeafLock<unknown>(() => {
    const current = parseState(parent.readLeaf(MAX_STATE_BYTES), identity);
    const nextRevision = current.revision + 1;
    const outcome = transition(structuredClone(current), nextRevision);
    if (!outcome.next) return outcome.result;
    outcome.next.schemaVersion = 1;
    outcome.next.revision = nextRevision;
    outcome.next.repoKey = identity.repoKey;
    outcome.next.canonicalCommonDir = identity.canonicalCommonDir;
    parent.writeLeaf(`${JSON.stringify(outcome.next, null, 2)}\n`);
    return outcome.result;
  }), { exactParentMode: 0o700 }) as R;
}

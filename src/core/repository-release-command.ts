import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync,
  realpathSync, renameSync, statSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { isManagedAgentHostCommandContext } from '../platform/host-command-context.js';
import { withSecureHostParentSync } from '../platform/secure-host-file.js';
import { readSupervisorProcessStartIdentity } from './process-start-identity.js';
import { resolveRepositoryIdentitySync, type RepositoryIdentity } from '../services/git-worktree.js';
import {
  beginRepositoryFreeze,
  beginRepositoryTransaction,
  cancelRepositoryFreeze,
  completeRepositoryTransaction,
  finalizeRepositoryFreeze,
  markRepositoryTransactionUnknown,
  readRepositoryControl,
  releaseRepositoryBarrier,
  type RepositoryReleaseSnapshot,
} from '../services/repository-control.js';
import {
  createReleaseTransaction,
  inspectReleaseTransaction,
  type ReleaseTransactionReceipt,
  type ReleaseTransactionRequest,
} from '../services/release-transaction-store.js';
import {
  runReleaseTransaction,
  type ReleaseTransactionAdapters,
} from '../services/release-transaction.js';
import { readProjectGroup } from '../services/project-group-store.js';
import { withFileLockSync } from '../utils/file-lock.js';

export interface RepositoryReleaseCommandIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

export interface RepositoryReleaseCommandDependencies {
  dataDir: string;
  env: NodeJS.ProcessEnv;
  now?: () => string;
  resolveIdentity?: (workdir: string) => RepositoryIdentity;
  findIdentityByBarrierId?: (dataDir: string, barrierId: string) => RepositoryIdentity;
  readJsonFile?: (path: string) => unknown;
  createTransactionAdapters?: (
    request: ReleaseTransactionRequest,
    barrierSnapshot?: RepositoryReleaseSnapshot,
  ) => ReleaseTransactionAdapters;
  validateFreezeSnapshot?: (
    workdir: string,
    snapshot: RepositoryReleaseSnapshot,
    identity: RepositoryIdentity,
  ) => RepositoryReleaseSnapshot;
  isManagedHostContext?: () => boolean;
  hostname?: () => string;
  canonicalizeWorktree?: (workdir: string) => string;
}

interface FreezeBeginRequest {
  workdir: string;
  barrierId: string;
  expectedRevision: number;
  authorizationRef: string;
  snapshot: Record<string, unknown>;
}

function usageError(detail: string): never {
  throw new Error(`repository_command_invalid:${detail}`);
}

function parseOptions(args: string[], allowed: readonly string[], booleans: readonly string[] = []): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!allowed.includes(name)) usageError(`unknown_argument:${name}`);
    if (values.has(name)) usageError(`duplicate_argument:${name}`);
    if (booleans.includes(name)) {
      values.set(name, 'true');
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith('--')) usageError(`missing_value:${name}`);
    values.set(name, value);
  }
  return values;
}

function requireOption(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) usageError(`missing_argument:${name}`);
  return value;
}

function parseRevision(value: string): number {
  if (!/^\d+$/.test(value)) usageError('expected_revision_invalid');
  const revision = Number(value);
  if (!Number.isSafeInteger(revision)) usageError('expected_revision_invalid');
  return revision;
}

function defaultReadJsonFile(path: string): unknown {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error('repository_request_file_invalid', { cause: error });
  }
  try {
    const before = fstatSync(fd);
    const current = lstatSync(path);
    if (!before.isFile() || current.isSymbolicLink() || !sameFileIdentity(before, current)
        || before.size > 1024 * 1024
        || (process.getuid && before.uid !== process.getuid())) {
      throw new Error('repository_request_file_invalid');
    }
    const raw = readFileSync(fd, 'utf8');
    const after = fstatSync(fd);
    if (!sameFileIdentity(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error('repository_request_file_changed');
    }
    return JSON.parse(raw) as unknown;
  } finally {
    closeSync(fd);
  }
}

function parseFreezeBeginRequest(value: unknown): FreezeBeginRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('repository_freeze_request_invalid');
  }
  const request = value as Partial<FreezeBeginRequest>;
  if (typeof request.workdir !== 'string' || !request.workdir.startsWith('/')
      || typeof request.barrierId !== 'string' || !request.barrierId
      || !Number.isSafeInteger(request.expectedRevision) || (request.expectedRevision as number) < 0
      || typeof request.authorizationRef !== 'string' || !request.authorizationRef.startsWith('om_')
      || !request.snapshot || typeof request.snapshot !== 'object' || Array.isArray(request.snapshot)) {
    throw new Error('repository_freeze_request_invalid');
  }
  return request as FreezeBeginRequest;
}

function parseTransactionRequest(value: unknown): ReleaseTransactionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('release_transaction_request_invalid');
  }
  return value as ReleaseTransactionRequest;
}

const TRANSACTION_SNAPSHOT_FIELDS = [
  'transactionId', 'commitSha', 'treeSha', 'artifactPath', 'artifactTreeHash',
  'rollbackArtifactPath', 'rollbackTreeHash', 'targetRuntimeHash', 'oldRuntimeHash',
  'requiredChecksHash', 'independentReviewHash', 'deploymentPath', 'unit', 'host',
] as const;

function assertTransactionMatchesSnapshot(
  request: ReleaseTransactionRequest,
  identity: RepositoryIdentity,
  snapshot: RepositoryReleaseSnapshot | undefined,
): void {
  if (!snapshot) throw new Error('repository_barrier_snapshot_missing');
  if (snapshot.repoKey !== identity.repoKey
      || snapshot.canonicalCommonDir !== identity.canonicalCommonDir
      || request.repoKey !== snapshot.repoKey
      || TRANSACTION_SNAPSHOT_FIELDS.some(field => request[field] !== snapshot[field])) {
    throw new Error('release_transaction_snapshot_mismatch');
  }
}

export function releaseBuildToolchainHash(workdir: string, bunVersion: string): string {
  const hash = createHash('sha256');
  hash.update(`bun\0${bunVersion}\0package.json\0`);
  hash.update(readFileSync(join(workdir, 'package.json')));
  hash.update('\0bun.lock\0');
  hash.update(readFileSync(join(workdir, 'bun.lock')));
  return hash.digest('hex');
}

const REQUIRED_CHECKS_EVIDENCE_LEAF = '.botmux-required-checks.json';
const INDEPENDENT_REVIEW_EVIDENCE_LEAF = '.botmux-independent-review.json';
const RUNTIME_IDENTITY_LEAF = '.runtime-build-id';

function hashReleaseDirectory(path: string): string {
  let directoryFd: number;
  try {
    directoryFd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error('repository_release_artifact_evidence_invalid', { cause: error });
  }
  try {
    const opened = fstatSync(directoryFd);
    const current = lstatSync(path);
    if (!opened.isDirectory() || current.isSymbolicLink() || !sameFileIdentity(opened, current)
        || (process.getuid && opened.uid !== process.getuid()) || (opened.mode & 0o022) !== 0) {
      throw new Error('repository_release_artifact_evidence_invalid');
    }
    const result = createHash('sha256').update(hashPinnedDirectory(directoryFd).join('')).digest('hex');
    const after = fstatSync(directoryFd);
    const currentAfter = lstatSync(path);
    if (!sameFileIdentity(opened, after) || !sameFileIdentity(after, currentAfter)) {
      throw new Error('repository_release_artifact_evidence_changed');
    }
    return result;
  } finally {
    closeSync(directoryFd);
  }
}

function readReleaseEvidenceText(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error('repository_release_artifact_evidence_invalid', { cause: error });
  }
  try {
    const before = fstatSync(fd);
    const current = lstatSync(path);
    if (!before.isFile() || current.isSymbolicLink() || !sameFileIdentity(before, current)
        || before.size > 1024 * 1024 || (process.getuid && before.uid !== process.getuid())
        || (before.mode & 0o022) !== 0) {
      throw new Error('repository_release_artifact_evidence_invalid');
    }
    const raw = readFileSync(fd, 'utf8');
    const after = fstatSync(fd);
    if (!sameFileIdentity(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error('repository_release_artifact_evidence_changed');
    }
    return raw;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('repository_release_')) throw error;
    throw new Error('repository_release_artifact_evidence_invalid', { cause: error });
  } finally {
    closeSync(fd);
  }
}

function readReleaseEvidenceFile(path: string): { raw: string; value: Record<string, unknown> } {
  const raw = readReleaseEvidenceText(path);
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('repository_release_artifact_evidence_invalid');
    }
    return { raw, value: value as Record<string, unknown> };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('repository_release_')) throw error;
    throw new Error('repository_release_artifact_evidence_invalid', { cause: error });
  }
}

function hasExactEvidenceKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function validateFrozenReleaseEvidence(snapshot: RepositoryReleaseSnapshot): void {
  if (hashReleaseDirectory(snapshot.artifactPath) !== snapshot.artifactTreeHash
      || hashReleaseDirectory(snapshot.rollbackArtifactPath) !== snapshot.rollbackTreeHash) {
    throw new Error('repository_release_artifact_hash_mismatch');
  }
  const targetRuntime = readReleaseEvidenceText(join(snapshot.artifactPath, RUNTIME_IDENTITY_LEAF));
  const oldRuntime = readReleaseEvidenceText(join(snapshot.rollbackArtifactPath, RUNTIME_IDENTITY_LEAF));
  if (targetRuntime.trim() !== snapshot.targetRuntimeHash
      || oldRuntime.trim() !== snapshot.oldRuntimeHash) {
    throw new Error('repository_release_runtime_hash_mismatch');
  }
  const requiredChecks = readReleaseEvidenceFile(join(snapshot.artifactPath, REQUIRED_CHECKS_EVIDENCE_LEAF));
  const independentReview = readReleaseEvidenceFile(join(snapshot.artifactPath, INDEPENDENT_REVIEW_EVIDENCE_LEAF));
  if (createHash('sha256').update(requiredChecks.raw).digest('hex') !== snapshot.requiredChecksHash
      || createHash('sha256').update(independentReview.raw).digest('hex') !== snapshot.independentReviewHash) {
    throw new Error('repository_release_gate_evidence_hash_mismatch');
  }
  if (!hasExactEvidenceKeys(requiredChecks.value, ['schemaVersion', 'kind', 'commitSha', 'treeSha', 'status'])
      || requiredChecks.value.schemaVersion !== 1 || requiredChecks.value.kind !== 'required_checks'
      || requiredChecks.value.commitSha !== snapshot.commitSha || requiredChecks.value.treeSha !== snapshot.treeSha
      || requiredChecks.value.status !== 'passed') {
    throw new Error('repository_release_required_checks_invalid');
  }
  if (!hasExactEvidenceKeys(independentReview.value, ['schemaVersion', 'kind', 'commitSha', 'treeSha', 'verdict'])
      || independentReview.value.schemaVersion !== 1 || independentReview.value.kind !== 'independent_review'
      || independentReview.value.commitSha !== snapshot.commitSha || independentReview.value.treeSha !== snapshot.treeSha
      || independentReview.value.verdict !== 'pass') {
    throw new Error('repository_release_independent_review_invalid');
  }
}

export function validateTrustedReleaseSnapshot(
  workdir: string,
  snapshot: RepositoryReleaseSnapshot,
  identity: RepositoryIdentity,
): RepositoryReleaseSnapshot {
  const canonicalWorktree = realpathSync(workdir);
  if (canonicalWorktree !== realpathSync(snapshot.worktreePath)) {
    throw new Error('repository_release_worktree_mismatch');
  }
  const liveIdentity = resolveRepositoryIdentitySync(canonicalWorktree);
  if (liveIdentity.repoKey !== identity.repoKey
      || liveIdentity.canonicalCommonDir !== identity.canonicalCommonDir) {
    throw new Error('repository_release_identity_mismatch');
  }
  const git = (args: string[]): string => execFileSync('git', ['-C', canonicalWorktree, ...args], {
    encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
  }).trim();
  if (git(['status', '--porcelain=v1', '--untracked-files=all']) !== '') {
    throw new Error('repository_release_worktree_dirty');
  }
  const commitSha = git(['rev-parse', '--verify', 'HEAD^{commit}']);
  const treeSha = git(['rev-parse', '--verify', 'HEAD^{tree}']);
  const remoteCommitSha = git(['rev-parse', '--verify', `${snapshot.remoteRef}^{commit}`]);
  if (commitSha !== snapshot.commitSha || treeSha !== snapshot.treeSha
      || remoteCommitSha !== snapshot.remoteCommitSha || remoteCommitSha !== commitSha) {
    throw new Error('repository_release_git_identity_mismatch');
  }
  const bunVersion = execFileSync('bun', ['--version'], {
    cwd: canonicalWorktree, encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  }).trim();
  if (bunVersion !== snapshot.bunVersion
      || releaseBuildToolchainHash(canonicalWorktree, bunVersion) !== snapshot.buildToolchainHash) {
    throw new Error('repository_release_toolchain_mismatch');
  }
  validateFrozenReleaseEvidence(snapshot);
  return structuredClone(snapshot);
}

function assertHostMutationContext(dependencies: RepositoryReleaseCommandDependencies): void {
  const managed = dependencies.isManagedHostContext
    ?? (() => isManagedAgentHostCommandContext({
      env: dependencies.env,
      dataDir: dependencies.dataDir,
    }));
  if (managed()) throw new Error('repository_release_managed_context');
}

export function findRepositoryIdentityByBarrierId(dataDir: string, barrierId: string): RepositoryIdentity {
  const anchor = join(dataDir, 'repository-control', 'v1', '.barrier-scan');
  const matches = withSecureHostParentSync(anchor, parent => parent.listLeafNames()
    .filter(name => /^[a-f0-9]{64}\.json$/.test(name))
    .flatMap(name => {
      const raw = parent.readNamedLeaf(name, 4 * 1024 * 1024);
      if (raw === null) return [];
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(raw) as Record<string, unknown>; }
      catch { throw new Error('repository_control_state_corrupt'); }
      const barrier = parsed.releaseBarrier as Record<string, unknown> | undefined;
      if (barrier?.barrierId !== barrierId) return [];
      if (typeof parsed.repoKey !== 'string' || typeof parsed.canonicalCommonDir !== 'string') {
        throw new Error('repository_control_state_corrupt');
      }
      return [{ repoKey: parsed.repoKey, canonicalCommonDir: parsed.canonicalCommonDir }];
    }), { exactParentMode: 0o700 });
  if (matches.length !== 1) throw new Error(matches.length === 0
    ? 'repository_barrier_not_found' : 'repository_barrier_ambiguous');
  return matches[0];
}

function emit(io: RepositoryReleaseCommandIo, value: unknown): void {
  io.stdout(JSON.stringify(value));
}

function barrierOutcome(status: ReleaseTransactionReceipt['status']): 'verified' | 'rolled_back' | 'unknown' {
  if (status === 'verified') return 'verified';
  if (status === 'rolled_back') return 'rolled_back';
  return 'unknown';
}

interface ReleaseVerificationSnapshot {
  projectChatId: string;
  stageAdvanceFingerprint: string;
  completionGateId: string;
  expectedFleetAppIds: string[];
}

interface RepositoryReleaseProbe {
  schemaVersion: 1;
  transactionId: string;
  targetRuntimeHash: string;
  projectChatId: string;
  stageAdvanceFingerprint: string;
  completionGateId: string;
  observedAfter: string;
  status: 'pending' | 'produced';
  stageTriggerId?: string;
  stageUpdatedAt?: string;
  completionCheckedAt?: string;
  producedAt?: string;
}

function releaseProbePath(dataDir: string, transactionId: string): string {
  return join(dataDir, 'repository-release-probes', 'v1', `${transactionId}.json`);
}

function parseRepositoryReleaseProbe(raw: string): RepositoryReleaseProbe {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch (error) { throw new Error('repository_release_probe_invalid', { cause: error }); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('repository_release_probe_invalid');
  }
  const probe = value as Record<string, unknown>;
  const baseKeys = [
    'schemaVersion', 'transactionId', 'targetRuntimeHash', 'projectChatId',
    'stageAdvanceFingerprint', 'completionGateId', 'observedAfter', 'status',
  ];
  const expectedKeys = probe.status === 'produced'
    ? [...baseKeys, 'stageTriggerId', 'stageUpdatedAt', 'completionCheckedAt', 'producedAt']
    : baseKeys;
  if (!hasExactEvidenceKeys(probe, expectedKeys)
      || probe.schemaVersion !== 1
      || typeof probe.transactionId !== 'string' || !probe.transactionId
      || typeof probe.targetRuntimeHash !== 'string' || !/^[a-f0-9]{64}$/.test(probe.targetRuntimeHash)
      || typeof probe.projectChatId !== 'string' || !probe.projectChatId
      || typeof probe.stageAdvanceFingerprint !== 'string' || !probe.stageAdvanceFingerprint.startsWith('psa1:')
      || typeof probe.completionGateId !== 'string' || !probe.completionGateId
      || typeof probe.observedAfter !== 'string' || !Number.isFinite(Date.parse(probe.observedAfter))
      || !['pending', 'produced'].includes(String(probe.status))) {
    throw new Error('repository_release_probe_invalid');
  }
  if (probe.status === 'produced'
      && (typeof probe.stageTriggerId !== 'string' || !probe.stageTriggerId
        || typeof probe.stageUpdatedAt !== 'string' || !Number.isFinite(Date.parse(probe.stageUpdatedAt))
        || typeof probe.completionCheckedAt !== 'string' || !Number.isFinite(Date.parse(probe.completionCheckedAt))
        || typeof probe.producedAt !== 'string' || !Number.isFinite(Date.parse(probe.producedAt)))) {
    throw new Error('repository_release_probe_invalid');
  }
  return probe as unknown as RepositoryReleaseProbe;
}

function readRepositoryReleaseProbe(
  dataDir: string,
  transactionId: string,
): RepositoryReleaseProbe | undefined {
  const raw = withSecureHostParentSync(
    releaseProbePath(dataDir, transactionId), parent => parent.readLeaf(64 * 1024), { exactParentMode: 0o700 },
  );
  return raw === null ? undefined : parseRepositoryReleaseProbe(raw);
}

export function consumeRepositoryReleaseProbes(dataDir: string, runtimeHash: string): number {
  if (!/^[a-f0-9]{64}$/.test(runtimeHash)) throw new Error('repository_release_runtime_hash_invalid');
  const anchor = releaseProbePath(dataDir, '.probe-scan');
  return withSecureHostParentSync(anchor, parent => {
    let produced = 0;
    for (const name of parent.listLeafNames().filter(item => /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}\.json$/.test(item))) {
      const raw = parent.readNamedLeaf(name, 64 * 1024);
      if (raw === null) continue;
      const probe = parseRepositoryReleaseProbe(raw);
      if (probe.status !== 'pending' || probe.targetRuntimeHash !== runtimeHash) continue;
      const project = readProjectGroup(dataDir, probe.projectChatId);
      const event = project?.stageAdvanceEvents?.find(candidate => (
        candidate.fingerprint === probe.stageAdvanceFingerprint
          && candidate.status === 'dispatched'
          && typeof candidate.triggerId === 'string'
          && Date.parse(candidate.updatedAt) >= Date.parse(probe.observedAfter)
      ));
      const gate = project?.completionGates?.find(candidate => (
        candidate.gateId === probe.completionGateId
          && candidate.status === 'satisfied'
          && !candidate.retirement
          && typeof candidate.checkedAt === 'string'
          && Date.parse(candidate.checkedAt) >= Date.parse(probe.observedAfter)
      ));
      if (!event?.triggerId || !gate?.checkedAt) continue;
      const next: RepositoryReleaseProbe = {
        ...probe,
        status: 'produced',
        stageTriggerId: event.triggerId,
        stageUpdatedAt: event.updatedAt,
        completionCheckedAt: gate.checkedAt,
        producedAt: new Date().toISOString(),
      };
      parent.writeNamedLeaf(name, `${JSON.stringify(next, null, 2)}\n`, 64 * 1024);
      produced += 1;
    }
    return produced;
  }, { exactParentMode: 0o700 });
}

export function hasTransactionBoundReleaseEvidence(
  project: ReturnType<typeof readProjectGroup>,
  verification: ReleaseVerificationSnapshot,
  request: ReleaseTransactionRequest,
  observedAfter: string,
  probe: RepositoryReleaseProbe | undefined,
): boolean {
  if (!project) return false;
  const threshold = Date.parse(observedAfter);
  if (!Number.isFinite(threshold)) return false;
  if (!probe || probe.status !== 'produced'
      || probe.transactionId !== request.transactionId
      || probe.targetRuntimeHash !== request.targetRuntimeHash
      || probe.projectChatId !== verification.projectChatId
      || probe.stageAdvanceFingerprint !== verification.stageAdvanceFingerprint
      || probe.completionGateId !== verification.completionGateId
      || Date.parse(probe.observedAfter) < threshold) return false;
  const event = project.stageAdvanceEvents?.find(candidate => (
    candidate.fingerprint === verification.stageAdvanceFingerprint
      && candidate.status === 'dispatched'
      && candidate.triggerId === probe.stageTriggerId
      && candidate.updatedAt === probe.stageUpdatedAt
      && Date.parse(candidate.updatedAt) >= threshold
  ));
  const gate = project.completionGates?.find(candidate => (
    candidate.gateId === verification.completionGateId
      && candidate.status === 'satisfied'
      && !candidate.retirement
      && typeof candidate.checkedAt === 'string'
      && candidate.checkedAt === probe.completionCheckedAt
      && Date.parse(candidate.checkedAt) >= threshold
  ));
  return event !== undefined && gate !== undefined;
}

function parseReleaseVerificationSnapshot(snapshot: RepositoryReleaseSnapshot | undefined): ReleaseVerificationSnapshot {
  const value = snapshot?.releaseVerification;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('release_verification_snapshot_missing');
  }
  const input = value as Partial<ReleaseVerificationSnapshot>;
  if (typeof input.projectChatId !== 'string' || !input.projectChatId
      || typeof input.stageAdvanceFingerprint !== 'string' || !input.stageAdvanceFingerprint.startsWith('psa1:')
      || typeof input.completionGateId !== 'string' || !input.completionGateId
      || !Array.isArray(input.expectedFleetAppIds) || input.expectedFleetAppIds.length === 0
      || input.expectedFleetAppIds.some(id => typeof id !== 'string' || !id)) {
    throw new Error('release_verification_snapshot_invalid');
  }
  return input as ReleaseVerificationSnapshot;
}

function sameFileIdentity(
  left: Pick<import('node:fs').Stats, 'dev' | 'ino'>,
  right: Pick<import('node:fs').Stats, 'dev' | 'ino'>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function hashPinnedDirectory(directoryFd: number, relativePrefix = ''): string[] {
  const anchor = `/proc/self/fd/${directoryFd}`;
  const lines: string[] = [];
  for (const name of readdirSync(anchor).sort()) {
    if (!name || /[\n\r\\]/.test(name)) throw new Error('release_artifact_tree_invalid');
    const path = join(anchor, name);
    const relative = relativePrefix ? `${relativePrefix}/${name}` : name;
    const pathStats = lstatSync(path);
    if (pathStats.isSymbolicLink()) throw new Error('release_artifact_tree_invalid');
    if (pathStats.isDirectory()) {
      const childFd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        if (!sameFileIdentity(pathStats, fstatSync(childFd))) throw new Error('release_artifact_tree_changed');
        lines.push(...hashPinnedDirectory(childFd, relative));
      } finally {
        closeSync(childFd);
      }
      continue;
    }
    if (!pathStats.isFile()) throw new Error('release_artifact_tree_invalid');
    const fileFd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(fileFd);
      if (!sameFileIdentity(pathStats, before)) throw new Error('release_artifact_tree_changed');
      const contentHash = createHash('sha256').update(readFileSync(fileFd)).digest('hex');
      const after = fstatSync(fileFd);
      const current = lstatSync(path);
      if (!sameFileIdentity(before, after) || !sameFileIdentity(after, current)
          || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw new Error('release_artifact_tree_changed');
      }
      lines.push(`${contentHash}  ./${relative}\n`);
    } finally {
      closeSync(fileFd);
    }
  }
  return lines;
}

interface PinnedReleaseFilesystem {
  hashLeaf(leafName: string): string | null;
  renameLeaf(sourceLeaf: string, targetLeaf: string): void;
  withExclusive<T>(fn: () => T): T;
  close(): void;
}

function createPinnedReleaseFilesystem(request: ReleaseTransactionRequest): PinnedReleaseFilesystem {
  if (process.platform !== 'linux') throw new Error('release_pinned_filesystem_unsupported');
  const paths = [request.deploymentPath, request.artifactPath, request.rollbackArtifactPath];
  const parents = paths.map(path => realpathSync(dirname(path)));
  if (!parents.every(parent => parent === parents[0])) throw new Error('release_parent_directory_mismatch');
  const leafNames = paths.map(path => basename(path));
  if (new Set(leafNames).size !== leafNames.length
      || leafNames.some(name => !name || name === '.' || name === '..')) {
    throw new Error('release_artifact_path_invalid');
  }
  const parentPath = parents[0]!;
  const parentStats = statSync(parentPath);
  if (!parentStats.isDirectory()
      || (process.getuid && parentStats.uid !== process.getuid())
      || (parentStats.mode & 0o777) !== 0o700) {
    throw new Error('release_parent_directory_unsafe');
  }
  const parentFd = openSync(parentPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let closed = false;
  try {
    if (!sameFileIdentity(parentStats, fstatSync(parentFd))) throw new Error('release_parent_directory_changed');
  } catch (error) {
    closeSync(parentFd);
    throw error;
  }
  const anchor = `/proc/self/fd/${parentFd}`;
  const assertOpen = (): void => {
    if (closed) throw new Error('release_pinned_filesystem_closed');
  };
  const assertParentCurrent = (): void => {
    assertOpen();
    let current: import('node:fs').Stats;
    try { current = lstatSync(parentPath); }
    catch (error) { throw new Error('release_parent_directory_changed', { cause: error }); }
    if (current.isSymbolicLink() || !current.isDirectory()
        || !sameFileIdentity(fstatSync(parentFd), current)) {
      throw new Error('release_parent_directory_changed');
    }
  };
  const hashLeaf = (leafName: string): string | null => {
    assertParentCurrent();
    const path = join(anchor, leafName);
    let directoryFd: number;
    try {
      directoryFd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('release_artifact_path_invalid', { cause: error });
    }
    try {
      const opened = fstatSync(directoryFd);
      const current = lstatSync(path);
      if (current.isSymbolicLink() || !sameFileIdentity(opened, current)) {
        throw new Error('release_artifact_tree_changed');
      }
      const lines = hashPinnedDirectory(directoryFd);
      if (!sameFileIdentity(opened, fstatSync(directoryFd))) throw new Error('release_artifact_tree_changed');
      return createHash('sha256').update(lines.join('')).digest('hex');
    } finally {
      closeSync(directoryFd);
    }
  };
  const renameLeaf = (sourceLeaf: string, targetLeaf: string): void => {
    assertParentCurrent();
    const source = join(anchor, sourceLeaf);
    const target = join(anchor, targetLeaf);
    const before = lstatSync(source);
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('release_artifact_path_invalid');
    try {
      lstatSync(target);
      throw new Error('release_rename_target_exists');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    renameSync(source, target);
    fsyncSync(parentFd);
    const after = lstatSync(target);
    if (!sameFileIdentity(before, after)) throw new Error('release_artifact_tree_changed');
  };
  return {
    hashLeaf,
    renameLeaf,
    withExclusive: fn => {
      assertParentCurrent();
      return withFileLockSync(join(anchor, '.botmux-release.lock'), () => {
        assertParentCurrent();
        return fn();
      });
    },
    close: () => {
      if (closed) return;
      closed = true;
      closeSync(parentFd);
    },
  };
}

function readRuntimeDescriptors(dataDir: string): Array<Record<string, unknown>> {
  const directory = join(dataDir, 'dashboard-daemons');
  if (!existsSync(directory)) return [];
  const directoryFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const openedDirectory = fstatSync(directoryFd);
    const currentDirectory = lstatSync(directory);
    if (!sameFileIdentity(openedDirectory, currentDirectory)
        || (process.getuid && openedDirectory.uid !== process.getuid())
        || (openedDirectory.mode & 0o022) !== 0) {
      throw new Error('release_daemon_descriptor_directory_invalid');
    }
    const anchor = `/proc/self/fd/${directoryFd}`;
    const now = Date.now();
    return readdirSync(anchor)
      .filter(name => /^daemon-[a-f0-9]{64}\.json$/.test(name))
      .flatMap(name => {
        const path = join(anchor, name);
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stats = fstatSync(fd);
          const current = lstatSync(path);
          if (!stats.isFile() || current.isSymbolicLink() || !sameFileIdentity(stats, current)
              || (process.platform !== 'win32' && (stats.mode & 0o777) !== 0o600)
              || stats.size > 64 * 1024) throw new Error('release_daemon_descriptor_invalid');
          const value = JSON.parse(readFileSync(fd, 'utf8')) as Record<string, unknown>;
          const after = fstatSync(fd);
          if (!sameFileIdentity(stats, after) || stats.size !== after.size || stats.mtimeMs !== after.mtimeMs) {
            throw new Error('release_daemon_descriptor_changed');
          }
          return typeof value.lastHeartbeat === 'number' && now - value.lastHeartbeat <= 90_000 ? [value] : [];
        } finally {
          closeSync(fd);
        }
      });
  } finally {
    closeSync(directoryFd);
  }
}

function processBelongsToExactUnit(pid: number, unit: string): boolean {
  try {
    return readFileSync(`/proc/${pid}/cgroup`, 'utf8').split(/\r?\n/).some(line => {
      const separator = line.indexOf(':', line.indexOf(':') + 1);
      if (separator < 0) return false;
      return line.slice(separator + 1).split('/').includes(unit);
    });
  } catch { return false; }
}

function publishRepositoryReleaseProbe(
  dataDir: string,
  request: ReleaseTransactionRequest,
  verification: ReleaseVerificationSnapshot,
  observedAfter: string,
): void {
  const path = releaseProbePath(dataDir, request.transactionId);
  const record = {
    schemaVersion: 1,
    transactionId: request.transactionId,
    targetRuntimeHash: request.targetRuntimeHash,
    projectChatId: verification.projectChatId,
    stageAdvanceFingerprint: verification.stageAdvanceFingerprint,
    completionGateId: verification.completionGateId,
    observedAfter,
    status: 'pending',
  };
  withSecureHostParentSync(path, parent => parent.writeLeaf(`${JSON.stringify(record, null, 2)}\n`), {
    exactParentMode: 0o700,
  });
}

export function createHostReleaseTransactionAdapters(
  dataDir: string,
  request: ReleaseTransactionRequest,
  barrierSnapshot: RepositoryReleaseSnapshot | undefined,
  env: NodeJS.ProcessEnv,
): ReleaseTransactionAdapters {
  const verification = parseReleaseVerificationSnapshot(barrierSnapshot);
  const filesystem = createPinnedReleaseFilesystem(request);
  const [deploymentLeaf, artifactLeaf, rollbackLeaf] = [
    basename(request.deploymentPath), basename(request.artifactPath), basename(request.rollbackArtifactPath),
  ];
  let verificationObservedAfter = new Date().toISOString();
  const systemctl = (args: string[]): string => execFileSync('systemctl', ['--user', ...args], {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const systemctlValue = (property: string): string | null => {
    try { return systemctl(['show', request.unit, `--property=${property}`, '--value']); }
    catch { return null; }
  };
  const inspect = () => {
    const artifactTreeHash = filesystem.hashLeaf(deploymentLeaf);
    const stagedArtifactTreeHash = filesystem.hashLeaf(artifactLeaf);
    const rollbackTreeHash = filesystem.hashLeaf(rollbackLeaf);
    const descriptors = readRuntimeDescriptors(dataDir);
    const runtimeIds = new Set(descriptors.map(item => item.runtimeGeneration)
      .filter((value): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)));
    const runtimeHash = runtimeIds.size === 1 ? [...runtimeIds][0] : null;
    const expectedApps = [...verification.expectedFleetAppIds].sort();
    const actualApps = descriptors.map(item => String(item.larkAppId ?? '')).filter(Boolean).sort();
    const pids = descriptors.map(item => item.pid).filter((pid): pid is number =>
      typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0);
    const fleetHealthy = JSON.stringify(actualApps) === JSON.stringify(expectedApps)
      && descriptors.length === expectedApps.length
      && descriptors.every(item => typeof item.pid === 'number'
        && typeof item.processStartIdentity === 'string'
        && readSupervisorProcessStartIdentity(item.pid) === item.processStartIdentity);
    const cgroupHealthy = pids.length === expectedApps.length
      && pids.every(pid => processBelongsToExactUnit(pid, request.unit));
    const project = readProjectGroup(dataDir, verification.projectChatId);
    const releaseProbe = readRepositoryReleaseProbe(dataDir, request.transactionId);
    const transactionEvidenceHealthy = hasTransactionBoundReleaseEvidence(
      project, verification, request, verificationObservedAfter, releaseProbe,
    );
    const liveBehaviorHealthy = transactionEvidenceHealthy;
    const completionGateHealthy = transactionEvidenceHealthy;
    const sameFilesystem = true;
    const serviceInspectable = systemctlValue('LoadState') === 'loaded';
    const serviceActive = systemctlValue('ActiveState') === 'active';
    let layout: 'old-dist-old-runtime' | 'new-dist-old-runtime' | 'new-dist-new-runtime'
      | 'old-dist-new-runtime' | 'unknown' = 'unknown';
    if (artifactTreeHash === request.rollbackTreeHash && runtimeHash === request.oldRuntimeHash) {
      layout = 'old-dist-old-runtime';
    } else if (artifactTreeHash === request.artifactTreeHash && runtimeHash === request.oldRuntimeHash) {
      layout = 'new-dist-old-runtime';
    } else if (artifactTreeHash === request.artifactTreeHash && runtimeHash === request.targetRuntimeHash) {
      layout = 'new-dist-new-runtime';
    } else if (artifactTreeHash === request.rollbackTreeHash && runtimeHash === request.targetRuntimeHash) {
      layout = 'old-dist-new-runtime';
    }
    return {
      layout, artifactTreeHash, stagedArtifactTreeHash, rollbackTreeHash, runtimeHash,
      sameFilesystem, serviceInspectable, serviceActive, fleetHealthy, cgroupHealthy,
      liveBehaviorHealthy, completionGateHealthy,
      evidence: { expectedApps, actualApps, pids },
    };
  };
  return {
    now: () => new Date().toISOString(),
    inspect,
    renameCurrentToRollback: () => filesystem.renameLeaf(deploymentLeaf, rollbackLeaf),
    renameStagedToCurrent: () => filesystem.renameLeaf(artifactLeaf, deploymentLeaf),
    renameCurrentToStaged: () => filesystem.renameLeaf(deploymentLeaf, artifactLeaf),
    renameRollbackToCurrent: () => filesystem.renameLeaf(rollbackLeaf, deploymentLeaf),
    restart: () => {
      verificationObservedAfter = new Date().toISOString();
      publishRepositoryReleaseProbe(dataDir, request, verification, verificationObservedAfter);
      systemctl(['restart', request.unit]);
    },
    withExclusive: fn => filesystem.withExclusive(fn),
    close: () => filesystem.close(),
  };
}

export function runRepositoryReleaseCommand(
  args: string[],
  dependencies: RepositoryReleaseCommandDependencies,
  io: RepositoryReleaseCommandIo,
): ReleaseTransactionReceipt | object {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const resolveIdentity = dependencies.resolveIdentity ?? resolveRepositoryIdentitySync;
  const findIdentity = dependencies.findIdentityByBarrierId ?? findRepositoryIdentityByBarrierId;
  const readJson = dependencies.readJsonFile ?? defaultReadJsonFile;
  const [section, action, ...rest] = args;

  if (section === 'status') {
    const options = parseOptions([action, ...rest].filter((value): value is string => value !== undefined),
      ['--workdir', '--json'], ['--json']);
    requireOption(options, '--json');
    const identity = resolveIdentity(requireOption(options, '--workdir'));
    const result = readRepositoryControl(dependencies.dataDir, identity);
    emit(io, result);
    return result;
  }

  if (section === 'freeze' && action === 'begin') {
    const options = parseOptions(rest, ['--request-file', '--operation-id']);
    const requestFile = requireOption(options, '--request-file');
    const operationId = requireOption(options, '--operation-id');
    assertHostMutationContext(dependencies);
    const request = parseFreezeBeginRequest(readJson(requestFile));
    const identity = resolveIdentity(request.workdir);
    const canonicalWorktree = (dependencies.canonicalizeWorktree ?? realpathSync)(request.workdir);
    if ((request.snapshot as { worktreePath?: unknown }).worktreePath !== canonicalWorktree) {
      throw new Error('repository_release_worktree_mismatch');
    }
    const result = beginRepositoryFreeze(dependencies.dataDir, {
      identity,
      operationId,
      barrierId: request.barrierId,
      expectedRevision: request.expectedRevision,
      authorizationRef: request.authorizationRef,
      snapshot: request.snapshot,
      now: now(),
    });
    emit(io, result);
    return result;
  }

  if (section === 'freeze' && action === 'finalize') {
    const options = parseOptions(rest, ['--barrier-id', '--expected-revision', '--operation-id']);
    const barrierId = requireOption(options, '--barrier-id');
    const expectedRevision = parseRevision(requireOption(options, '--expected-revision'));
    const operationId = requireOption(options, '--operation-id');
    assertHostMutationContext(dependencies);
    const identity = findIdentity(dependencies.dataDir, barrierId);
    const current = readRepositoryControl(dependencies.dataDir, identity);
    if (!current.releaseBarrier.snapshot) throw new Error('repository_barrier_snapshot_missing');
    const validateSnapshot = dependencies.validateFreezeSnapshot ?? validateTrustedReleaseSnapshot;
    const trustedSnapshot = validateSnapshot(
      current.releaseBarrier.snapshot.worktreePath,
      current.releaseBarrier.snapshot,
      identity,
    );
    const result = finalizeRepositoryFreeze(dependencies.dataDir, {
      identity,
      operationId,
      barrierId,
      expectedRevision,
      snapshot: trustedSnapshot,
      now: now(),
    });
    emit(io, result);
    return result;
  }

  if (section === 'freeze' && action === 'cancel') {
    const options = parseOptions(rest,
      ['--barrier-id', '--expected-revision', '--authorization-ref', '--operation-id']);
    const barrierId = requireOption(options, '--barrier-id');
    const expectedRevision = parseRevision(requireOption(options, '--expected-revision'));
    const authorizationRef = requireOption(options, '--authorization-ref');
    const operationId = requireOption(options, '--operation-id');
    assertHostMutationContext(dependencies);
    const identity = findIdentity(dependencies.dataDir, barrierId);
    const result = cancelRepositoryFreeze(dependencies.dataDir, {
      identity,
      operationId,
      barrierId,
      expectedRevision,
      authorizationRef,
      now: now(),
    });
    emit(io, result);
    return result;
  }

  if (section === 'transaction' && action === 'inspect') {
    const options = parseOptions(rest, ['--transaction-id', '--json'], ['--json']);
    requireOption(options, '--json');
    const result = inspectReleaseTransaction(
      dependencies.dataDir,
      requireOption(options, '--transaction-id'),
    );
    emit(io, result);
    return result;
  }

  if (section === 'transaction' && action === 'run') {
    const options = parseOptions(rest, ['--request-file']);
    const requestFile = requireOption(options, '--request-file');
    assertHostMutationContext(dependencies);
    const request = parseTransactionRequest(readJson(requestFile));
    const identity = findIdentity(dependencies.dataDir, request.barrierId);
    if (identity.repoKey !== request.repoKey) throw new Error('release_transaction_repository_mismatch');
    const control = readRepositoryControl(dependencies.dataDir, identity);
    assertTransactionMatchesSnapshot(request, identity, control.releaseBarrier.snapshot);
    if (request.host !== (dependencies.hostname ?? hostname)()) {
      throw new Error('repository_release_host_mismatch');
    }
    createReleaseTransaction(dependencies.dataDir, request);
    const existingReceipt = inspectReleaseTransaction(dependencies.dataDir, request.transactionId);
    if (existingReceipt.status === 'verified' || existingReceipt.status === 'rolled_back') {
      const terminalBarrierMatches = control.releaseBarrier.barrierId === request.barrierId
        && control.releaseBarrier.authorizationRef === request.authorizationRef
        && control.releaseBarrier.transactionId === request.transactionId
        && ((existingReceipt.status === 'verified' && control.releaseBarrier.state === 'released')
          || (existingReceipt.status === 'rolled_back' && control.releaseBarrier.state === 'frozen'));
      if (!terminalBarrierMatches) throw new Error('release_barrier_mismatch');
      const adapters = dependencies.createTransactionAdapters
        ? dependencies.createTransactionAdapters(request, control.releaseBarrier.snapshot)
        : createHostReleaseTransactionAdapters(
          dependencies.dataDir, request, control.releaseBarrier.snapshot, dependencies.env,
        );
      let replayed: ReleaseTransactionReceipt;
      try {
        replayed = runReleaseTransaction({
          dataDir: dependencies.dataDir, request,
          expectedBarrier: {
            state: 'transaction_active', barrierId: request.barrierId,
            revision: request.barrierRevision, authorizationRef: request.authorizationRef,
          },
          env: dependencies.env, adapters,
        });
      } finally {
        adapters.close?.();
      }
      if (replayed.status === 'unknown') {
        markRepositoryTransactionUnknown(dependencies.dataDir, {
          identity,
          operationId: `${request.operationId}:terminal-conflict`,
          barrierId: request.barrierId,
          expectedRevision: control.revision,
          transactionId: request.transactionId,
          now: now(),
        });
      }
      emit(io, replayed);
      return replayed;
    }
    const frozenStart = control.revision === request.barrierRevision
      && control.releaseBarrier.state === 'frozen';
    const activeResume = control.releaseBarrier.state === 'transaction_active'
      && control.releaseBarrier.transactionId === request.transactionId
      && control.revision > request.barrierRevision;
    if ((!frozenStart && !activeResume)
        || control.releaseBarrier.barrierId !== request.barrierId
        || control.releaseBarrier.authorizationRef !== request.authorizationRef) {
      throw new Error('release_barrier_mismatch');
    }
    const active = beginRepositoryTransaction(dependencies.dataDir, {
      identity, operationId: request.operationId, barrierId: request.barrierId,
      expectedRevision: request.barrierRevision, transactionId: request.transactionId, now: now(),
    });
    const adapters = dependencies.createTransactionAdapters
      ? dependencies.createTransactionAdapters(request, control.releaseBarrier.snapshot)
      : createHostReleaseTransactionAdapters(
        dependencies.dataDir,
        request,
        control.releaseBarrier.snapshot,
        dependencies.env,
      );
    let receipt: ReleaseTransactionReceipt;
    try {
      receipt = runReleaseTransaction({
        dataDir: dependencies.dataDir,
        request,
        expectedBarrier: {
          state: 'transaction_active', barrierId: request.barrierId,
          revision: request.barrierRevision, authorizationRef: request.authorizationRef,
        },
        env: dependencies.env,
        adapters,
      });
    } finally {
      adapters.close?.();
    }
    completeRepositoryTransaction(dependencies.dataDir, {
      identity,
      operationId: `${request.operationId}:complete:${receipt.status}`,
      barrierId: request.barrierId,
      expectedRevision: active.revision,
      transactionId: request.transactionId,
      outcome: barrierOutcome(receipt.status),
      now: now(),
    });
    emit(io, receipt);
    return receipt;
  }

  if (section === 'release') {
    if (action?.startsWith('--') !== true) usageError(`unknown_argument:${action ?? ''}`);
    const options = parseOptions([action, ...rest],
      ['--barrier-id', '--expected-revision', '--authorization-ref', '--operation-id']);
    const barrierId = requireOption(options, '--barrier-id');
    const expectedRevision = parseRevision(requireOption(options, '--expected-revision'));
    const authorizationRef = requireOption(options, '--authorization-ref');
    const operationId = requireOption(options, '--operation-id');
    assertHostMutationContext(dependencies);
    const identity = findIdentity(dependencies.dataDir, barrierId);
    const result = releaseRepositoryBarrier(dependencies.dataDir, {
      identity,
      operationId,
      barrierId,
      expectedRevision,
      authorizationRef,
      now: now(),
    });
    emit(io, result);
    return result;
  }

  io.stderr('用法: botmux repository status|freeze|transaction|release ...');
  return usageError(`unknown_command:${args.join(' ')}`);
}

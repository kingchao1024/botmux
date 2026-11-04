import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync,
  readFileSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createHostReleaseTransactionAdapters,
  hasTransactionBoundReleaseEvidence,
  releaseBuildToolchainHash,
  runRepositoryReleaseCommand,
} from '../src/core/repository-release-command.js';
import { resolveRepositoryIdentitySync } from '../src/services/git-worktree.js';
import {
  beginRepositoryTransaction,
  readRepositoryControl,
} from '../src/services/repository-control.js';
import {
  appendReleaseJournalEvent,
  createReleaseTransaction,
  type ReleaseTransactionRequest,
} from '../src/services/release-transaction-store.js';
import { type ReleaseTransactionAdapters } from '../src/services/release-transaction.js';
import { tsRunnerPrefix } from './helpers/ts-runner.js';

const roots: string[] = [];
const identity = { repoKey: 'a'.repeat(64), canonicalCommonDir: '/tmp/release-command.git' };

function tempDataDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'botmux-release-command-'));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function flatFixtureTreeHash(files: Record<string, string>): string {
  const manifest = Object.entries(files).sort(([left], [right]) => left.localeCompare(right))
    .map(([name, content]) => `${createHash('sha256').update(content).digest('hex')}  ./${name}\n`)
    .join('');
  return createHash('sha256').update(manifest).digest('hex');
}

function io() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, adapter: { stdout: (value: string) => stdout.push(value), stderr: (value: string) => stderr.push(value) } };
}

function request(barrierRevision: number): ReleaseTransactionRequest {
  return {
    schemaVersion: 1, transactionId: 'tx-command-01234567', repoKey: identity.repoKey,
    barrierId: 'barrier-command', barrierRevision,
    authorizationRef: 'om_x100b63f8d42964a10c752d313c3598c', operationId: 'op-tx',
    commitSha: 'b'.repeat(40), treeSha: 'c'.repeat(40), artifactPath: '/srv/next',
    artifactTreeHash: 'd'.repeat(64), rollbackArtifactPath: '/srv/rollback',
    rollbackTreeHash: 'e'.repeat(64), targetRuntimeHash: 'f'.repeat(64),
    oldRuntimeHash: '1'.repeat(64), requiredChecksHash: '2'.repeat(64),
    independentReviewHash: '3'.repeat(64), deploymentPath: '/srv/live',
    unit: 'botmux.service', host: 'host',
  };
}

function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const input = request(0);
  return {
    repoKey: identity.repoKey,
    canonicalCommonDir: identity.canonicalCommonDir,
    worktreePath: '/tmp/worktree',
    transactionId: input.transactionId,
    commitSha: input.commitSha,
    treeSha: input.treeSha,
    remoteRef: 'refs/remotes/origin/main',
    remoteCommitSha: input.commitSha,
    worktreeClean: true,
    bunVersion: '1.4.2',
    buildToolchainHash: '9'.repeat(64),
    artifactPath: input.artifactPath,
    artifactTreeHash: input.artifactTreeHash,
    rollbackArtifactPath: input.rollbackArtifactPath,
    rollbackTreeHash: input.rollbackTreeHash,
    targetRuntimeHash: input.targetRuntimeHash,
    oldRuntimeHash: input.oldRuntimeHash,
    requiredChecksHash: input.requiredChecksHash,
    independentReviewHash: input.independentReviewHash,
    deploymentPath: input.deploymentPath,
    unit: input.unit,
    host: input.host,
    releaseVerification: {
      projectChatId: 'oc_project',
      stageAdvanceFingerprint: 'psa1:release',
      completionGateId: 'gate-release',
      expectedFleetAppIds: ['cli_worker'],
    },
    ...overrides,
  };
}

function trustSnapshot(
  _workdir: string,
  value: import('../src/services/repository-control.js').RepositoryReleaseSnapshot,
) {
  return value;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('repository release command surface', () => {
  it('is reachable from the source CLI and returns repository JSON', () => {
    const home = tempDataDir();
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    const { command, prefixArgs } = tsRunnerPrefix();
    const output = execFileSync(command, [...prefixArgs, cli, 'repository', 'status',
      '--workdir', process.cwd(), '--json'], {
      cwd: process.cwd(), encoding: 'utf8',
      env: { ...process.env, HOME: home, SESSION_DATA_DIR: join(home, 'data') },
    });
    expect(JSON.parse(output)).toMatchObject({ schemaVersion: 1, revision: 0 });
  });

  it('rejects unknown or missing options before any state mutation', () => {
    const dataDir = tempDataDir();
    const out = io();
    const deps = { dataDir, env: {}, resolveIdentity: () => identity };
    expect(() => runRepositoryReleaseCommand(['status', '--workdir', '/tmp', '--json', '--force'], deps, out.adapter))
      .toThrow('unknown_argument:--force');
    expect(() => runRepositoryReleaseCommand(['freeze', 'begin', '--request-file', '/tmp/x'], deps, out.adapter))
      .toThrow('missing_argument:--operation-id');
  });

  it('drives begin finalize and cancel with exact revision and authorization', () => {
    const dataDir = tempDataDir();
    const out = io();
    const freeze = {
      workdir: '/tmp/worktree', barrierId: 'barrier-command', expectedRevision: 0,
      authorizationRef: 'om_x100b63f8d42964a10c752d313c3598c', snapshot: snapshot(),
    };
    const deps = {
      dataDir, env: {}, resolveIdentity: () => identity,
      findIdentityByBarrierId: () => identity,
      readJsonFile: () => freeze,
      validateFreezeSnapshot: trustSnapshot,
      canonicalizeWorktree: value => value,
      now: () => '2026-10-12T10:00:00.000Z',
    };
    const draining = runRepositoryReleaseCommand(['freeze', 'begin', '--request-file', '/tmp/freeze.json',
      '--operation-id', 'op-begin'], deps, out.adapter) as { revision: number };
    expect(draining.revision).toBe(1);
    const frozen = runRepositoryReleaseCommand(['freeze', 'finalize', '--barrier-id', freeze.barrierId,
      '--expected-revision', '1', '--operation-id', 'op-finalize'], deps, out.adapter) as { revision: number };
    expect(frozen.revision).toBe(2);
    const open = runRepositoryReleaseCommand(['freeze', 'cancel', '--barrier-id', freeze.barrierId,
      '--expected-revision', '2', '--authorization-ref', freeze.authorizationRef,
      '--operation-id', 'op-cancel'], deps, out.adapter) as { barrier: { state: string } };
    expect(open.barrier.state).toBe('open');
  });

  it('refuses to freeze a dirty worktree with caller-invented commit and tree identities', () => {
    const dataDir = tempDataDir();
    const workdir = tempDataDir();
    execFileSync('git', ['init', '-q', workdir]);
    execFileSync('git', ['-C', workdir, 'config', 'user.email', 'release-test@example.invalid']);
    execFileSync('git', ['-C', workdir, 'config', 'user.name', 'Release Test']);
    writeFileSync(join(workdir, 'tracked.txt'), 'base\n');
    execFileSync('git', ['-C', workdir, 'add', 'tracked.txt']);
    execFileSync('git', ['-C', workdir, 'commit', '-qm', 'base']);
    appendFileSync(join(workdir, 'tracked.txt'), 'dirty\n');
    const realIdentity = resolveRepositoryIdentitySync(workdir);
    const freeze = {
      workdir, barrierId: 'barrier-dirty', expectedRevision: 0,
      authorizationRef: 'om_x100b63f8d42964a10c752d313c3598c',
      snapshot: {
        ...snapshot({
          repoKey: realIdentity.repoKey,
          canonicalCommonDir: realIdentity.canonicalCommonDir,
          worktreePath: workdir,
          commitSha: 'f'.repeat(40),
          treeSha: 'e'.repeat(40),
        }),
      },
    };
    const deps = {
      dataDir, env: {}, readJsonFile: () => freeze,
      now: () => '2026-10-12T10:00:00.000Z',
    };
    const began = runRepositoryReleaseCommand([
      'freeze', 'begin', '--request-file', '/tmp/freeze.json', '--operation-id', 'op-dirty-begin',
    ], deps, io().adapter) as { revision: number };

    expect(() => runRepositoryReleaseCommand([
      'freeze', 'finalize', '--barrier-id', freeze.barrierId,
      '--expected-revision', String(began.revision), '--operation-id', 'op-dirty-finalize',
    ], deps, io().adapter)).toThrow('repository_release_worktree_dirty');
  });

  it('freezes only a clean worktree whose HEAD tree remote ref and Bun toolchain match', () => {
    const dataDir = tempDataDir();
    const workdir = tempDataDir();
    execFileSync('git', ['init', '-q', workdir]);
    execFileSync('git', ['-C', workdir, 'config', 'user.email', 'release-test@example.invalid']);
    execFileSync('git', ['-C', workdir, 'config', 'user.name', 'Release Test']);
    writeFileSync(join(workdir, 'package.json'), '{"name":"release-fixture"}\n');
    writeFileSync(join(workdir, 'bun.lock'), 'lockfileVersion = 1\n');
    writeFileSync(join(workdir, 'tracked.txt'), 'base\n');
    execFileSync('git', ['-C', workdir, 'add', '.']);
    execFileSync('git', ['-C', workdir, 'commit', '-qm', 'base']);
    execFileSync('git', ['-C', workdir, 'update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const realIdentity = resolveRepositoryIdentitySync(workdir);
    const commitSha = execFileSync('git', ['-C', workdir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const treeSha = execFileSync('git', ['-C', workdir, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
    const releaseRoot = tempDataDir();
    const artifactPath = join(releaseRoot, 'artifact');
    const rollbackArtifactPath = join(releaseRoot, 'rollback');
    mkdirSync(artifactPath, { mode: 0o700 });
    mkdirSync(rollbackArtifactPath, { mode: 0o700 });
    const targetRuntimeHash = 'f'.repeat(64);
    const oldRuntimeHash = '1'.repeat(64);
    const requiredChecks = `${JSON.stringify({
      schemaVersion: 1, kind: 'required_checks', commitSha, treeSha, status: 'passed',
    })}\n`;
    const independentReview = `${JSON.stringify({
      schemaVersion: 1, kind: 'independent_review', commitSha, treeSha, verdict: 'pass',
    })}\n`;
    const artifactFiles = {
      '.botmux-required-checks.json': requiredChecks,
      '.botmux-independent-review.json': independentReview,
      '.runtime-build-id': `${targetRuntimeHash}\n`,
    };
    const rollbackFiles = { '.runtime-build-id': `${oldRuntimeHash}\n` };
    for (const [name, content] of Object.entries(artifactFiles)) writeFileSync(join(artifactPath, name), content);
    for (const [name, content] of Object.entries(rollbackFiles)) writeFileSync(join(rollbackArtifactPath, name), content);
    const freeze = {
      workdir, barrierId: 'barrier-clean', expectedRevision: 0,
      authorizationRef: 'om_x100b63f8d42964a10c752d313c3598c',
      snapshot: snapshot({
        repoKey: realIdentity.repoKey,
        canonicalCommonDir: realIdentity.canonicalCommonDir,
        worktreePath: workdir,
        commitSha,
        treeSha,
        remoteCommitSha: commitSha,
        buildToolchainHash: releaseBuildToolchainHash(workdir, '1.4.2'),
        artifactPath,
        artifactTreeHash: flatFixtureTreeHash(artifactFiles),
        rollbackArtifactPath,
        rollbackTreeHash: flatFixtureTreeHash(rollbackFiles),
        targetRuntimeHash,
        oldRuntimeHash,
        requiredChecksHash: createHash('sha256').update(requiredChecks).digest('hex'),
        independentReviewHash: createHash('sha256').update(independentReview).digest('hex'),
      }),
    };
    const deps = {
      dataDir, env: {}, readJsonFile: () => freeze,
      now: () => '2026-10-12T10:00:00.000Z',
    };
    const began = runRepositoryReleaseCommand([
      'freeze', 'begin', '--request-file', '/tmp/freeze.json', '--operation-id', 'op-clean-begin',
    ], deps, io().adapter) as { revision: number };

    expect(runRepositoryReleaseCommand([
      'freeze', 'finalize', '--barrier-id', freeze.barrierId,
      '--expected-revision', String(began.revision), '--operation-id', 'op-clean-finalize',
    ], deps, io().adapter)).toMatchObject({ barrier: { state: 'frozen' } });
  });

  it('rejects missing artifact rollback required-check and independent-review evidence before frozen', () => {
    const dataDir = tempDataDir();
    const workdir = tempDataDir();
    execFileSync('git', ['init', '-q', workdir]);
    execFileSync('git', ['-C', workdir, 'config', 'user.email', 'release-test@example.invalid']);
    execFileSync('git', ['-C', workdir, 'config', 'user.name', 'Release Test']);
    writeFileSync(join(workdir, 'package.json'), '{"name":"release-fixture"}\n');
    writeFileSync(join(workdir, 'bun.lock'), 'lockfileVersion = 1\n');
    execFileSync('git', ['-C', workdir, 'add', '.']);
    execFileSync('git', ['-C', workdir, 'commit', '-qm', 'base']);
    execFileSync('git', ['-C', workdir, 'update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const realIdentity = resolveRepositoryIdentitySync(workdir);
    const commitSha = execFileSync('git', ['-C', workdir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const treeSha = execFileSync('git', ['-C', workdir, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
    const freeze = {
      workdir, barrierId: 'barrier-missing-evidence', expectedRevision: 0,
      authorizationRef: 'om_x100b63f8d42964a10c752d313c3598c',
      snapshot: snapshot({
        repoKey: realIdentity.repoKey, canonicalCommonDir: realIdentity.canonicalCommonDir,
        worktreePath: workdir, commitSha, treeSha, remoteCommitSha: commitSha,
        buildToolchainHash: releaseBuildToolchainHash(workdir, '1.4.2'),
        artifactPath: join(workdir, 'missing-artifact'),
        rollbackArtifactPath: join(workdir, 'missing-rollback'),
      }),
    };
    const deps = { dataDir, env: {}, readJsonFile: () => freeze };
    const began = runRepositoryReleaseCommand([
      'freeze', 'begin', '--request-file', '/tmp/freeze.json', '--operation-id', 'op-missing-begin',
    ], deps, io().adapter) as { revision: number };

    expect(() => runRepositoryReleaseCommand([
      'freeze', 'finalize', '--barrier-id', freeze.barrierId,
      '--expected-revision', String(began.revision), '--operation-id', 'op-missing-finalize',
    ], deps, io().adapter)).toThrow('repository_release_artifact_evidence_invalid');
    expect(readRepositoryControl(dataDir, realIdentity).releaseBarrier.state).toBe('draining');
  });

  it('runs and inspects a transaction through injected host adapters', () => {
    const dataDir = tempDataDir();
    const out = io();
    const freeze = {
      workdir: '/tmp/worktree', barrierId: 'barrier-command', expectedRevision: 0,
      authorizationRef: 'om_x100b63f8d42964a10c752d313c3598c', snapshot: snapshot(),
    };
    let input: ReleaseTransactionRequest | undefined;
    const deps = {
      dataDir,
      env: { XDG_RUNTIME_DIR: '/run/user/0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/0/bus' },
      resolveIdentity: () => identity,
      findIdentityByBarrierId: () => identity,
      readJsonFile: () => input ?? freeze,
      validateFreezeSnapshot: trustSnapshot,
      canonicalizeWorktree: value => value,
      hostname: () => 'host',
      now: () => '2026-10-12T10:00:00.000Z',
      createTransactionAdapters: (value: ReleaseTransactionRequest): ReleaseTransactionAdapters => {
        const state = {
          layout: 'new-dist-new-runtime' as const, artifactTreeHash: value.artifactTreeHash,
          stagedArtifactTreeHash: null, rollbackTreeHash: value.rollbackTreeHash,
          runtimeHash: value.targetRuntimeHash, sameFilesystem: true, serviceInspectable: true,
          serviceActive: true, fleetHealthy: true, cgroupHealthy: true,
          liveBehaviorHealthy: true, completionGateHealthy: true,
        };
        return {
          now: () => '2026-10-12T10:00:01.000Z', inspect: () => structuredClone(state),
          renameCurrentToRollback: () => undefined, renameStagedToCurrent: () => undefined,
          renameCurrentToStaged: () => undefined, renameRollbackToCurrent: () => undefined,
          restart: () => undefined,
        };
      },
    };
    runRepositoryReleaseCommand(['freeze', 'begin', '--request-file', '/tmp/freeze.json',
      '--operation-id', 'op-begin'], deps, out.adapter);
    runRepositoryReleaseCommand(['freeze', 'finalize', '--barrier-id', freeze.barrierId,
      '--expected-revision', '1', '--operation-id', 'op-finalize'], deps, out.adapter);
    input = request(2);
    const receipt = runRepositoryReleaseCommand(['transaction', 'run', '--request-file', '/tmp/tx.json'],
      deps, out.adapter);
    expect(receipt).toMatchObject({ status: 'verified', transactionId: input.transactionId });
    const inspected = runRepositoryReleaseCommand(['transaction', 'inspect', '--transaction-id', input.transactionId,
      '--json'], deps, out.adapter);
    expect(inspected).toMatchObject({ status: 'verified' });
    expect(runRepositoryReleaseCommand(
      ['transaction', 'run', '--request-file', '/tmp/tx.json'], deps, out.adapter,
    )).toMatchObject({ status: 'verified', transactionId: input.transactionId });
  });

  it('freshly inspects the host before replaying a terminal transaction receipt', () => {
    const dataDir = tempDataDir();
    const out = io();
    const freeze = {
      workdir: '/tmp/worktree', barrierId: 'barrier-command', expectedRevision: 0,
      authorizationRef: 'om_x100b63f8d42964a10c752d313c3598c', snapshot: snapshot(),
    };
    let input: ReleaseTransactionRequest | Record<string, unknown> = freeze;
    let adapterCreations = 0;
    const deps = {
      dataDir,
      env: { XDG_RUNTIME_DIR: '/run/user/0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/0/bus' },
      resolveIdentity: () => identity,
      findIdentityByBarrierId: () => identity,
      readJsonFile: () => input,
      validateFreezeSnapshot: trustSnapshot,
      canonicalizeWorktree: value => value,
      hostname: () => 'host',
      now: () => '2026-10-12T10:00:00.000Z',
      createTransactionAdapters: (value: ReleaseTransactionRequest): ReleaseTransactionAdapters => {
        adapterCreations += 1;
        const live = adapterCreations === 1;
        return {
          now: () => '2026-10-12T10:00:01.000Z',
          inspect: () => ({
            layout: live ? 'new-dist-new-runtime' : 'unknown',
            artifactTreeHash: live ? value.artifactTreeHash : null,
            stagedArtifactTreeHash: null,
            rollbackTreeHash: live ? value.rollbackTreeHash : null,
            runtimeHash: live ? value.targetRuntimeHash : null,
            sameFilesystem: true, serviceInspectable: true, serviceActive: true,
            fleetHealthy: true, cgroupHealthy: true, liveBehaviorHealthy: true,
            completionGateHealthy: true,
          }),
          renameCurrentToRollback: () => undefined, renameStagedToCurrent: () => undefined,
          renameCurrentToStaged: () => undefined, renameRollbackToCurrent: () => undefined,
          restart: () => undefined,
        };
      },
    };
    runRepositoryReleaseCommand(['freeze', 'begin', '--request-file', '/tmp/freeze.json',
      '--operation-id', 'op-terminal-begin'], deps, out.adapter);
    runRepositoryReleaseCommand(['freeze', 'finalize', '--barrier-id', freeze.barrierId,
      '--expected-revision', '1', '--operation-id', 'op-terminal-finalize'], deps, out.adapter);
    input = request(2);
    expect(runRepositoryReleaseCommand(
      ['transaction', 'run', '--request-file', '/tmp/tx.json'], deps, out.adapter,
    )).toMatchObject({ status: 'verified' });

    expect(runRepositoryReleaseCommand(
      ['transaction', 'run', '--request-file', '/tmp/tx.json'], deps, out.adapter,
    )).toMatchObject({ status: 'unknown' });
    expect(adapterCreations).toBe(2);
  });

  it('rejects release mutation from a managed agent context before constructing host adapters', () => {
    const dataDir = tempDataDir();
    const out = io();
    const freeze = {
      workdir: '/tmp/worktree', barrierId: 'barrier-managed', expectedRevision: 0,
      authorizationRef: 'om_x100b63f8d42964a10c752d313c3598c', snapshot: snapshot(),
    };
    let input: ReleaseTransactionRequest | Record<string, unknown> = freeze;
    const createTransactionAdapters = vi.fn(() => {
      throw new Error('host_adapter_must_not_be_constructed');
    });
    const deps = {
      dataDir,
      env: {
        XDG_RUNTIME_DIR: '/run/user/0',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/0/bus',
        BOTMUX_SESSION_ID: 'managed-session',
      },
      resolveIdentity: () => identity,
      findIdentityByBarrierId: () => identity,
      readJsonFile: () => input,
      validateFreezeSnapshot: trustSnapshot,
      canonicalizeWorktree: value => value,
      isManagedHostContext: () => input !== freeze,
      hostname: () => 'host',
      now: () => '2026-10-12T10:00:00.000Z',
      createTransactionAdapters,
    };
    runRepositoryReleaseCommand(['freeze', 'begin', '--request-file', '/tmp/freeze.json',
      '--operation-id', 'op-managed-begin'], deps, out.adapter);
    runRepositoryReleaseCommand(['freeze', 'finalize', '--barrier-id', freeze.barrierId,
      '--expected-revision', '1', '--operation-id', 'op-managed-finalize'], deps, out.adapter);
    input = request(2);

    expect(() => runRepositoryReleaseCommand(
      ['transaction', 'run', '--request-file', '/tmp/tx.json'], deps, out.adapter,
    )).toThrow('repository_release_managed_context');
    expect(createTransactionAdapters).not.toHaveBeenCalled();
  });

  it('rejects a frozen target host mismatch before constructing host adapters', () => {
    const dataDir = tempDataDir();
    const out = io();
    const freeze = {
      workdir: '/tmp/worktree', barrierId: 'barrier-wrong-host', expectedRevision: 0,
      authorizationRef: 'om_x100b63f8d42964a10c752d313c3598c', snapshot: snapshot(),
    };
    let input: ReleaseTransactionRequest | Record<string, unknown> = freeze;
    const createTransactionAdapters = vi.fn(() => {
      throw new Error('host_adapter_must_not_be_constructed');
    });
    const deps = {
      dataDir,
      env: { XDG_RUNTIME_DIR: '/run/user/0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/0/bus' },
      resolveIdentity: () => identity,
      findIdentityByBarrierId: () => identity,
      readJsonFile: () => input,
      validateFreezeSnapshot: trustSnapshot,
      canonicalizeWorktree: value => value,
      isManagedHostContext: () => false,
      hostname: () => 'different-host',
      now: () => '2026-10-12T10:00:00.000Z',
      createTransactionAdapters,
    };
    runRepositoryReleaseCommand(['freeze', 'begin', '--request-file', '/tmp/freeze.json',
      '--operation-id', 'op-wrong-host-begin'], deps, out.adapter);
    runRepositoryReleaseCommand(['freeze', 'finalize', '--barrier-id', freeze.barrierId,
      '--expected-revision', '1', '--operation-id', 'op-wrong-host-finalize'], deps, out.adapter);
    input = request(2);

    expect(() => runRepositoryReleaseCommand(
      ['transaction', 'run', '--request-file', '/tmp/tx.json'], deps, out.adapter,
    )).toThrow('repository_release_host_mismatch');
    expect(createTransactionAdapters).not.toHaveBeenCalled();
  });

  it('requires live verification evidence bound to this transaction runtime and observation window', () => {
    const input = request(2);
    const verification = snapshot().releaseVerification as {
      projectChatId: string;
      stageAdvanceFingerprint: string;
      completionGateId: string;
      expectedFleetAppIds: string[];
    };
    const evidenceToken = `release:${input.transactionId}:${input.targetRuntimeHash}`;
    const project = {
      stageAdvanceEvents: [{
        fingerprint: verification.stageAdvanceFingerprint,
        status: 'dispatched', triggerId: evidenceToken,
        updatedAt: '2026-10-12T10:00:02.000Z',
      }],
      completionGates: [{
        gateId: verification.completionGateId, status: 'satisfied',
        checkedAt: '2026-10-12T10:00:03.000Z',
        evidence: {
          reviewerVerdictId: input.transactionId,
          terminalEventId: input.targetRuntimeHash,
          deliveryReceiptId: evidenceToken,
        },
      }],
    } as never;

    expect(hasTransactionBoundReleaseEvidence(
      project, verification, input, '2026-10-12T10:00:01.000Z', {
        schemaVersion: 1, transactionId: input.transactionId,
        targetRuntimeHash: input.targetRuntimeHash, projectChatId: verification.projectChatId,
        stageAdvanceFingerprint: verification.stageAdvanceFingerprint,
        completionGateId: verification.completionGateId,
        observedAfter: '2026-10-12T10:00:01.000Z', status: 'produced',
        stageTriggerId: evidenceToken, stageUpdatedAt: '2026-10-12T10:00:02.000Z',
        completionCheckedAt: '2026-10-12T10:00:03.000Z', producedAt: '2026-10-12T10:00:03.000Z',
      },
    )).toBe(true);
    expect(hasTransactionBoundReleaseEvidence(
      project, verification, input, '2026-10-12T10:00:04.000Z', undefined,
    )).toBe(false);
  });

  it('rejects directory rename after the validated parent pathname is replaced', () => {
    const parent = tempDataDir();
    const displaced = `${parent}.displaced`;
    roots.push(displaced);
    const current = join(parent, 'current');
    const staged = join(parent, 'staged');
    const rollback = join(parent, 'rollback');
    mkdirSync(current, { mode: 0o700 });
    mkdirSync(staged, { mode: 0o700 });
    writeFileSync(join(current, 'old.txt'), 'old\n');
    writeFileSync(join(staged, 'new.txt'), 'new\n');
    const input = {
      ...request(2), deploymentPath: current, artifactPath: staged, rollbackArtifactPath: rollback,
    };
    const adapters = createHostReleaseTransactionAdapters(
      tempDataDir(), input, snapshot({
        deploymentPath: current, artifactPath: staged, rollbackArtifactPath: rollback,
      }) as never,
      { XDG_RUNTIME_DIR: '/run/user/0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/0/bus' },
    );

    renameSync(parent, displaced);
    mkdirSync(parent, { mode: 0o700 });
    mkdirSync(join(parent, 'current'), { mode: 0o700 });
    writeFileSync(join(parent, 'current', 'attacker.txt'), 'attacker\n');
    expect(() => adapters.renameCurrentToRollback(input)).toThrow('release_parent_directory_changed');
    expect(existsSync(join(displaced, 'rollback'))).toBe(false);
    expect(existsSync(join(parent, 'current', 'attacker.txt'))).toBe(true);
    adapters.close?.();
  });

  it('rejects a fresh runtime descriptor whose process birth identity does not match procfs', () => {
    const parent = tempDataDir();
    const current = join(parent, 'current');
    const staged = join(parent, 'staged');
    const rollback = join(parent, 'rollback');
    mkdirSync(current, { mode: 0o700 });
    mkdirSync(staged, { mode: 0o700 });
    mkdirSync(rollback, { mode: 0o700 });
    writeFileSync(join(current, 'runtime.txt'), 'new\n');
    writeFileSync(join(staged, 'runtime.txt'), 'staged\n');
    writeFileSync(join(rollback, 'runtime.txt'), 'old\n');
    const hashLeaf = (content: string) => {
      const contentHash = createHash('sha256').update(content).digest('hex');
      return createHash('sha256').update(`${contentHash}  ./runtime.txt\n`).digest('hex');
    };
    const targetRuntimeHash = 'f'.repeat(64);
    const dataDir = tempDataDir();
    const descriptorDir = join(dataDir, 'dashboard-daemons');
    mkdirSync(descriptorDir, { mode: 0o700 });
    const descriptorPath = join(descriptorDir, `daemon-${'a'.repeat(64)}.json`);
    writeFileSync(descriptorPath, `${JSON.stringify({
      larkAppId: 'cli_worker', pid: process.pid, processStartIdentity: 'definitely-wrong',
      runtimeGeneration: targetRuntimeHash, lastHeartbeat: Date.now(),
    })}\n`, { mode: 0o600 });
    chmodSync(descriptorPath, 0o600);
    const input = {
      ...request(2), deploymentPath: current, artifactPath: staged, rollbackArtifactPath: rollback,
      artifactTreeHash: hashLeaf('new\n'), rollbackTreeHash: hashLeaf('old\n'), targetRuntimeHash,
    };
    const adapters = createHostReleaseTransactionAdapters(dataDir, input, snapshot({
      deploymentPath: current, artifactPath: staged, rollbackArtifactPath: rollback,
      artifactTreeHash: input.artifactTreeHash, rollbackTreeHash: input.rollbackTreeHash, targetRuntimeHash,
    }) as never, { XDG_RUNTIME_DIR: '/run/user/0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/0/bus' });
    try {
      expect(adapters.inspect(input).fleetHealthy).toBe(false);
    } finally {
      adapters.close?.();
    }
  });

  it('publishes a durable transaction-bound live probe request before restart', () => {
    const parent = tempDataDir();
    const current = join(parent, 'current');
    const staged = join(parent, 'staged');
    const rollback = join(parent, 'rollback');
    for (const path of [current, staged, rollback]) mkdirSync(path, { mode: 0o700 });
    const dataDir = tempDataDir();
    const binDir = tempDataDir();
    const systemctl = join(binDir, 'systemctl');
    writeFileSync(systemctl, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    chmodSync(systemctl, 0o700);
    const input = {
      ...request(2), deploymentPath: current, artifactPath: staged, rollbackArtifactPath: rollback,
    };
    const adapters = createHostReleaseTransactionAdapters(dataDir, input, snapshot({
      deploymentPath: current, artifactPath: staged, rollbackArtifactPath: rollback,
    }) as never, {
      PATH: binDir, XDG_RUNTIME_DIR: '/run/user/0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/0/bus',
    });
    try {
      adapters.restart(input);
      const probe = JSON.parse(readFileSync(join(
        dataDir, 'repository-release-probes', 'v1', `${input.transactionId}.json`,
      ), 'utf8'));
      expect(probe).toMatchObject({
        schemaVersion: 1, transactionId: input.transactionId, targetRuntimeHash: input.targetRuntimeHash,
        projectChatId: 'oc_project', stageAdvanceFingerprint: 'psa1:release',
        completionGateId: 'gate-release', status: 'pending',
      });
    } finally {
      adapters.close?.();
    }
  });

  it('rejects an internal artifact symlink before inspecting systemd or mutating directories', () => {
    const parent = tempDataDir();
    const current = join(parent, 'current');
    const staged = join(parent, 'staged');
    const rollback = join(parent, 'rollback');
    mkdirSync(current, { mode: 0o700 });
    mkdirSync(staged, { mode: 0o700 });
    symlinkSync('/etc/passwd', join(current, 'escape'));
    const input = {
      ...request(2), deploymentPath: current, artifactPath: staged, rollbackArtifactPath: rollback,
    };
    const adapters = createHostReleaseTransactionAdapters(
      tempDataDir(), input, snapshot({
        deploymentPath: current, artifactPath: staged, rollbackArtifactPath: rollback,
      }) as never,
      { XDG_RUNTIME_DIR: '/run/user/0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/0/bus' },
    );
    try {
      expect(() => adapters.inspect(input)).toThrow('release_artifact_tree_invalid');
    } finally {
      adapters.close?.();
    }
  });

  it.each([
    ['transactionId', 'tx-rogue-01234567'],
    ['commitSha', '4'.repeat(40)],
    ['treeSha', '5'.repeat(40)],
    ['artifactPath', '/rogue/next'],
    ['artifactTreeHash', '6'.repeat(64)],
    ['rollbackArtifactPath', '/rogue/rollback'],
    ['rollbackTreeHash', '7'.repeat(64)],
    ['targetRuntimeHash', '8'.repeat(64)],
    ['oldRuntimeHash', '9'.repeat(64)],
    ['requiredChecksHash', '4'.repeat(64)],
    ['independentReviewHash', '5'.repeat(64)],
    ['deploymentPath', '/rogue/live'],
    ['unit', 'rogue.service'],
    ['host', 'rogue-host'],
  ] as const)('rejects transaction %s drift from the frozen snapshot before host effects', (field, value) => {
    const dataDir = tempDataDir();
    const out = io();
    const freeze = {
      workdir: '/tmp/worktree', barrierId: 'barrier-command', expectedRevision: 0,
      authorizationRef: 'om_x100b63f8d42964a10c752d313c3598c', snapshot: snapshot(),
    };
    let input: Record<string, unknown> = freeze;
    const effects: string[] = [];
    const deps = {
      dataDir,
      env: { XDG_RUNTIME_DIR: '/run/user/0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/0/bus' },
      resolveIdentity: () => identity,
      findIdentityByBarrierId: () => identity,
      readJsonFile: () => input,
      validateFreezeSnapshot: trustSnapshot,
      canonicalizeWorktree: value => value,
      hostname: () => 'host',
      now: () => '2026-10-12T10:00:00.000Z',
      createTransactionAdapters: (candidate: ReleaseTransactionRequest): ReleaseTransactionAdapters => {
        let state = {
          layout: 'new-dist-old-runtime' as const, artifactTreeHash: candidate.artifactTreeHash,
          stagedArtifactTreeHash: null, rollbackTreeHash: candidate.rollbackTreeHash,
          runtimeHash: candidate.oldRuntimeHash, sameFilesystem: true, serviceInspectable: true,
          serviceActive: true, fleetHealthy: true, cgroupHealthy: true,
          liveBehaviorHealthy: true, completionGateHealthy: true,
        };
        return {
          now: () => '2026-10-12T10:00:01.000Z', inspect: () => structuredClone(state),
          renameCurrentToRollback: () => effects.push('rename_current_to_rollback'),
          renameStagedToCurrent: () => effects.push('rename_staged_to_current'),
          renameCurrentToStaged: () => effects.push('rename_current_to_staged'),
          renameRollbackToCurrent: () => effects.push('rename_rollback_to_current'),
          restart: () => {
            effects.push('restart');
            state = { ...state, layout: 'new-dist-new-runtime', runtimeHash: candidate.targetRuntimeHash };
          },
        };
      },
    };
    runRepositoryReleaseCommand(['freeze', 'begin', '--request-file', '/tmp/freeze.json',
      '--operation-id', `op-begin-${field}`], deps, out.adapter);
    runRepositoryReleaseCommand(['freeze', 'finalize', '--barrier-id', freeze.barrierId,
      '--expected-revision', '1', '--operation-id', `op-finalize-${field}`], deps, out.adapter);
    input = { ...request(2), [field]: value };

    expect(() => runRepositoryReleaseCommand(
      ['transaction', 'run', '--request-file', '/tmp/tx.json'], deps, out.adapter,
    )).toThrow('release_transaction_snapshot_mismatch');
    expect(effects).toEqual([]);
  });

  it('resumes the same durable transaction_active request without repeating a confirmed restart', () => {
    const dataDir = tempDataDir();
    const out = io();
    const freeze = {
      workdir: '/tmp/worktree', barrierId: 'barrier-command', expectedRevision: 0,
      authorizationRef: 'om_x100b63f8d42964a10c752d313c3598c', snapshot: snapshot(),
    };
    let input: ReleaseTransactionRequest | Record<string, unknown> = freeze;
    const restart = vi.fn();
    const deps = {
      dataDir,
      env: { XDG_RUNTIME_DIR: '/run/user/0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/0/bus' },
      resolveIdentity: () => identity,
      findIdentityByBarrierId: () => identity,
      readJsonFile: () => input,
      validateFreezeSnapshot: trustSnapshot,
      canonicalizeWorktree: value => value,
      hostname: () => 'host',
      now: () => '2026-10-12T10:00:03.000Z',
      createTransactionAdapters: (candidate: ReleaseTransactionRequest): ReleaseTransactionAdapters => ({
        now: () => '2026-10-12T10:00:04.000Z',
        inspect: () => ({
          layout: 'new-dist-new-runtime', artifactTreeHash: candidate.artifactTreeHash,
          stagedArtifactTreeHash: null, rollbackTreeHash: candidate.rollbackTreeHash,
          runtimeHash: candidate.targetRuntimeHash, sameFilesystem: true, serviceInspectable: true,
          serviceActive: true, fleetHealthy: true, cgroupHealthy: true,
          liveBehaviorHealthy: true, completionGateHealthy: true,
        }),
        renameCurrentToRollback: () => undefined,
        renameStagedToCurrent: () => undefined,
        renameCurrentToStaged: () => undefined,
        renameRollbackToCurrent: () => undefined,
        restart,
      }),
    };
    runRepositoryReleaseCommand(['freeze', 'begin', '--request-file', '/tmp/freeze.json',
      '--operation-id', 'op-begin-resume'], deps, out.adapter);
    runRepositoryReleaseCommand(['freeze', 'finalize', '--barrier-id', freeze.barrierId,
      '--expected-revision', '1', '--operation-id', 'op-finalize-resume'], deps, out.adapter);
    input = request(2);
    createReleaseTransaction(dataDir, input);
    appendReleaseJournalEvent(dataDir, input.transactionId, {
      at: '2026-10-12T10:00:00.000Z', type: 'prepared', phase: 'prepare',
    });
    appendReleaseJournalEvent(dataDir, input.transactionId, {
      at: '2026-10-12T10:00:01.000Z', type: 'intent', phase: 'commit', action: 'restart',
    });
    appendReleaseJournalEvent(dataDir, input.transactionId, {
      at: '2026-10-12T10:00:02.000Z', type: 'result', phase: 'commit', action: 'restart',
      details: { ok: true },
    });
    beginRepositoryTransaction(dataDir, {
      identity, operationId: input.operationId, barrierId: input.barrierId,
      expectedRevision: input.barrierRevision, transactionId: input.transactionId,
      now: '2026-10-12T10:00:02.000Z',
    });

    expect(runRepositoryReleaseCommand(
      ['transaction', 'run', '--request-file', '/tmp/tx.json'], deps, out.adapter,
    )).toMatchObject({ status: 'verified', restartCount: 1 });
    expect(restart).not.toHaveBeenCalled();
    expect(readRepositoryControl(dataDir, identity).releaseBarrier.state).toBe('released');
  });
});

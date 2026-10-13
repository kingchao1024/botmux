import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  readRepositoryControlState,
  repositoryControlStatePath,
} from '../src/services/repository-control-store.js';
import {
  acquireRepositoryWriter,
  beginRepositoryFreeze,
  finalizeRepositoryFreeze,
} from '../src/services/repository-control.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

const roots: string[] = [];
const identity = {
  repoKey: 'a'.repeat(64),
  canonicalCommonDir: '/tmp/repository-control-test.git',
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'botmux-repository-control-store-'));
  roots.push(root);
  chmodSync(root, 0o700);
  return root;
}

function releaseSnapshot(): Record<string, unknown> {
  return {
    repoKey: identity.repoKey,
    canonicalCommonDir: identity.canonicalCommonDir,
    worktreePath: '/tmp/worktree',
    transactionId: 'tx-store-corruption',
    commitSha: '1'.repeat(40),
    treeSha: '2'.repeat(40),
    remoteRef: 'refs/remotes/origin/main',
    remoteCommitSha: '1'.repeat(40),
    worktreeClean: true,
    bunVersion: '1.4.2',
    buildToolchainHash: '9'.repeat(64),
    artifactPath: '/srv/next',
    artifactTreeHash: '3'.repeat(64),
    rollbackArtifactPath: '/srv/rollback',
    rollbackTreeHash: '4'.repeat(64),
    targetRuntimeHash: '5'.repeat(64),
    oldRuntimeHash: '6'.repeat(64),
    requiredChecksHash: '7'.repeat(64),
    independentReviewHash: '8'.repeat(64),
    deploymentPath: '/srv/live',
    unit: 'botmux.service',
    host: 'release-host',
    releaseVerification: {
      projectChatId: 'oc_project',
      stageAdvanceFingerprint: 'psa1:release',
      completionGateId: 'gate-release',
      expectedFleetAppIds: ['cli_worker'],
    },
  };
}

function collect(child: ReturnType<typeof spawnTsEvalWithRepoImports>): Promise<{ code: number | null; stdout: string }> {
  return new Promise(resolve => {
    let stdout = '';
    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    child.on('close', code => resolve({ code, stdout }));
  });
}

describe('repository control store', () => {
  it('rejects symlink state files and wrong modes', () => {
    const dataDir = fixture();
    const file = repositoryControlStatePath(dataDir, identity.repoKey);
    mkdirSync(join(dataDir, 'repository-control', 'v1'), { recursive: true, mode: 0o700 });
    const target = join(dataDir, 'target.json');
    writeFileSync(target, '{}', { mode: 0o600 });
    symlinkSync(target, file);

    expect(() => readRepositoryControlState(dataDir, identity)).toThrow();
    rmSync(file);
    writeFileSync(file, '{}', { mode: 0o644 });
    expect(() => readRepositoryControlState(dataDir, identity)).toThrow(/0600/);
  });

  it('rejects a persisted frozen snapshot corrupted with an unknown field', () => {
    const dataDir = fixture();
    const draining = beginRepositoryFreeze(dataDir, {
      identity,
      operationId: 'begin-corruption-test',
      barrierId: 'barrier-corruption-test',
      authorizationRef: 'om_authorized',
      snapshot: releaseSnapshot(),
      now: '2026-10-12T00:00:00.000Z',
    });
    finalizeRepositoryFreeze(dataDir, {
      identity,
      operationId: 'finalize-corruption-test',
      barrierId: 'barrier-corruption-test',
      expectedRevision: draining.revision,
      snapshot: releaseSnapshot(),
      now: '2026-10-12T00:01:00.000Z',
    });
    const file = repositoryControlStatePath(dataDir, identity.repoKey);
    const state = JSON.parse(readFileSync(file, 'utf8')) as {
      releaseBarrier: { snapshot: Record<string, unknown> };
    };
    state.releaseBarrier.snapshot.untrusted = true;
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);

    expect(() => readRepositoryControlState(dataDir, identity))
      .toThrow('repository_control_state_corrupt');
  });

  it('serializes cross-process CAS for one repoKey and preserves the winning revision', async () => {
    const dataDir = fixture();
    const source = (suffix: string) => `
      import { acquireRepositoryWriter } from './src/services/repository-control.js';
      const result = acquireRepositoryWriter(${JSON.stringify(dataDir)}, {
        identity: ${JSON.stringify(identity)}, operationId: 'op-${suffix}', now: '2026-10-12T00:00:00.000Z',
        owner: { chatId: 'chat-${suffix}', dispatchRoot: 'root-${suffix}', taskGuid: 'task-${suffix}',
          controllerAppId: 'controller', workerAppId: 'worker', sessionId: 'session-${suffix}',
          workerGeneration: 1, workingDir: '/tmp/work-${suffix}', declaredScopes: ['/tmp/work-${suffix}'] }
      });
      process.stdout.write(JSON.stringify(result));
    `;
    const [left, right] = await Promise.all([
      collect(spawnTsEvalWithRepoImports(source('left'), { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })),
      collect(spawnTsEvalWithRepoImports(source('right'), { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })),
    ]);

    expect([left.code, right.code].sort()).toEqual([0, 1]);
    const state = readRepositoryControlState(dataDir, identity);
    expect(state.revision).toBe(1);
    expect(state.writerLease?.fencingToken).toBe(1);
  });

  it('keeps unrelated repoKeys independently writable', () => {
    const dataDir = fixture();
    const owner = (suffix: string) => ({
      chatId: `chat-${suffix}`, dispatchRoot: `root-${suffix}`, taskGuid: `task-${suffix}`,
      controllerAppId: 'controller', workerAppId: 'worker', sessionId: `session-${suffix}`,
      workerGeneration: 1, workingDir: `/tmp/${suffix}`, declaredScopes: [`/tmp/${suffix}`],
    });
    const first = acquireRepositoryWriter(dataDir, {
      identity, operationId: 'first', owner: owner('first'), now: '2026-10-12T00:00:00.000Z',
    });
    const second = acquireRepositoryWriter(dataDir, {
      identity: { ...identity, repoKey: 'b'.repeat(64) }, operationId: 'second', owner: owner('second'),
      now: '2026-10-12T00:00:00.000Z',
    });
    expect(first.lease.fencingToken).toBe(1);
    expect(second.lease.fencingToken).toBe(1);
  });
});

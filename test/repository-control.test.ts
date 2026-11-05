import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  acquireRepositoryWriter,
  beginRepositoryFreeze,
  bindRepositoryWriterGeneration,
  cancelRepositoryFreeze,
  finalizeRepositoryFreeze,
  heartbeatRepositoryWriter,
  readRepositoryControl,
  rebindRepositoryWriterDispatchRoot,
  releaseRepositoryWriter,
} from '../src/services/repository-control.js';

let dataDir: string;
const roots: string[] = [];
const identity = { repoKey: 'c'.repeat(64), canonicalCommonDir: '/tmp/repository-control.git' };
const owner = {
  chatId: 'chat', dispatchRoot: 'root', taskGuid: 'task', controllerAppId: 'controller',
  workerAppId: 'worker', sessionId: 'session', workerGeneration: 7,
  workingDir: '/tmp/worktree', declaredScopes: ['/tmp/worktree'],
};

function releaseSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repoKey: identity.repoKey,
    canonicalCommonDir: identity.canonicalCommonDir,
    worktreePath: '/tmp/worktree',
    transactionId: 'tx-repository-control',
    commitSha: 'a'.repeat(40),
    treeSha: 'b'.repeat(40),
    remoteRef: 'refs/remotes/origin/main',
    remoteCommitSha: 'a'.repeat(40),
    worktreeClean: true,
    bunVersion: '1.4.3',
    buildToolchainHash: '9'.repeat(64),
    artifactPath: '/srv/botmux.next',
    artifactTreeHash: 'c'.repeat(64),
    rollbackArtifactPath: '/srv/botmux.rollback',
    rollbackTreeHash: 'd'.repeat(64),
    targetRuntimeHash: 'e'.repeat(64),
    oldRuntimeHash: 'f'.repeat(64),
    requiredChecksHash: '1'.repeat(64),
    independentReviewHash: '2'.repeat(64),
    deploymentPath: '/srv/botmux',
    unit: 'botmux.service',
    host: 'release-host',
    releaseVerification: {
      projectChatId: 'oc_project',
      stageAdvanceFingerprint: 'psa1:release',
      completionGateId: 'gate-release',
      expectedFleetAppIds: ['cli_worker'],
    },
    ...overrides,
  };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-repository-control-'));
  chmodSync(dataDir, 0o700);
  roots.push(dataDir);
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('repository control service', () => {
  it('replays the same operationId only for byte-equivalent input', () => {
    const request = { identity, operationId: 'same-op', owner, now: '2026-10-12T00:00:00.000Z' };
    const first = acquireRepositoryWriter(dataDir, request);
    expect(acquireRepositoryWriter(dataDir, request)).toEqual(first);
    expect(acquireRepositoryWriter(dataDir, {
      ...request, now: '2026-10-12T00:00:01.000Z',
    })).toEqual(first);
    expect(() => acquireRepositoryWriter(dataDir, {
      ...request, owner: { ...owner, sessionId: 'different' },
    })).toThrow('repository_operation_input_conflict');
  });

  it('increments fencingToken monotonically and rejects stale heartbeat or release', () => {
    const first = acquireRepositoryWriter(dataDir, {
      identity, operationId: 'acquire-1', owner, now: '2026-10-12T00:00:00.000Z',
    });
    releaseRepositoryWriter(dataDir, {
      identity, operationId: 'release-1', leaseId: first.lease.leaseId,
      fencingToken: first.lease.fencingToken, now: '2026-10-12T00:01:00.000Z',
    });
    const second = acquireRepositoryWriter(dataDir, {
      identity, operationId: 'acquire-2', owner, now: '2026-10-12T00:02:00.000Z',
    });
    expect(second.lease.fencingToken).toBe(first.lease.fencingToken + 1);
    expect(() => heartbeatRepositoryWriter(dataDir, {
      identity, operationId: 'late-heartbeat', leaseId: first.lease.leaseId,
      fencingToken: first.lease.fencingToken, sessionId: owner.sessionId,
      workerGeneration: owner.workerGeneration, now: '2026-10-12T00:03:00.000Z',
    })).toThrow('repository_lease_stale_token');
    expect(() => releaseRepositoryWriter(dataDir, {
      identity, operationId: 'late-release', leaseId: first.lease.leaseId,
      fencingToken: first.lease.fencingToken, now: '2026-10-12T00:03:00.000Z',
    })).toThrow('repository_lease_stale_token');
  });

  it('atomically replaces the reservation identity with the real root before generation binding', () => {
    const acquired = acquireRepositoryWriter(dataDir, {
      identity,
      operationId: 'reservation-1:acquire',
      owner: { ...owner, dispatchRoot: 'reservation-1' },
      now: '2026-10-12T00:00:00.000Z',
    });
    rebindRepositoryWriterDispatchRoot(dataDir, {
      identity,
      operationId: 'reservation-1:bind-root',
      leaseId: acquired.leaseRef.leaseId,
      fencingToken: acquired.leaseRef.fencingToken,
      reservationId: 'reservation-1',
      dispatchRoot: 'om_real_root',
      now: '2026-10-12T00:00:01.000Z',
    });

    expect(bindRepositoryWriterGeneration(dataDir, {
      identity,
      operationId: 'reservation-1:bind-generation',
      leaseId: acquired.leaseRef.leaseId,
      fencingToken: acquired.leaseRef.fencingToken,
      dispatchRoot: 'om_real_root',
      workerAppId: owner.workerAppId,
      workingDir: owner.workingDir,
      sessionId: 'worker-session',
      workerGeneration: 8,
      now: '2026-10-12T00:00:02.000Z',
    }).lease).toMatchObject({
      dispatchRoot: 'om_real_root',
      sessionId: 'worker-session',
      workerGeneration: 8,
    });
  });

  it('linearizes acquireWriter against beginFreeze and keeps draining fail-closed', () => {
    const first = acquireRepositoryWriter(dataDir, {
      identity, operationId: 'writer', owner, now: '2026-10-12T00:00:00.000Z',
    });
    const draining = beginRepositoryFreeze(dataDir, {
      identity, operationId: 'freeze', barrierId: 'barrier', authorizationRef: 'om_auth',
      now: '2026-10-12T00:01:00.000Z',
    });
    expect(draining.barrier.state).toBe('draining');
    expect(() => acquireRepositoryWriter(dataDir, {
      identity, operationId: 'blocked', owner: { ...owner, sessionId: 'next' },
      now: '2026-10-12T00:02:00.000Z',
    })).toThrow('repository_barrier_blocks_writer');
    expect(() => finalizeRepositoryFreeze(dataDir, {
      identity, operationId: 'too-early', barrierId: 'barrier',
      expectedRevision: draining.revision, snapshot: { commitSha: 'a'.repeat(40) },
      now: '2026-10-12T00:02:00.000Z',
    })).toThrow('repository_writer_still_active');
    expect(readRepositoryControl(dataDir, identity).releaseBarrier.state).toBe('draining');

    heartbeatRepositoryWriter(dataDir, {
      identity, operationId: 'heartbeat', leaseId: first.lease.leaseId,
      fencingToken: first.lease.fencingToken, sessionId: owner.sessionId,
      workerGeneration: owner.workerGeneration, now: '2026-10-12T00:03:00.000Z',
    });
    const released = releaseRepositoryWriter(dataDir, {
      identity, operationId: 'release', leaseId: first.lease.leaseId,
      fencingToken: first.lease.fencingToken, now: '2026-10-12T00:04:00.000Z',
    });
    const frozen = finalizeRepositoryFreeze(dataDir, {
      identity, operationId: 'finalize', barrierId: 'barrier', expectedRevision: released.revision,
      snapshot: releaseSnapshot(), now: '2026-10-12T00:05:00.000Z',
    });
    expect(frozen.barrier.state).toBe('frozen');
  });

  it('does not reclaim an expired heartbeat without proven generation termination', () => {
    acquireRepositoryWriter(dataDir, {
      identity, operationId: 'old-writer', owner, now: '2020-01-01T00:00:00.000Z',
    });
    expect(() => acquireRepositoryWriter(dataDir, {
      identity, operationId: 'new-writer', owner: { ...owner, sessionId: 'new-session' },
      now: '2030-01-01T00:00:00.000Z',
    })).toThrow('repository_writer_conflict');
  });

  it('keeps read-only queries available while frozen', () => {
    const draining = beginRepositoryFreeze(dataDir, {
      identity, operationId: 'freeze', barrierId: 'barrier', authorizationRef: 'om_auth',
      now: '2026-10-12T00:00:00.000Z',
    });
    finalizeRepositoryFreeze(dataDir, {
      identity, operationId: 'finalize', barrierId: 'barrier', expectedRevision: draining.revision,
      snapshot: releaseSnapshot(), now: '2026-10-12T00:01:00.000Z',
    });
    expect(readRepositoryControl(dataDir, identity).releaseBarrier.state).toBe('frozen');
  });

  it.each([
    'repoKey',
    'canonicalCommonDir',
    'transactionId',
    'commitSha',
    'treeSha',
    'artifactPath',
    'artifactTreeHash',
    'rollbackArtifactPath',
    'rollbackTreeHash',
    'targetRuntimeHash',
    'oldRuntimeHash',
    'requiredChecksHash',
    'independentReviewHash',
    'deploymentPath',
    'unit',
    'host',
    'releaseVerification',
  ])('rejects a frozen snapshot missing %s', field => {
    const draining = beginRepositoryFreeze(dataDir, {
      identity, operationId: `freeze-${field}`, barrierId: `barrier-${field}`,
      authorizationRef: 'om_auth', now: '2026-10-12T00:00:00.000Z',
    });
    const snapshot = releaseSnapshot();
    delete snapshot[field];

    expect(() => finalizeRepositoryFreeze(dataDir, {
      identity, operationId: `finalize-${field}`, barrierId: `barrier-${field}`,
      expectedRevision: draining.revision, snapshot, now: '2026-10-12T00:01:00.000Z',
    })).toThrow('repository_release_snapshot_invalid');
  });

  it.each(['draining', 'frozen'] as const)(
    'rejects a mismatched cancellation authorization while %s',
    state => {
      const draining = beginRepositoryFreeze(dataDir, {
        identity, operationId: `freeze-${state}`, barrierId: `barrier-${state}`,
        authorizationRef: 'om_approved', now: '2026-10-12T00:00:00.000Z',
      });
      const current = state === 'frozen'
        ? finalizeRepositoryFreeze(dataDir, {
            identity, operationId: 'finalize-frozen', barrierId: 'barrier-frozen',
            expectedRevision: draining.revision, snapshot: releaseSnapshot(),
            now: '2026-10-12T00:01:00.000Z',
          })
        : draining;

      expect(() => cancelRepositoryFreeze(dataDir, {
        identity, operationId: `cancel-${state}`, barrierId: `barrier-${state}`,
        expectedRevision: current.revision, authorizationRef: 'om_wrong',
        now: '2026-10-12T00:02:00.000Z',
      })).toThrow('repository_barrier_authorization_mismatch');
      expect(readRepositoryControl(dataDir, identity).releaseBarrier.state).toBe(state);
    },
  );
});

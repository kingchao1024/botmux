import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendReleaseJournalEvent,
  createReleaseTransaction,
  type ReleaseTransactionRequest,
} from '../src/services/release-transaction-store.js';
import {
  runReleaseTransaction,
  type ReleaseObservedState,
  type ReleaseTransactionAdapters,
} from '../src/services/release-transaction.js';

const roots: string[] = [];

function tempDataDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'botmux-release-run-'));
  roots.push(root);
  return join(root, 'data');
}

function request(transactionId = 'tx-abcdef0123456789'): ReleaseTransactionRequest {
  return {
    schemaVersion: 1,
    transactionId,
    repoKey: 'a'.repeat(64),
    barrierId: 'barrier-1',
    barrierRevision: 7,
    authorizationRef: 'om_x100b63f8d42964a10c752d313c3598c',
    operationId: 'op-transaction-1',
    commitSha: 'b'.repeat(40),
    treeSha: 'c'.repeat(40),
    artifactPath: '/srv/botmux-next',
    artifactTreeHash: 'd'.repeat(64),
    rollbackArtifactPath: '/srv/botmux-rollback',
    rollbackTreeHash: 'e'.repeat(64),
    targetRuntimeHash: 'f'.repeat(64),
    oldRuntimeHash: '1'.repeat(64),
    requiredChecksHash: '2'.repeat(64),
    independentReviewHash: '3'.repeat(64),
    deploymentPath: '/srv/botmux',
    unit: 'botmux.service',
    host: 'release-host',
  };
}

type Fake = ReleaseTransactionAdapters & {
  state: ReleaseObservedState;
  calls: string[];
  restartError?: Error;
  rollbackRestartError?: Error;
};

function oldState(input: ReleaseTransactionRequest): ReleaseObservedState {
  return {
    layout: 'old-dist-old-runtime',
    artifactTreeHash: input.rollbackTreeHash,
    stagedArtifactTreeHash: input.artifactTreeHash,
    rollbackTreeHash: null,
    runtimeHash: input.oldRuntimeHash,
    sameFilesystem: true,
    serviceInspectable: true,
    serviceActive: true,
    fleetHealthy: true,
    cgroupHealthy: true,
    liveBehaviorHealthy: true,
    completionGateHealthy: true,
  };
}

function fakeAdapters(input: ReleaseTransactionRequest): Fake {
  let ticks = 0;
  const fake: Fake = {
    state: oldState(input),
    calls: [],
    now: () => `2026-10-12T10:00:${String(ticks++).padStart(2, '0')}.000Z`,
    inspect: () => structuredClone(fake.state),
    renameCurrentToRollback: () => {
      fake.calls.push('rename_current_to_rollback');
      fake.state.rollbackTreeHash = input.rollbackTreeHash;
      fake.state.artifactTreeHash = null;
      fake.state.layout = 'unknown';
    },
    renameStagedToCurrent: () => {
      fake.calls.push('rename_staged_to_current');
      fake.state.artifactTreeHash = input.artifactTreeHash;
      fake.state.stagedArtifactTreeHash = null;
      fake.state.layout = 'new-dist-old-runtime';
    },
    renameCurrentToStaged: () => {
      fake.calls.push('rename_current_to_staged');
      fake.state.stagedArtifactTreeHash = input.artifactTreeHash;
      fake.state.artifactTreeHash = null;
      fake.state.layout = 'unknown';
    },
    renameRollbackToCurrent: () => {
      fake.calls.push('rename_rollback_to_current');
      fake.state.artifactTreeHash = input.rollbackTreeHash;
      fake.state.rollbackTreeHash = null;
      fake.state.layout = 'old-dist-new-runtime';
    },
    restart: () => {
      fake.calls.push('restart');
      if (fake.state.artifactTreeHash === input.artifactTreeHash) {
        if (fake.restartError) throw fake.restartError;
        fake.state.runtimeHash = input.targetRuntimeHash;
        fake.state.layout = 'new-dist-new-runtime';
      } else {
        if (fake.rollbackRestartError) throw fake.rollbackRestartError;
        fake.state.runtimeHash = input.oldRuntimeHash;
        fake.state.layout = 'old-dist-old-runtime';
      }
    },
  };
  return fake;
}

function run(dataDir: string, input: ReleaseTransactionRequest, fake: Fake, overrides: Record<string, unknown> = {}) {
  return runReleaseTransaction({
    dataDir,
    request: input,
    expectedBarrier: {
      state: 'frozen',
      barrierId: input.barrierId,
      revision: input.barrierRevision,
      authorizationRef: input.authorizationRef,
    },
    env: {
      XDG_RUNTIME_DIR: '/run/user/0',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/0/bus',
    },
    adapters: fake,
    ...overrides,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('release transaction prepare', () => {
  it.each([
    [{ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/0/bus' }, 'release_systemd_bus_invalid'],
    [{ XDG_RUNTIME_DIR: '/run/user/0' }, 'release_systemd_bus_invalid'],
  ])('fails prepare when required systemd bus environment is missing', (env, error) => {
    const dataDir = tempDataDir();
    const input = request();
    const fake = fakeAdapters(input);
    expect(() => run(dataDir, input, fake, { env })).toThrow(error);
    expect(fake.calls).toEqual([]);
  });

  it('fails prepare when systemctl user cannot inspect the target unit', () => {
    const dataDir = tempDataDir();
    const input = request();
    const fake = fakeAdapters(input);
    fake.state.serviceInspectable = false;
    expect(() => run(dataDir, input, fake)).toThrow('release_systemd_unit_uninspectable');
    expect(fake.calls).toEqual([]);
  });

  it.each([
    ['artifactTreeHash', '9'.repeat(64)],
    ['stagedArtifactTreeHash', '9'.repeat(64)],
    ['rollbackTreeHash', '9'.repeat(64)],
    ['runtimeHash', '9'.repeat(64)],
  ] as const)('fails before rename or restart on %s drift', (field, value) => {
    const dataDir = tempDataDir();
    const input = request();
    const fake = fakeAdapters(input);
    (fake.state as unknown as Record<string, unknown>)[field] = value;
    expect(() => run(dataDir, input, fake)).toThrow('release_prepare_identity_mismatch');
    expect(fake.calls).toEqual([]);
  });

  it('rejects a barrier revision or authorizationRef mismatch', () => {
    const dataDir = tempDataDir();
    const input = request();
    const fake = fakeAdapters(input);
    expect(() => run(dataDir, input, fake, {
      expectedBarrier: { state: 'frozen', barrierId: input.barrierId, revision: 8,
        authorizationRef: input.authorizationRef },
    })).toThrow('release_barrier_mismatch');
    expect(() => run(dataDir, input, fake, {
      expectedBarrier: { state: 'frozen', barrierId: input.barrierId, revision: 7,
        authorizationRef: 'om_wrong' },
    })).toThrow('release_barrier_mismatch');
    expect(fake.calls).toEqual([]);
  });

  it('recognizes old-dist old-runtime and new-dist old-runtime but rejects unknown layouts', () => {
    const oldData = tempDataDir();
    const oldInput = request('tx-layout-old-0001');
    expect(run(oldData, oldInput, fakeAdapters(oldInput)).status).toBe('verified');

    const halfData = tempDataDir();
    const halfInput = request('tx-layout-half-001');
    const half = fakeAdapters(halfInput);
    half.state = {
      ...half.state,
      layout: 'new-dist-old-runtime',
      artifactTreeHash: halfInput.artifactTreeHash,
      stagedArtifactTreeHash: null,
      rollbackTreeHash: halfInput.rollbackTreeHash,
    };
    expect(run(halfData, halfInput, half).status).toBe('verified');
    expect(half.calls).toEqual(['restart']);

    const badData = tempDataDir();
    const badInput = request('tx-layout-bad-0001');
    const bad = fakeAdapters(badInput);
    bad.state.layout = 'unknown';
    expect(() => run(badData, badInput, bad)).toThrow('release_prepare_layout_unknown');
    expect(bad.calls).toEqual([]);
  });

  it('rejects cross-filesystem directory swaps before changing either directory', () => {
    const dataDir = tempDataDir();
    const input = request();
    const fake = fakeAdapters(input);
    fake.state.sameFilesystem = false;
    expect(() => run(dataDir, input, fake)).toThrow('release_cross_filesystem_swap');
    expect(fake.calls).toEqual([]);
  });
});

describe('release transaction commit, verify, rollback, and recovery', () => {
  it('writes intent before every rename or restart and result after it', () => {
    const dataDir = tempDataDir();
    const input = request();
    const fake = fakeAdapters(input);
    const receipt = run(dataDir, input, fake);
    expect(receipt.status).toBe('verified');
    for (const action of ['rename_current_to_rollback', 'rename_staged_to_current', 'restart']) {
      const actionEvents = receipt.events.filter(event => event.action === action);
      expect(actionEvents.map(event => event.type)).toEqual(['intent', 'result']);
    }
  });

  it('continues a new-dist old-runtime half-switch without repeating the completed rename', () => {
    const dataDir = tempDataDir();
    const input = request();
    const fake = fakeAdapters(input);
    fake.state = {
      ...fake.state,
      layout: 'new-dist-old-runtime', artifactTreeHash: input.artifactTreeHash,
      stagedArtifactTreeHash: null, rollbackTreeHash: input.rollbackTreeHash,
    };
    expect(run(dataDir, input, fake).status).toBe('verified');
    expect(fake.calls).toEqual(['restart']);
  });

  it('retries the same transaction without repeating a confirmed restart', () => {
    const dataDir = tempDataDir();
    const input = request();
    const first = fakeAdapters(input);
    expect(run(dataDir, input, first).status).toBe('verified');
    const second = fakeAdapters(input);
    second.state = structuredClone(first.state);
    expect(run(dataDir, input, second).status).toBe('verified');
    expect(second.calls).toEqual([]);
  });

  it('rejects the same transactionId with different input hashes', () => {
    const dataDir = tempDataDir();
    const input = request();
    createReleaseTransaction(dataDir, input);
    const fake = fakeAdapters(input);
    expect(() => run(dataDir, { ...input, treeSha: '9'.repeat(40) }, fake))
      .toThrow('release_transaction_request_conflict');
    expect(fake.calls).toEqual([]);
  });

  it('rolls back once when restart fails and never recurses through error handling', () => {
    const dataDir = tempDataDir();
    const input = request();
    const fake = fakeAdapters(input);
    fake.restartError = new Error('restart_failed');
    const receipt = run(dataDir, input, fake);
    expect(receipt.status).toBe('rolled_back');
    expect(fake.calls.filter(call => call === 'restart')).toHaveLength(2);
    expect(receipt.events.filter(event => event.type === 'rollback_started')).toHaveLength(1);
  });

  it('records rolled_back only after old runtime service fleet and cgroup checks pass', () => {
    const dataDir = tempDataDir();
    const input = request();
    const fake = fakeAdapters(input);
    fake.restartError = new Error('restart_failed');
    const originalRestart = fake.restart;
    fake.restart = requestValue => {
      originalRestart(requestValue);
      if (fake.state.runtimeHash === input.oldRuntimeHash) fake.state.cgroupHealthy = true;
    };
    expect(run(dataDir, input, fake).status).toBe('rolled_back');
  });

  it('records rollback_failed with residual evidence when rollback verification fails', () => {
    const dataDir = tempDataDir();
    const input = request();
    const fake = fakeAdapters(input);
    fake.restartError = new Error('restart_failed');
    fake.rollbackRestartError = new Error('rollback_restart_failed');
    const receipt = run(dataDir, input, fake);
    expect(receipt.status).toBe('rollback_failed');
    expect(receipt.events.at(-1)?.details).toMatchObject({ status: 'rollback_failed' });
  });

  it.each(['verified', 'rolled_back'] as const)(
    'returns an existing %s receipt without touching service state',
    status => {
      const dataDir = tempDataDir();
      const input = request(`tx-terminal-${status}`);
      createReleaseTransaction(dataDir, input);
      appendReleaseJournalEvent(dataDir, input.transactionId, {
        at: '2026-10-12T10:00:00.000Z', type: 'terminal', phase: status === 'verified' ? 'verify' : 'rollback',
        details: { status },
      });
      const fake = fakeAdapters(input);
      if (status === 'verified') {
        fake.state = { ...fake.state, layout: 'new-dist-new-runtime',
          artifactTreeHash: input.artifactTreeHash, stagedArtifactTreeHash: null,
          rollbackTreeHash: input.rollbackTreeHash, runtimeHash: input.targetRuntimeHash };
      }
      expect(run(dataDir, input, fake).status).toBe(status);
      expect(fake.calls).toEqual([]);
    },
  );

  it('keeps transaction active unknown when receipt and real filesystem state conflict', () => {
    const dataDir = tempDataDir();
    const input = request();
    createReleaseTransaction(dataDir, input);
    appendReleaseJournalEvent(dataDir, input.transactionId, {
      at: '2026-10-12T10:00:00.000Z', type: 'terminal', phase: 'verify',
      details: { status: 'verified' },
    });
    const fake = fakeAdapters(input);
    fake.state.layout = 'unknown';
    expect(run(dataDir, input, fake).status).toBe('unknown');
    expect(fake.calls).toEqual([]);
  });

  it('rejects a verified terminal receipt when fresh required checks no longer pass', () => {
    const dataDir = tempDataDir();
    const input = request('tx-terminal-check-drift');
    createReleaseTransaction(dataDir, input);
    appendReleaseJournalEvent(dataDir, input.transactionId, {
      at: '2026-10-12T10:00:00.000Z', type: 'terminal', phase: 'verify',
      details: { status: 'verified' },
    });
    const fake = fakeAdapters(input);
    fake.state = {
      ...fake.state,
      layout: 'new-dist-new-runtime',
      artifactTreeHash: input.artifactTreeHash,
      stagedArtifactTreeHash: null,
      rollbackTreeHash: input.rollbackTreeHash,
      runtimeHash: input.targetRuntimeHash,
      liveBehaviorHealthy: false,
    };

    expect(run(dataDir, input, fake)).toMatchObject({
      status: 'unknown',
      events: expect.arrayContaining([
        expect.objectContaining({ type: 'terminal', details: expect.objectContaining({
          status: 'unknown', reason: 'terminal_receipt_state_conflict',
        }) }),
      ]),
    });
    expect(fake.calls).toEqual([]);
  });

  it('persists UNKNOWN without repeating an intent-only action whose outcome cannot be proven', () => {
    const dataDir = tempDataDir();
    const input = request('tx-intent-only-unknown');
    createReleaseTransaction(dataDir, input);
    appendReleaseJournalEvent(dataDir, input.transactionId, {
      at: '2026-10-12T10:00:00.000Z', type: 'intent', phase: 'commit',
      action: 'rename_current_to_rollback',
    });
    const fake = fakeAdapters(input);
    fake.state = {
      ...fake.state,
      layout: 'unknown',
      artifactTreeHash: null,
      stagedArtifactTreeHash: null,
      rollbackTreeHash: input.rollbackTreeHash,
      runtimeHash: input.oldRuntimeHash,
    };

    expect(run(dataDir, input, fake)).toMatchObject({
      status: 'unknown',
      events: expect.arrayContaining([
        expect.objectContaining({ type: 'terminal', details: expect.objectContaining({
          status: 'unknown', reason: 'intent_outcome_unproven',
        }) }),
      ]),
    });
    expect(fake.calls).toEqual([]);
  });

  it('resumes after a rename intent when the pinned layout proves that action completed', () => {
    const dataDir = tempDataDir();
    const input = request('tx-intent-only-proven');
    createReleaseTransaction(dataDir, input);
    appendReleaseJournalEvent(dataDir, input.transactionId, {
      at: '2026-10-12T10:00:00.000Z', type: 'intent', phase: 'commit',
      action: 'rename_staged_to_current',
    });
    const fake = fakeAdapters(input);
    fake.state = {
      ...fake.state,
      layout: 'new-dist-old-runtime',
      artifactTreeHash: input.artifactTreeHash,
      stagedArtifactTreeHash: null,
      rollbackTreeHash: input.rollbackTreeHash,
      runtimeHash: input.oldRuntimeHash,
    };

    expect(run(dataDir, input, fake)).toMatchObject({ status: 'verified' });
    expect(fake.calls).toEqual(['restart']);
    expect(run(dataDir, input, fake)).toMatchObject({ status: 'verified' });
    expect(fake.calls).toEqual(['restart']);
  });

  it.each([
    'serviceActive', 'fleetHealthy', 'cgroupHealthy', 'liveBehaviorHealthy', 'completionGateHealthy',
  ] as const)('requires %s before verified', check => {
    const dataDir = tempDataDir();
    const input = request(`tx-check-${check}`);
    const fake = fakeAdapters(input);
    const originalRestart = fake.restart;
    fake.restart = requestValue => {
      originalRestart(requestValue);
      fake.state[check] = false;
    };
    const expected = ['serviceActive', 'fleetHealthy', 'cgroupHealthy'].includes(check)
      ? 'rollback_failed'
      : 'rolled_back';
    expect(run(dataDir, input, fake).status).toBe(expected);
  });
});

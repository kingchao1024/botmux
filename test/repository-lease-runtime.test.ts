import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  abandonRepositoryWriter,
  acquireRepositoryWriter,
  readRepositoryControl,
  rebindRepositoryWriterDispatchRoot,
} from '../src/services/repository-control.js';
import { RepositoryLeaseRuntime } from '../src/services/repository-lease-runtime.js';

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('repository lease runtime', () => {
  it('binds from the durable owner after the real dispatch root is committed even before registry projection', () => {
    vi.useFakeTimers();
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-repository-runtime-'));
    chmodSync(dataDir, 0o700);
    roots.push(dataDir);
    const identity = { repoKey: 'd'.repeat(64), canonicalCommonDir: '/tmp/runtime-durable.git' };
    const owner = {
      chatId: 'chat', dispatchRoot: 'reservation-1', taskGuid: 'task', controllerAppId: 'controller',
      workerAppId: 'worker', sessionId: 'controller-session', workerGeneration: 7,
      workingDir: '/tmp/worktree', declaredScopes: ['/tmp/worktree'],
    };
    const acquired = acquireRepositoryWriter(dataDir, {
      identity, operationId: 'acquire', owner, now: '2026-10-12T00:00:00.000Z',
    });
    rebindRepositoryWriterDispatchRoot(dataDir, {
      identity, operationId: 'bind-root', leaseId: acquired.leaseRef.leaseId,
      fencingToken: acquired.leaseRef.fencingToken, reservationId: owner.dispatchRoot,
      dispatchRoot: 'om_real_root', now: '2026-10-12T00:00:01.000Z',
    });
    const runtime = new RepositoryLeaseRuntime(dataDir, { heartbeatIntervalMs: 60_000 });

    const handle = runtime.attachActive({
      identity, dispatchRoot: 'om_real_root', workerAppId: owner.workerAppId,
      workingDir: owner.workingDir, sessionId: 'worker-session', workerGeneration: 11,
    });

    expect(handle).toBeDefined();
    expect(readRepositoryControl(dataDir, identity).writerLease).toMatchObject({
      dispatchRoot: 'om_real_root', sessionId: 'worker-session', workerGeneration: 11,
    });
    handle?.stop();
  });

  it('keeps first IPC fenced and attaches after the seed reservation is rebound to the real root', async () => {
    vi.useFakeTimers();
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-repository-runtime-'));
    chmodSync(dataDir, 0o700);
    roots.push(dataDir);
    const identity = { repoKey: 'e'.repeat(64), canonicalCommonDir: '/tmp/runtime-pending.git' };
    const owner = {
      chatId: 'chat', dispatchRoot: 'reservation-1', taskGuid: 'task', controllerAppId: 'controller',
      workerAppId: 'worker', sessionId: 'controller-session', workerGeneration: 7,
      workingDir: '/tmp/worktree', declaredScopes: ['/tmp/worktree'],
    };
    acquireRepositoryWriter(dataDir, {
      identity, operationId: 'acquire', owner, now: '2026-10-12T00:00:00.000Z',
    });
    const runtime = new RepositoryLeaseRuntime(dataDir, { heartbeatIntervalMs: 60_000 });

    const handle = runtime.attachActive({
      identity, dispatchRoot: 'om_real_root', workerAppId: owner.workerAppId,
      workingDir: owner.workingDir, sessionId: 'worker-session', workerGeneration: 11,
    }) as ReturnType<RepositoryLeaseRuntime['attachActive']> & { ready: Promise<void> };
    expect(readRepositoryControl(dataDir, identity).writerLease?.generationBoundAt).toBeUndefined();
    rebindRepositoryWriterDispatchRoot(dataDir, {
      identity, operationId: 'bind-root', leaseId: readRepositoryControl(dataDir, identity).writerLease!.leaseId,
      fencingToken: readRepositoryControl(dataDir, identity).writerLease!.fencingToken,
      reservationId: owner.dispatchRoot, dispatchRoot: 'om_real_root', now: '2026-10-12T00:00:01.000Z',
    });
    await vi.advanceTimersByTimeAsync(50);
    await handle.ready;
    expect(readRepositoryControl(dataDir, identity).writerLease).toMatchObject({
      dispatchRoot: 'om_real_root', sessionId: 'worker-session', workerGeneration: 11,
    });
    handle.stop();
  });

  it('binds the dispatch lease to the exact target worker generation before heartbeats start', () => {
    vi.useFakeTimers();
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-repository-runtime-'));
    chmodSync(dataDir, 0o700);
    roots.push(dataDir);
    const identity = { repoKey: 'c'.repeat(64), canonicalCommonDir: '/tmp/runtime-bind.git' };
    const owner = {
      chatId: 'chat', dispatchRoot: 'om_dispatch_root', taskGuid: 'task', controllerAppId: 'controller',
      workerAppId: 'worker', sessionId: 'controller-session', workerGeneration: 7,
      workingDir: '/tmp/worktree', declaredScopes: ['/tmp/worktree'],
    };
    const acquired = acquireRepositoryWriter(dataDir, {
      identity, operationId: 'acquire', owner, now: '2026-10-12T00:00:00.000Z',
    });
    const runtime = new RepositoryLeaseRuntime(dataDir, { heartbeatIntervalMs: 60_000 });
    const binding = {
      identity,
      leaseRef: acquired.leaseRef,
      dispatchRoot: owner.dispatchRoot,
      workerAppId: owner.workerAppId,
      workingDir: owner.workingDir,
      sessionId: 'worker-session',
      workerGeneration: 11,
    };

    const handle = runtime.attach(binding);

    expect(readRepositoryControl(dataDir, identity).writerLease).toMatchObject({
      dispatchRoot: owner.dispatchRoot,
      workerAppId: owner.workerAppId,
      workingDir: owner.workingDir,
      sessionId: binding.sessionId,
      workerGeneration: binding.workerGeneration,
    });
    handle.stop();
  });

  it.each([
    ['dispatch root', { dispatchRoot: 'om_wrong_root' }],
    ['worker app', { workerAppId: 'wrong-worker' }],
    ['working directory', { workingDir: '/tmp/wrong-worktree' }],
  ])('rejects a %s mismatch while binding the worker generation', (_label, override) => {
    vi.useFakeTimers();
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-repository-runtime-'));
    chmodSync(dataDir, 0o700);
    roots.push(dataDir);
    const identity = { repoKey: 'b'.repeat(64), canonicalCommonDir: '/tmp/runtime-reject.git' };
    const owner = {
      chatId: 'chat', dispatchRoot: 'om_dispatch_root', taskGuid: 'task', controllerAppId: 'controller',
      workerAppId: 'worker', sessionId: 'controller-session', workerGeneration: 7,
      workingDir: '/tmp/worktree', declaredScopes: ['/tmp/worktree'],
    };
    const acquired = acquireRepositoryWriter(dataDir, {
      identity, operationId: 'acquire', owner, now: '2026-10-12T00:00:00.000Z',
    });
    const runtime = new RepositoryLeaseRuntime(dataDir, { heartbeatIntervalMs: 60_000 });

    expect(() => runtime.attach({
      identity,
      leaseRef: acquired.leaseRef,
      dispatchRoot: owner.dispatchRoot,
      workerAppId: owner.workerAppId,
      workingDir: owner.workingDir,
      sessionId: 'worker-session',
      workerGeneration: 11,
      ...override,
    })).toThrow('repository_lease_binding_mismatch');
    expect(readRepositoryControl(dataDir, identity).writerLease).toMatchObject({
      sessionId: owner.sessionId,
      workerGeneration: owner.workerGeneration,
    });
  });

  it('rejects a stale fencing token before binding the worker generation', () => {
    vi.useFakeTimers();
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-repository-runtime-'));
    chmodSync(dataDir, 0o700);
    roots.push(dataDir);
    const identity = { repoKey: 'a'.repeat(64), canonicalCommonDir: '/tmp/runtime-stale.git' };
    const owner = {
      chatId: 'chat', dispatchRoot: 'om_dispatch_root', taskGuid: 'task', controllerAppId: 'controller',
      workerAppId: 'worker', sessionId: 'controller-session', workerGeneration: 7,
      workingDir: '/tmp/worktree', declaredScopes: ['/tmp/worktree'],
    };
    const acquired = acquireRepositoryWriter(dataDir, {
      identity, operationId: 'acquire', owner, now: '2026-10-12T00:00:00.000Z',
    });
    const runtime = new RepositoryLeaseRuntime(dataDir, { heartbeatIntervalMs: 60_000 });

    expect(() => runtime.attach({
      identity,
      leaseRef: { ...acquired.leaseRef, fencingToken: acquired.leaseRef.fencingToken - 1 },
      dispatchRoot: owner.dispatchRoot,
      workerAppId: owner.workerAppId,
      workingDir: owner.workingDir,
      sessionId: 'worker-session',
      workerGeneration: 11,
    })).toThrow('repository_lease_stale_token');
    expect(readRepositoryControl(dataDir, identity).writerLease).toMatchObject({
      sessionId: owner.sessionId,
      workerGeneration: owner.workerGeneration,
    });
  });

  it('heartbeats the exact session generation and abandons only with termination evidence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T00:00:00.000Z'));
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-repository-runtime-'));
    chmodSync(dataDir, 0o700);
    roots.push(dataDir);
    const identity = { repoKey: 'd'.repeat(64), canonicalCommonDir: '/tmp/runtime.git' };
    const owner = {
      chatId: 'chat', dispatchRoot: 'root', taskGuid: 'task', controllerAppId: 'controller',
      workerAppId: 'worker', sessionId: 'session', workerGeneration: 3,
      workingDir: '/tmp/worktree', declaredScopes: ['/tmp/worktree'],
    };
    const acquired = acquireRepositoryWriter(dataDir, {
      identity, operationId: 'acquire', owner, now: new Date().toISOString(),
    });
    const runtime = new RepositoryLeaseRuntime(dataDir, { heartbeatIntervalMs: 1_000 });
    const handle = runtime.attach({
      identity,
      leaseRef: {
        repoKey: identity.repoKey, leaseId: acquired.lease.leaseId,
        fencingToken: acquired.lease.fencingToken, workingDir: owner.workingDir,
      },
      dispatchRoot: owner.dispatchRoot,
      workerAppId: owner.workerAppId,
      workingDir: owner.workingDir,
      sessionId: owner.sessionId,
      workerGeneration: owner.workerGeneration,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(readRepositoryControl(dataDir, identity).writerLease?.heartbeatAt)
      .toBe('2026-10-12T00:00:01.000Z');
    handle.generationTerminated({ kind: 'process_exit', observedAt: '2026-10-12T00:00:02.000Z' });
    expect(readRepositoryControl(dataDir, identity).writerLease).toBeNull();
    handle.stop();
  });

  it('does not force release when the bound generation is still live', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-repository-runtime-'));
    chmodSync(dataDir, 0o700);
    roots.push(dataDir);
    const identity = { repoKey: 'e'.repeat(64), canonicalCommonDir: '/tmp/runtime-live.git' };
    const owner = {
      chatId: 'chat', dispatchRoot: 'root', taskGuid: 'task', controllerAppId: 'controller',
      workerAppId: 'worker', sessionId: 'session', workerGeneration: 4,
      workingDir: '/tmp/worktree', declaredScopes: ['/tmp/worktree'],
    };
    const acquired = acquireRepositoryWriter(dataDir, {
      identity, operationId: 'acquire', owner, now: '2026-10-12T00:00:00.000Z',
    });
    const runtime = new RepositoryLeaseRuntime(dataDir, { heartbeatIntervalMs: 60_000 });
    const handle = runtime.attach({ identity, leaseRef: {
      repoKey: identity.repoKey, leaseId: acquired.lease.leaseId,
      fencingToken: acquired.lease.fencingToken, workingDir: owner.workingDir,
    }, dispatchRoot: owner.dispatchRoot, workerAppId: owner.workerAppId,
    workingDir: owner.workingDir, sessionId: owner.sessionId,
    workerGeneration: owner.workerGeneration });
    handle.stop();
    expect(readRepositoryControl(dataDir, identity).writerLease?.leaseId).toBe(acquired.lease.leaseId);
  });

  it('makes a duplicate abnormal-exit callback harmless after a new lease is acquired', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-repository-runtime-'));
    chmodSync(dataDir, 0o700);
    roots.push(dataDir);
    const identity = { repoKey: '9'.repeat(64), canonicalCommonDir: '/tmp/runtime-duplicate-exit.git' };
    const owner = {
      chatId: 'chat', dispatchRoot: 'root', taskGuid: 'task', controllerAppId: 'controller',
      workerAppId: 'worker', sessionId: 'worker-session', workerGeneration: 4,
      workingDir: '/tmp/worktree', declaredScopes: ['/tmp/worktree'],
    };
    const acquired = acquireRepositoryWriter(dataDir, {
      identity, operationId: 'acquire-old', owner, now: '2026-10-12T00:00:00.000Z',
    });
    const runtime = new RepositoryLeaseRuntime(dataDir, { heartbeatIntervalMs: 60_000 });
    const handle = runtime.attach({
      identity, leaseRef: acquired.leaseRef, dispatchRoot: owner.dispatchRoot,
      workerAppId: owner.workerAppId, workingDir: owner.workingDir,
      sessionId: owner.sessionId, workerGeneration: owner.workerGeneration,
    });

    handle.generationTerminated({
      kind: 'process_exit', code: 1, signal: 'SIGKILL',
      observedAt: '2026-10-12T00:00:01.000Z',
    });
    const replacement = acquireRepositoryWriter(dataDir, {
      identity,
      operationId: 'acquire-new',
      owner: { ...owner, sessionId: 'replacement-session', workerGeneration: 5 },
      now: '2026-10-12T00:00:02.000Z',
    });

    expect(() => handle.generationTerminated({
      kind: 'duplicate_process_exit', observedAt: '2026-10-12T00:00:03.000Z',
    })).not.toThrow();
    expect(readRepositoryControl(dataDir, identity).writerLease?.leaseId)
      .toBe(replacement.lease.leaseId);
  });

  it('does not let a late old-generation termination release a replacement lease', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-repository-runtime-'));
    chmodSync(dataDir, 0o700);
    roots.push(dataDir);
    const identity = { repoKey: '8'.repeat(64), canonicalCommonDir: '/tmp/runtime-stale-exit.git' };
    const owner = {
      chatId: 'chat', dispatchRoot: 'root', taskGuid: 'task', controllerAppId: 'controller',
      workerAppId: 'worker', sessionId: 'worker-session', workerGeneration: 4,
      workingDir: '/tmp/worktree', declaredScopes: ['/tmp/worktree'],
    };
    const acquired = acquireRepositoryWriter(dataDir, {
      identity, operationId: 'acquire-old', owner, now: '2026-10-12T00:00:00.000Z',
    });
    const runtime = new RepositoryLeaseRuntime(dataDir, { heartbeatIntervalMs: 60_000 });
    const handle = runtime.attach({
      identity, leaseRef: acquired.leaseRef, dispatchRoot: owner.dispatchRoot,
      workerAppId: owner.workerAppId, workingDir: owner.workingDir,
      sessionId: owner.sessionId, workerGeneration: owner.workerGeneration,
    });
    abandonRepositoryWriter(dataDir, {
      identity,
      operationId: 'external-generation-proof',
      leaseId: acquired.leaseRef.leaseId,
      fencingToken: acquired.leaseRef.fencingToken,
      sessionId: owner.sessionId,
      workerGeneration: owner.workerGeneration,
      terminationEvidence: { kind: 'external_process_exit' },
      now: '2026-10-12T00:00:01.000Z',
    });
    const replacement = acquireRepositoryWriter(dataDir, {
      identity,
      operationId: 'acquire-new',
      owner: { ...owner, sessionId: 'replacement-session', workerGeneration: 5 },
      now: '2026-10-12T00:00:02.000Z',
    });

    expect(() => handle.generationTerminated({
      kind: 'late_process_exit', observedAt: '2026-10-12T00:00:03.000Z',
    })).toThrow('repository_lease_stale_token');
    expect(readRepositoryControl(dataDir, identity).writerLease?.leaseId)
      .toBe(replacement.lease.leaseId);
  });
});

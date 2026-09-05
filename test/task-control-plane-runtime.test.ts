import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { taskControlPlaneDatabasePath, taskControlPlaneFlags } from '../src/services/task-control-plane-runtime.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

function collectChild(child: ReturnType<typeof spawnTsEvalWithRepoImports>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    let stdout = ''; let stderr = '';
    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

describe('task control plane runtime', () => {
  it('defaults every flag to false and leaves dataDir untouched when disabled', async () => {
    expect(taskControlPlaneFlags({})).toEqual({
      ledgerEnabled: false, shadowEnabled: false, pumpEnabled: false, freezeEnforcement: false,
    });
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-off-'));
    const lifecycle = await (await import('../src/services/task-control-plane-runtime.js')).startTaskControlPlaneRuntime({
      dataDir,
      authority: new (await import('../src/services/task-control-plane-authority.js')).DaemonTaskControlAuthority({
        resolvePrincipal: () => undefined, approvalKeys: new Map(),
      }),
      logger: { warn: () => {} },
    });
    expect(lifecycle.enabled).toBe(false);
    expect(existsSync(taskControlPlaneDatabasePath(dataDir))).toBe(false);
    await lifecycle.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('opens, recovers and closes the enabled SQLite lifecycle in an isolated runtime', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-runtime-child-'));
    const runtimeUrl = new URL('../src/services/task-control-plane-runtime.ts', import.meta.url).href;
    const authorityUrl = new URL('../src/services/task-control-plane-authority.ts', import.meta.url).href;
    const child = spawnTsEvalWithRepoImports(`
      import { startTaskControlPlaneRuntime } from ${JSON.stringify(runtimeUrl)};
      import { DaemonTaskControlAuthority } from ${JSON.stringify(authorityUrl)};
      const lifecycle = await startTaskControlPlaneRuntime({
        dataDir: process.env.TASK_CONTROL_TEST_DIR,
        flags: { ledgerEnabled: true },
        authority: new DaemonTaskControlAuthority({ resolvePrincipal: () => undefined, approvalKeys: new Map() }),
        logger: { warn: () => {} },
      });
      await lifecycle.close(25);
      console.log(lifecycle.enabled ? 'enabled-and-closed' : 'disabled');
    `, { env: { ...process.env, TASK_CONTROL_TEST_DIR: dataDir } });
    const result = await collectChild(child);
    rmSync(dataDir, { recursive: true, force: true });
    expect(result).toMatchObject({ code: 0, stdout: expect.stringContaining('enabled-and-closed') });
  });

  it('pumps a durable outbox row to a settled receipt in an isolated runtime', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-pump-child-'));
    const runtimeUrl = new URL('../src/services/task-control-plane-runtime.ts', import.meta.url).href;
    const authorityUrl = new URL('../src/services/task-control-plane-authority.ts', import.meta.url).href;
    const child = spawnTsEvalWithRepoImports(`
      import { startTaskControlPlaneRuntime } from ${JSON.stringify(runtimeUrl)};
      import { DaemonTaskControlAuthority } from ${JSON.stringify(authorityUrl)};
      const principals = new Map([
        ['controller', { actorId: 'controller-1', actorRole: 'controller' }],
        ['worker', { actorId: 'worker-1', actorRole: 'worker' }],
      ]);
      const authority = new DaemonTaskControlAuthority({
        resolvePrincipal: id => principals.get(id), approvalKeys: new Map(),
      });
      let delivered = 0;
      const lifecycle = await startTaskControlPlaneRuntime({
        dataDir: process.env.TASK_CONTROL_TEST_DIR,
        flags: { ledgerEnabled: true, pumpEnabled: true }, intervalMs: 5,
        authority, logger: { warn: error => { throw new Error(error); } },
        deliver: async () => { delivered++; return { kind: 'delivered' }; },
      });
      const controller = authority.issueAuthentication('controller');
      const worker = authority.issueAuthentication('worker');
      lifecycle.append({
        eventId: 'phase-open', eventType: 'phase.opened', projectId: 'project-1', phaseId: 'phase-1',
        authentication: controller, idempotencyKey: 'phase-open',
        payload: { taskGuids: ['task-1'], designatedAcceptorId: 'acceptor-1' },
      });
      lifecycle.append({
        eventId: 'task-map', eventType: 'mapping.registered', projectId: 'project-1', phaseId: 'phase-1',
        taskGuid: 'task-1', topicRootId: 'om_root', authentication: controller, idempotencyKey: 'task-map',
        payload: { ownerId: 'worker-1' },
      });
      lifecycle.append({
        eventId: 'task-delivery', eventType: 'task.delivered', projectId: 'project-1', phaseId: 'phase-1',
        taskGuid: 'task-1', topicRootId: 'om_root', authentication: worker, idempotencyKey: 'task-delivery',
        terminal: true, deliverTo: ['orchestrator'], payload: { docToken: 'doc-final', docRevision: 1 },
      });
      await new Promise(resolve => setTimeout(resolve, 40));
      await lifecycle.close(25);
      if (delivered !== 1) throw new Error('outbox_not_settled');
      console.log('outbox-settled');
    `, { env: { ...process.env, TASK_CONTROL_TEST_DIR: dataDir } });
    const result = await collectChild(child);
    rmSync(dataDir, { recursive: true, force: true });
    expect(result).toMatchObject({ code: 0, stdout: expect.stringContaining('outbox-settled') });
  });

  it('does not close SQLite while a timed-out delivery is still settling', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-close-child-'));
    const runtimeUrl = new URL('../src/services/task-control-plane-runtime.ts', import.meta.url).href;
    const authorityUrl = new URL('../src/services/task-control-plane-authority.ts', import.meta.url).href;
    const storeUrl = new URL('../src/services/task-control-plane-store.ts', import.meta.url).href;
    const child = spawnTsEvalWithRepoImports(`
      import { startTaskControlPlaneRuntime } from ${JSON.stringify(runtimeUrl)};
      import { DaemonTaskControlAuthority } from ${JSON.stringify(authorityUrl)};
      import { TaskControlPlaneStore } from ${JSON.stringify(storeUrl)};
      const principals = new Map([
        ['controller', { actorId: 'controller-1', actorRole: 'controller' }],
        ['worker', { actorId: 'worker-1', actorRole: 'worker' }],
      ]);
      const authority = new DaemonTaskControlAuthority({ resolvePrincipal: id => principals.get(id), approvalKeys: new Map() });
      let release; const delivery = new Promise(resolve => { release = resolve; });
      const lifecycle = await startTaskControlPlaneRuntime({
        dataDir: process.env.TASK_CONTROL_TEST_DIR, flags: { ledgerEnabled: true, pumpEnabled: true }, intervalMs: 5,
        authority, logger: { warn: error => { throw new Error(error); } },
        deliver: async () => { await delivery; return { kind: 'delivered' }; },
      });
      const controller = authority.issueAuthentication('controller');
      const worker = authority.issueAuthentication('worker');
      lifecycle.append({ eventId: 'phase-open', eventType: 'phase.opened', projectId: 'project-1', phaseId: 'phase-1', authentication: controller, idempotencyKey: 'phase-open', payload: { taskGuids: ['task-1'], designatedAcceptorId: 'acceptor-1' } });
      lifecycle.append({ eventId: 'task-map', eventType: 'mapping.registered', projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', authentication: controller, idempotencyKey: 'task-map', payload: { ownerId: 'worker-1' } });
      lifecycle.append({ eventId: 'task-delivery', eventType: 'task.delivered', projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', authentication: worker, idempotencyKey: 'task-delivery', terminal: true, deliverTo: ['orchestrator'], payload: { docToken: 'doc-final', docRevision: 1 } });
      await new Promise(resolve => setTimeout(resolve, 20));
      await lifecycle.close(1);
      release();
      await new Promise(resolve => setTimeout(resolve, 20));
      const readonly = await TaskControlPlaneStore.openReadOnly(process.env.TASK_CONTROL_TEST_DIR);
      const row = readonly.listOutbox()[0];
      readonly.close();
      if (row.status !== 'delivered') throw new Error('delivery_did_not_settle_after_close_timeout');
      console.log('close-safe');
    `, { env: { ...process.env, TASK_CONTROL_TEST_DIR: dataDir } });
    const result = await collectChild(child);
    rmSync(dataDir, { recursive: true, force: true });
    expect(result).toMatchObject({ code: 0, stdout: expect.stringContaining('close-safe') });
  });

  it('fails soft when an asynchronously queued observation meets a SQLite lock', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-observation-lock-'));
    const runtimeUrl = new URL('../src/services/task-control-plane-runtime.ts', import.meta.url).href;
    const authorityUrl = new URL('../src/services/task-control-plane-authority.ts', import.meta.url).href;
    const storeUrl = new URL('../src/services/task-control-plane-store.ts', import.meta.url).href;
    const lockChild = spawnTsEvalWithRepoImports(`
      import { TaskControlPlaneStore } from ${JSON.stringify(storeUrl)};
      const authority = { authenticate: () => undefined, verifyApproval: () => undefined };
      const store = await TaskControlPlaneStore.open(process.env.TASK_CONTROL_TEST_DIR, authority);
      store['db'].exec('BEGIN IMMEDIATE');
      process.stdout.write('locked');
      setTimeout(() => { store['db'].exec('ROLLBACK'); store.close(); }, 250);
    `, { env: { ...process.env, TASK_CONTROL_TEST_DIR: dataDir } });
    await new Promise<void>((resolve, reject) => {
      lockChild.stdout?.once('data', () => resolve());
      lockChild.once('error', reject);
    });
    const runtime = await import('../src/services/task-control-plane-runtime.js');
    const authority = new (await import('../src/services/task-control-plane-authority.js')).DaemonTaskControlAuthority({
      resolvePrincipal: () => undefined, approvalKeys: new Map(),
    });
    const warnings: string[] = [];
    const lifecycle = await runtime.startTaskControlPlaneRuntime({
      dataDir, flags: { ledgerEnabled: true }, authority, logger: { warn: warning => warnings.push(warning) },
    });
    const queuedAt = Date.now();
    lifecycle.enqueueUnknownObservation({
      eventId: 'locked-observation', attemptedEventType: 'task.dispatch_requested',
      sourceRef: 'dispatch:locked', idempotencyKey: 'dispatch:locked',
    });
    expect(Date.now() - queuedAt).toBeLessThan(20);
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(warnings).toEqual(expect.arrayContaining([expect.stringContaining('observation write busy')]));
    await lifecycle.close(25);
    const result = await collectChild(lockChild);
    rmSync(dataDir, { recursive: true, force: true });
    expect(result).toMatchObject({ code: 0 });
  });

  it('drops sidecar writes when the bounded queue is full or closed without touching SQLite', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-sidecar-drop-'));
    try {
      const runtime = await import('../src/services/task-control-plane-runtime.js');
      const authority = new (await import('../src/services/task-control-plane-authority.js')).DaemonTaskControlAuthority({
        resolvePrincipal: () => undefined, approvalKeys: new Map(),
      });
      const warnings: string[] = [];
      const lifecycle = await runtime.startTaskControlPlaneRuntime({
        dataDir, flags: { ledgerEnabled: true }, authority, logger: { warn: warning => warnings.push(warning) },
      });
      for (let index = 0; index < 130; index++) {
        lifecycle.enqueueUnknownObservation({
          eventId: `queue-${index}`, attemptedEventType: 'task.dispatch_requested',
          sourceRef: `dispatch:queue-${index}`, idempotencyKey: `dispatch:queue-${index}`,
        });
      }
      expect(warnings).toEqual(expect.arrayContaining([expect.stringContaining('sidecar queue full')]));
      await lifecycle.close();
      lifecycle.enqueueUnknownObservation({
        eventId: 'after-close', attemptedEventType: 'task.dispatch_requested', sourceRef: 'dispatch:after-close', idempotencyKey: 'dispatch:after-close',
      });
      expect(warnings).toEqual(expect.arrayContaining([expect.stringContaining('dropped after shutdown')]));
      const readonly = await (await import('../src/services/task-control-plane-store.js')).TaskControlPlaneStore.openReadOnly(dataDir);
      expect(readonly.listObservations().some(item => item.eventId === 'after-close')).toBe(false);
      readonly.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('gates shadow collection and freeze enforcement while keeping every flag default-off', async () => {
    const runtime = await import('../src/services/task-control-plane-runtime.js');
    const authority = new (await import('../src/services/task-control-plane-authority.js')).DaemonTaskControlAuthority({
      resolvePrincipal: () => undefined, approvalKeys: new Map(),
    });
    await expect(runtime.startTaskControlPlaneRuntime({
      dataDir: mkdtempSync(join(tmpdir(), 'botmux-task-control-flags-')),
      flags: { shadowEnabled: true }, authority, logger: { warn: () => {} },
    })).rejects.toMatchObject({ code: 'shadow_requires_ledger' });
    await expect(runtime.startTaskControlPlaneRuntime({
      dataDir: mkdtempSync(join(tmpdir(), 'botmux-task-control-flags-')),
      flags: { ledgerEnabled: true, shadowEnabled: true }, authority, logger: { warn: () => {} },
    })).rejects.toMatchObject({ code: 'shadow_collector_required' });
    const withoutFreeze = await runtime.startTaskControlPlaneRuntime({
      dataDir: mkdtempSync(join(tmpdir(), 'botmux-task-control-flags-')),
      flags: { ledgerEnabled: true }, authority, logger: { warn: () => {} },
    });
    expect(() => withoutFreeze.freeze({} as any)).toThrow(expect.objectContaining({ code: 'freeze_enforcement_disabled' }));
    await withoutFreeze.close();
    await expect(runtime.startTaskControlPlaneRuntime({
      dataDir: mkdtempSync(join(tmpdir(), 'botmux-task-control-flags-')),
      flags: { ledgerEnabled: true, pumpEnabled: true }, authority, logger: { warn: () => {} },
    })).rejects.toMatchObject({ code: 'pump_delivery_required' });
  });

  it('pins all control-plane state to the declared SQLite filename', () => {
    expect(taskControlPlaneDatabasePath('/tmp/state')).toBe('/tmp/state/botmux-task-control-plane.sqlite');
    expect(taskControlPlaneDatabasePath('/tmp/state/')).toBe('/tmp/state/botmux-task-control-plane.sqlite');
  });
});

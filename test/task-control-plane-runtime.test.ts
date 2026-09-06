import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scopedTaskControlPlaneConfig, taskControlPlaneDatabasePath, taskControlPlaneFlags } from '../src/services/task-control-plane-runtime.js';
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
        resolvePrincipal: () => undefined,
      }),
      logger: { warn: () => {} },
    });
    expect(lifecycle.enabled).toBe(false);
    expect(existsSync(taskControlPlaneDatabasePath(dataDir))).toBe(false);
    await lifecycle.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('enables only one exact read-only app+task Shadow scope and otherwise fails closed', () => {
    const appId = 'cli_aac926f0eb795bc1';
    const taskGuid = '2cd616e9-910b-47e1-a081-349b4808ee5a';
    const enabled = {
      TASK_CONTROL_PLANE_LEDGER_ENABLED: 'true',
      TASK_CONTROL_PLANE_SHADOW_ENABLED: 'true',
      TASK_CONTROL_PLANE_PUMP_ENABLED: 'false',
      TASK_CONTROL_PLANE_FREEZE_ENFORCEMENT: 'false',
      TASK_CONTROL_PLANE_TARGET_LARK_APP_ID: appId,
      TASK_CONTROL_PLANE_TARGET_TASK_GUID: taskGuid,
    };
    expect(scopedTaskControlPlaneConfig(appId, enabled)).toEqual({
      flags: { ledgerEnabled: true, shadowEnabled: true, pumpEnabled: false, freezeEnforcement: false },
      shadowTaskGuid: taskGuid,
    });
    const off = { ledgerEnabled: false, shadowEnabled: false, pumpEnabled: false, freezeEnforcement: false };
    expect(scopedTaskControlPlaneConfig('cli_bbbbbbbbbbbbbbbb', enabled)).toEqual({ flags: off, disabledReason: 'target_app_mismatch' });
    expect(scopedTaskControlPlaneConfig(appId, { ...enabled, TASK_CONTROL_PLANE_TARGET_TASK_GUID: '' }))
      .toEqual({ flags: off, disabledReason: 'target_scope_required' });
    expect(scopedTaskControlPlaneConfig(appId, { ...enabled, TASK_CONTROL_PLANE_TARGET_TASK_GUID: `${taskGuid},other` }))
      .toEqual({ flags: off, disabledReason: 'target_scope_invalid' });
    expect(scopedTaskControlPlaneConfig(appId, { ...enabled, TASK_CONTROL_PLANE_PUMP_ENABLED: 'true' }))
      .toEqual({ flags: off, disabledReason: 'scoped_shadow_read_only_required' });
    expect(scopedTaskControlPlaneConfig(appId, { ...enabled, TASK_CONTROL_PLANE_FREEZE_ENFORCEMENT: 'true' }))
      .toEqual({ flags: off, disabledReason: 'scoped_shadow_read_only_required' });
    expect(scopedTaskControlPlaneConfig(appId, { ...enabled, TASK_CONTROL_PLANE_PUMP_ENABLED: 'tru' }))
      .toEqual({ flags: off, disabledReason: 'flag_value_invalid' });
    expect(scopedTaskControlPlaneConfig(appId, { TASK_CONTROL_PLANE_LEDGER_ENABLED: '1' }))
      .toEqual({ flags: off, disabledReason: 'flag_value_invalid' });
    expect(scopedTaskControlPlaneConfig(appId, {
      TASK_CONTROL_PLANE_TARGET_LARK_APP_ID: appId, TASK_CONTROL_PLANE_TARGET_TASK_GUID: taskGuid,
    })).toEqual({ flags: off });
  });

  it('does not create SQLite for a non-target app even when the scoped Shadow flags are enabled', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-scope-off-'));
    const config = scopedTaskControlPlaneConfig('cli_bbbbbbbbbbbbbbbb', {
      TASK_CONTROL_PLANE_LEDGER_ENABLED: 'true',
      TASK_CONTROL_PLANE_SHADOW_ENABLED: 'true',
      TASK_CONTROL_PLANE_PUMP_ENABLED: 'false',
      TASK_CONTROL_PLANE_FREEZE_ENFORCEMENT: 'false',
      TASK_CONTROL_PLANE_TARGET_LARK_APP_ID: 'cli_aac926f0eb795bc1',
      TASK_CONTROL_PLANE_TARGET_TASK_GUID: '2cd616e9-910b-47e1-a081-349b4808ee5a',
    });
    try {
      const lifecycle = await (await import('../src/services/task-control-plane-runtime.js')).startTaskControlPlaneRuntime({
        dataDir, flags: config.flags,
        authority: new (await import('../src/services/task-control-plane-authority.js')).DaemonTaskControlAuthority({
          resolvePrincipal: () => undefined,
        }),
        logger: { warn: () => {} },
      });
      expect(lifecycle.enabled).toBe(false);
      expect(existsSync(taskControlPlaneDatabasePath(dataDir))).toBe(false);
      await lifecycle.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
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
        authority: new DaemonTaskControlAuthority({ resolvePrincipal: () => undefined }),
        logger: { warn: () => {} },
      });
      const waitFor = async (predicate, label) => {
        const deadline = Date.now() + 500;
        while (!(await predicate())) {
          if (Date.now() >= deadline) throw new Error('timing_barrier_timeout:' + label);
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      };
      await lifecycle.close(25);
      console.log(lifecycle.enabled ? 'enabled-and-closed' : 'disabled');
    `, { env: { ...process.env, TASK_CONTROL_TEST_DIR: dataDir } });
    const result = await collectChild(child);
    rmSync(dataDir, { recursive: true, force: true });
    expect(result).toMatchObject({ code: 0, stdout: expect.stringContaining('enabled-and-closed') });
  });

  it('does not pump a restored outbox before explicit adapter readiness activation', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-deferred-start-'));
    try {
      const runtime = await import('../src/services/task-control-plane-runtime.js');
      const authority = new (await import('../src/services/task-control-plane-authority.js')).DaemonTaskControlAuthority({
        resolvePrincipal: id => ({
          controller: { actorId: 'controller-1', actorRole: 'controller' as const },
          worker: { actorId: 'worker-1', actorRole: 'worker' as const },
        } as const)[id],
      });
      const initial = await runtime.startTaskControlPlaneRuntime({ dataDir, flags: { ledgerEnabled: true }, authority, logger: { warn: () => {} } });
      initial.append({ eventId: 'phase', eventType: 'phase.opened', projectId: 'p', phaseId: 'h', authentication: authority.issueAuthentication('controller'), idempotencyKey: 'phase', payload: { taskGuids: ['t'], designatedAcceptorId: 'acceptor' } });
      initial.append({ eventId: 'mapping', eventType: 'mapping.registered', projectId: 'p', phaseId: 'h', taskGuid: 't', topicRootId: 'om_root', authentication: authority.issueAuthentication('controller'), idempotencyKey: 'mapping', payload: { ownerId: 'worker-1' } });
      initial.append({ eventId: 'terminal', eventType: 'task.delivered', projectId: 'p', phaseId: 'h', taskGuid: 't', topicRootId: 'om_root', authentication: authority.issueAuthentication('worker'), idempotencyKey: 'terminal', terminal: true, deliverTo: ['topic-message:om_delivery'], payload: { docToken: 'doc', docRevision: 1 } });
      await initial.close();
      let deliveries = 0;
      const restored = await runtime.startTaskControlPlaneRuntime({
        dataDir, flags: { ledgerEnabled: true, pumpEnabled: true }, authority, deferStart: true, intervalMs: 5,
        logger: { warn: () => {} }, deliver: async () => { deliveries++; return { kind: 'delivered', receiptRef: 'topic-message:om_receipt' }; },
      });
      await new Promise(resolve => setImmediate(resolve));
      expect(deliveries).toBe(0);
      restored.activate();
      await vi.waitFor(() => expect(deliveries).toBe(1), { interval: 5, timeout: 500 });
      await restored.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
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
        resolvePrincipal: id => principals.get(id),
      });
      let delivered = 0;
      const lifecycle = await startTaskControlPlaneRuntime({
        dataDir: process.env.TASK_CONTROL_TEST_DIR,
        flags: { ledgerEnabled: true, pumpEnabled: true }, intervalMs: 5,
        authority, logger: { warn: error => { throw new Error(error); } },
        deliver: async () => { delivered++; return { kind: 'delivered', receiptRef: 'topic-message:om_pump_receipt' }; },
      });
      const waitFor = async (predicate, label) => {
        const deadline = Date.now() + 500;
        while (!(await predicate())) {
          if (Date.now() >= deadline) throw new Error('timing_barrier_timeout:' + label);
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      };
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
      await waitFor(() => delivered === 1, 'outbox_delivery');
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
      const authority = new DaemonTaskControlAuthority({ resolvePrincipal: id => principals.get(id) });
      let release; const delivery = new Promise(resolve => { release = resolve; });
      const lifecycle = await startTaskControlPlaneRuntime({
        dataDir: process.env.TASK_CONTROL_TEST_DIR, flags: { ledgerEnabled: true, pumpEnabled: true }, intervalMs: 5,
        authority, logger: { warn: error => { throw new Error(error); } },
        deliver: async () => { await delivery; return { kind: 'delivered', receiptRef: 'topic-message:om_close_receipt' }; },
      });
      const waitFor = async (predicate, label) => {
        const deadline = Date.now() + 500;
        while (!predicate()) {
          if (Date.now() >= deadline) throw new Error('timing_barrier_timeout:' + label);
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      };
      const controller = authority.issueAuthentication('controller');
      const worker = authority.issueAuthentication('worker');
      lifecycle.append({ eventId: 'phase-open', eventType: 'phase.opened', projectId: 'project-1', phaseId: 'phase-1', authentication: controller, idempotencyKey: 'phase-open', payload: { taskGuids: ['task-1'], designatedAcceptorId: 'acceptor-1' } });
      lifecycle.append({ eventId: 'task-map', eventType: 'mapping.registered', projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', authentication: controller, idempotencyKey: 'task-map', payload: { ownerId: 'worker-1' } });
      lifecycle.append({ eventId: 'task-delivery', eventType: 'task.delivered', projectId: 'project-1', phaseId: 'phase-1', taskGuid: 'task-1', topicRootId: 'om_root', authentication: worker, idempotencyKey: 'task-delivery', terminal: true, deliverTo: ['orchestrator'], payload: { docToken: 'doc-final', docRevision: 1 } });
      await waitFor(() => lifecycle.getStore().listOutbox()[0]?.status === 'inflight', 'outbox_inflight');
      await lifecycle.close(1);
      release();
      await waitFor(async () => {
        const readonly = await TaskControlPlaneStore.openReadOnly(process.env.TASK_CONTROL_TEST_DIR);
        try { return readonly.listOutbox()[0]?.status === 'delivered'; }
        finally { readonly.close(); }
      }, 'delivery_settled');
      const readonly = await TaskControlPlaneStore.openReadOnly(process.env.TASK_CONTROL_TEST_DIR);
      const row = readonly.listOutbox()[0];
      readonly.close();
      if (row.status !== 'delivered') throw new Error('delivery_did_not_settle_after_close_timeout');
      console.log('close-safe');
    `, { env: { ...process.env, TASK_CONTROL_TEST_DIR: dataDir } });
    const result = await collectChild(child);
    rmSync(dataDir, { recursive: true, force: true });
    expect(result, result.stderr).toMatchObject({ code: 0, stdout: expect.stringContaining('close-safe') });
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
      resolvePrincipal: () => undefined,
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
    await vi.waitFor(() => expect(warnings).toEqual(expect.arrayContaining([expect.stringContaining('observation write busy')])), { interval: 5, timeout: 500 });
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
        resolvePrincipal: () => undefined,
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
      resolvePrincipal: () => undefined,
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
    await expect(runtime.startTaskControlPlaneRuntime({
      dataDir: mkdtempSync(join(tmpdir(), 'botmux-task-control-flags-')),
      flags: { ledgerEnabled: true, shadowEnabled: true, pumpEnabled: true }, authority, logger: { warn: () => {} },
      deliver: async () => ({ kind: 'retry' }), collect: async () => {},
    })).rejects.toMatchObject({ code: 'shadow_pump_mutually_exclusive' });
    await expect(runtime.startTaskControlPlaneRuntime({
      dataDir: mkdtempSync(join(tmpdir(), 'botmux-task-control-flags-')),
      flags: { ledgerEnabled: true, shadowEnabled: true, freezeEnforcement: true }, authority, logger: { warn: () => {} }, collect: async () => {},
    })).rejects.toMatchObject({ code: 'shadow_freeze_mutually_exclusive' });
  });

  it('pins all control-plane state to the declared SQLite filename', () => {
    expect(taskControlPlaneDatabasePath('/tmp/state')).toBe('/tmp/state/botmux-task-control-plane.sqlite');
    expect(taskControlPlaneDatabasePath('/tmp/state/')).toBe('/tmp/state/botmux-task-control-plane.sqlite');
  });
});

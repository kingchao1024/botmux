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

  it('pins all control-plane state to the declared SQLite filename', () => {
    expect(taskControlPlaneDatabasePath('/tmp/state')).toBe('/tmp/state/botmux-task-control-plane.sqlite');
    expect(taskControlPlaneDatabasePath('/tmp/state/')).toBe('/tmp/state/botmux-task-control-plane.sqlite');
  });
});

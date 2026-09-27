import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changePluginService } from '../src/core/plugins/supervisor-client.js';
import {
  pluginSupervisorDir, pluginSupervisorResultPath,
  pluginSupervisorStatePath, readPluginSupervisorDesired,
} from '../src/core/plugins/supervisor-store.js';
import { spawn } from 'node:child_process';
import { readDurableProcessIdentity } from '../src/utils/process-identity.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const pidAlive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
async function untilStopped(pid: number): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (pidAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`process ${pid} did not stop`);
    await delay(25);
  }
}

describe('plugin supervisor upgrade', () => {
  let home: string;
  const children = new Set<ReturnType<typeof spawn>>();
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plugin-supervisor-upgrade-'));
    vi.stubEnv('HOME', home);
  });
  afterEach(async () => {
    for (const child of children) {
      if (child.pid) {
        try { process.kill(child.pid, 'SIGKILL'); } catch { /* already exited */ }
      }
    }
    children.clear();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  const spec = {
    name: 'botmux-plugin-test',
    entry: 'daemon' as const,
    external: { command: 'node', args: ['-e', 'setInterval(()=>{}, 1000)'] },
  };

  it('safely stops an old generation supervisor and restarts it', async () => {
    const restoredPath = join(home, 'restored.pid');
    const restoredSpec = {
      ...spec,
      external: {
        command: 'node',
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(restoredPath)}, String(process.pid)); setInterval(()=>{}, 1000)`],
      },
    };
    const orphan = spawn('node', restoredSpec.external.args, { stdio: 'ignore' });
    children.add(orphan);
    expect(orphan.pid).toBeDefined();
    let orphanIdentity: string | undefined;
    while (!(orphanIdentity = readDurableProcessIdentity(orphan.pid!))) await delay(10);
    mkdirSync(pluginSupervisorDir(), { recursive: true });
    writeFileSync(pluginSupervisorStatePath(), JSON.stringify({
      supervisorPid: 0, supervisorStartedAt: '',
      procs: [{
        name: spec.name, appId: '', pid: orphan.pid, generation: 1,
        status: 'online', restarts: 0, lastExitCode: null,
        startedAt: new Date().toISOString(), processStart: orphanIdentity,
      }],
    }));

    // Launch a mock old supervisor that owns the real lifetime lock and writes
    // a legacy acknowledgement without runtimeGeneration.
    const mockScript = join(home, 'old-supervisor.ts');
    writeFileSync(mockScript, `
      import fs from 'node:fs';
      import { readDurableProcessIdentity } from '${join(__dirname, '../src/utils/process-identity.js').replace(/\\/g, '/')}';
      import { withFileLock } from '${join(__dirname, '../src/utils/file-lock.js').replace(/\\/g, '/')}';
      fs.mkdirSync('${pluginSupervisorDir().replace(/\\/g, '/')}', { recursive: true });
      void withFileLock('${join(pluginSupervisorDir(), 'owner').replace(/\\/g, '/')}', async () => {
        fs.writeFileSync('${pluginSupervisorResultPath().replace(/\\/g, '/')}', JSON.stringify({
          revision: 'old-rev',
          pid: process.pid,
          processStart: readDurableProcessIdentity(process.pid)
        }));
        await new Promise(resolve => process.once('SIGTERM', resolve));
      }, { maxWaitMs: 1000 });
    `);

    const child = spawn('node', ['--import', 'tsx', mockScript], { detached: true, stdio: 'ignore' });
    children.add(child);
    child.unref();

    // wait for result to be written
    let startWait = Date.now();
    while (!existsSync(pluginSupervisorResultPath())) {
      if (Date.now() - startWait > 5000) throw new Error('mock old supervisor failed to start');
      await delay(50);
    }

    const oldPid = child.pid;
    expect(oldPid).toBeDefined();

    // The client must stop the exact old generation before its successor can
    // acquire the lock and acknowledge the already-published desired state.
    await changePluginService('test', 'start', restoredSpec);

    // The old supervisor should be dead
    let oldDead = false;
    try {
      process.kill(oldPid!, 0);
    } catch (e) {
      oldDead = true;
    }
    expect(oldDead).toBe(true);
    expect(pidAlive(orphan.pid!)).toBe(false);
    const restoreDeadline = Date.now() + 5_000;
    while (!existsSync(restoredPath) || Number(readFileSync(restoredPath, 'utf8')) === orphan.pid) {
      if (Date.now() >= restoreDeadline) throw new Error('replacement service did not start');
      await delay(25);
    }

    // A new supervisor should have acknowledged
    const result = JSON.parse(readFileSync(pluginSupervisorResultPath(), 'utf8'));
    expect(result.pid).not.toBe(oldPid);
    expect(result.runtimeGeneration).toBeDefined(); // The new one must write its generation
    expect(readPluginSupervisorDesired().services.test).toEqual({ spec: restoredSpec, running: true });
    expect(Number(readFileSync(restoredPath, 'utf8'))).not.toBe(orphan.pid);

    // Cleanup through the real shutdown path so its service child is reaped.
    process.kill(result.pid, 'SIGTERM');
    await untilStopped(result.pid);
  }, 20000);

  it.each([
    ['missing', undefined],
    ['mismatched', 'not-this-process'],
  ])('fails closed when the old supervisor process identity is %s', async (_label, processStart) => {
    const child = spawn('node', ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
    children.add(child);
    expect(child.pid).toBeDefined();
    while (!readDurableProcessIdentity(child.pid!)) await delay(10);
    mkdirSync(pluginSupervisorDir(), { recursive: true });
    writeFileSync(pluginSupervisorResultPath(), JSON.stringify({
      revision: 'old-rev', pid: child.pid, ...(processStart ? { processStart } : {}),
    }));

    await expect(changePluginService('test', 'start', spec)).rejects.toThrow(
      `plugin_supervisor_identity_${processStart ? 'mismatch' : 'unknown'}:${child.pid}`,
    );
    expect(readDurableProcessIdentity(child.pid!)).toBeDefined();
    expect(readPluginSupervisorDesired().services.test).toEqual({ spec, running: true });
  });

  it('fails explicitly when an attested old supervisor does not exit before the bound', async () => {
    const readyPath = join(home, 'stubborn.ready');
    const child = spawn('node', ['-e', `
      const fs = require('node:fs');
      process.on('SIGTERM', () => {});
      fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');
      setInterval(() => {}, 1000);
    `], { stdio: 'ignore' });
    children.add(child);
    expect(child.pid).toBeDefined();
    while (!existsSync(readyPath) || !readDurableProcessIdentity(child.pid!)) await delay(10);
    mkdirSync(pluginSupervisorDir(), { recursive: true });
    writeFileSync(pluginSupervisorResultPath(), JSON.stringify({
      revision: 'old-rev', pid: child.pid, processStart: readDurableProcessIdentity(child.pid!),
    }));

    const startedAt = Date.now();
    await expect(changePluginService('test', 'start', spec))
      .rejects.toThrow(`plugin_supervisor_upgrade_stop_timeout:${child.pid}`);
    expect(Date.now() - startedAt).toBeLessThan(16_000);
    expect(pidAlive(child.pid!)).toBe(true);
    expect(readPluginSupervisorDesired().services.test.running).toBe(true);
  }, 20_000);
});

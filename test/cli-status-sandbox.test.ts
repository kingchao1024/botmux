import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeFleetState } from '../src/core/fleet-state-store.js';
import { freshProc } from '../src/core/fleet-supervisor-policy.js';
import { publishDaemonDescriptor } from '../src/utils/daemon-discovery.js';
import { spawnTsScript } from './helpers/ts-runner.js';

const CLI_PATH = join(__dirname, '..', 'src', 'cli.ts');
const tempDirs: string[] = [];

function runStatus(dataDir: string, homeDir: string): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnTsScript(CLI_PATH, ['status'], {
      env: {
        ...process.env,
        SESSION_DATA_DIR: dataDir,
        HOME: homeDir,
        USERPROFILE: homeDir,
        BOTMUX_SESSION_ID: 'sandbox-session',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.once('error', reject);
    child.once('close', status => resolve({ status, stdout }));
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('botmux status in a PID-isolated session', () => {
  it('uses a fresh descriptor instead of reporting a host daemon dead', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-status-sandbox-data-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'botmux-status-sandbox-home-'));
    tempDirs.push(dataDir, homeDir);
    const missingHostPid = 999_999;
    mkdirSync(join(homeDir, '.botmux'), { recursive: true });
    writeFleetState(join(homeDir, '.botmux', 'fleet-state.json'), {
      supervisorPid: 999_998,
      supervisorStartedAt: '2026-09-04T00:00:00.000Z',
      procs: [freshProc('botmux-0', 'cli_agent', missingHostPid, '2026-09-04T00:00:00.000Z')],
    });
    publishDaemonDescriptor(join(dataDir, 'dashboard-daemons'), {
      larkAppId: 'cli_agent',
      ipcPort: 7950,
      bootInstanceId: 'A'.repeat(43),
      processStartIdentity: 'host-only-generation',
      rosterRevision: 'a'.repeat(64),
      pid: missingHostPid,
      lastHeartbeat: Date.now(),
    });

    const result = await runStatus(dataDir, homeDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('supervisor 在隔离会话内不可验证');
    expect(result.stdout).toMatch(/botmux-0\s+999999\s+online/);
    expect(result.stdout).not.toContain('dead?');
  });
});

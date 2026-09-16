import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnTsScript } from './helpers/ts-runner.js';
import { RELAY_ORIGIN_CAPABILITY_BASENAME } from '../src/core/managed-origin-capability.js';

const CLI_PATH = join(__dirname, '..', 'src', 'cli.ts');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runAuthoring(sub: string, extra: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'workflow-relay-cli-data-'));
  const relayDir = mkdtempSync(join(tmpdir(), 'workflow-relay-cli-outbox-'));
  tempDirs.push(dataDir, relayDir);
  const capabilityPath = join(relayDir, RELAY_ORIGIN_CAPABILITY_BASENAME);
  writeFileSync(capabilityPath, JSON.stringify({ token: 'ab'.repeat(32), turnId: 'om_turn' }));
  chmodSync(capabilityPath, 0o600);
  return new Promise((resolve, reject) => {
    const child = spawnTsScript(CLI_PATH, ['workflow', sub, 'run-1', ...extra], {
      env: {
        ...process.env,
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: 'session-1',
        BOTMUX_SEND_RELAY: relayDir,
        BOTMUX_DAEMON_IPC_PORT: '1',
        BOTMUX_WORKFLOW_ENABLED: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', status => resolve({ status, stdout, stderr }));
  });
}

describe('workflow authoring session relay CLI', () => {
  it.each(['spec-finalize', 'approve-spec', 'architect', 'approve-dag'])(
    'rejects extra arguments for %s before contacting the daemon',
    async sub => {
      const result = await runAuthoring(sub, ['--base-dir', '/tmp/forged']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('只接受一个 runId，不接受其它参数');
      expect(result.stderr).not.toContain('无法连接 daemon');
    },
  );
});

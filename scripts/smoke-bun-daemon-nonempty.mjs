#!/usr/bin/env node
/**
 * Smoke the compiled daemon path with one apiOnly bot. This avoids Feishu
 * credentials while exercising daemon bootstrap beyond the empty-roster binary
 * smoke. Usage: node scripts/smoke-bun-daemon-nonempty.mjs <binary>
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const production = process.argv.includes('--production');
const binaryArg = process.argv.slice(2).find(value => value !== '--production');
const binary = binaryArg ? resolve(binaryArg) : undefined;
if (!binary || !existsSync(binary)) {
  console.error('usage: node scripts/smoke-bun-daemon-nonempty.mjs <binary>');
  process.exit(2);
}

const root = mkdtempSync(join(tmpdir(), 'botmux-nonempty-daemon-smoke-'));
const dataDir = join(root, 'data');
const botmuxDir = join(root, '.botmux');
const botsPath = join(botmuxDir, 'bots.json');
const port = 20_000 + Math.floor(Math.random() * 10_000);
mkdirSync(dataDir, { recursive: true });
mkdirSync(botmuxDir, { recursive: true });
const bots = [{
  larkAppId: 'local_nonempty_compiled_smoke',
  apiOnly: true,
  cliId: 'codex-app',
  displayName: 'compiled-daemon-smoke',
}];
const botsJson = JSON.stringify(bots);
writeFileSync(botsPath, botsJson);
if (production) {
  const secretPath = join(botmuxDir, '.dashboard-secret');
  writeFileSync(secretPath, 'compiled-production-smoke-host-secret');
  chmodSync(secretPath, 0o600);
}
const sha256 = value => createHash('sha256').update(value).digest('hex');
const canonicalJson = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
};
const rawSha256 = sha256(botsJson);
const configSha256 = sha256(canonicalJson(bots));
const rosterSha256 = sha256(JSON.stringify([bots[0].larkAppId]));
const rosterRevision = sha256(`botmux-roster-v1\0${botsPath}\0${rawSha256}\0${configSha256}\0${rosterSha256}`);

const child = spawn(binary, ['__daemon'], {
  cwd: root,
  env: {
    ...process.env, HOME: root, BOTS_CONFIG: botsPath, SESSION_DATA_DIR: dataDir, BOTMUX_BOT_INDEX: '0',
    BOTMUX_EXPECTED_APP_ID: bots[0].larkAppId, BOTMUX_ROSTER_REVISION: rosterRevision,
    BOTMUX_DAEMON_IPC_BASE_PORT: String(port), BOTMUX_WEB_PROXY_BASE_PORT: String(port + 100),
    ...(production ? {
      TASK_CONTROL_PLANE_PRODUCTION: 'true', TASK_CONTROL_PLANE_LEDGER_ENABLED: 'true',
      TASK_CONTROL_PLANE_PUMP_ENABLED: 'true', TASK_CONTROL_PLANE_FREEZE_ENFORCEMENT: 'false',
      TASK_CONTROL_PLANE_SHADOW_ENABLED: 'false',
    } : {}),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', chunk => { output += String(chunk); });
child.stderr.on('data', chunk => { output += String(chunk); });

async function cleanup() {
  if (child.exitCode === null) { try { child.kill('SIGTERM'); } catch {} }
  if (child.exitCode === null) await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch {} }
  try { rmSync(root, { recursive: true, force: true }); } catch {}
}

try {
  const deadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`daemon exited ${child.exitCode}: ${output.slice(-800)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/__health`, { signal: AbortSignal.timeout(1_000) });
      if (response.status === 200) { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error(`daemon did not reach healthz: ${output.slice(-800)}`);
  console.log(`smoke: ✅ nonempty apiOnly ${production ? 'production-flag ' : ''}daemon reached __health`);
} catch (error) {
  console.error(`smoke: FAIL [nonempty-daemon] ${error instanceof Error ? error.message : String(error)}`);
  await cleanup();
  process.exit(1);
}
await cleanup();
process.exit(0);

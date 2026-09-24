#!/usr/bin/env node
/**
 * Smoke the compiled daemon path with one apiOnly bot. This avoids Feishu
 * credentials while exercising daemon bootstrap beyond the empty-roster binary
 * smoke. Usage: node scripts/smoke-bun-daemon-nonempty.mjs <binary>
 */
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
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

const daemonEnv = {
    ...process.env, HOME: root, BOTS_CONFIG: botsPath, SESSION_DATA_DIR: dataDir, BOTMUX_BOT_INDEX: '0',
    BOTMUX_EXPECTED_APP_ID: bots[0].larkAppId, BOTMUX_ROSTER_REVISION: rosterRevision,
    BOTMUX_DAEMON_IPC_BASE_PORT: String(port), BOTMUX_WEB_PROXY_BASE_PORT: String(port + 100),
    ...(production ? {
      TASK_CONTROL_PLANE_PRODUCTION: 'true', TASK_CONTROL_PLANE_LEDGER_ENABLED: 'true',
      TASK_CONTROL_PLANE_PUMP_ENABLED: 'true', TASK_CONTROL_PLANE_FREEZE_ENFORCEMENT: 'false',
      TASK_CONTROL_PLANE_SHADOW_ENABLED: 'false',
    } : {}),
};
let child;
let output = '';
async function startDaemon() {
  child = spawn(binary, ['__daemon'], { cwd: root, env: daemonEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { output += String(chunk); });
  await new Promise((resolveSpawn, rejectSpawn) => {
    let spawned = false;
    child.once('spawn', () => { spawned = true; resolveSpawn(); });
    child.on('error', error => {
      output += `${error instanceof Error ? error.message : String(error)}\n`;
      if (!spawned) rejectSpawn(error);
    });
  });
}

async function cleanup() {
  if (child?.exitCode === null) { try { child.kill('SIGTERM'); } catch {} }
  if (child?.exitCode === null) await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 3_000)),
  ]);
  if (child?.exitCode === null) { try { child.kill('SIGKILL'); } catch {} }
  try { rmSync(root, { recursive: true, force: true }); } catch {}
}

async function waitForHealth(label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label}: daemon exited ${child.exitCode}: ${output.slice(-800)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/__health`, { signal: AbortSignal.timeout(1_000) });
      if (response.status === 200) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${label}: daemon did not reach healthz: ${output.slice(-800)}`);
}

async function stopDaemon() {
  if (child.exitCode === null) { try { child.kill('SIGTERM'); } catch {} }
  if (child.exitCode === null) await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch {} }
}

function daemonHeaders(path) {
  const ts = Math.floor(Date.now() / 1_000).toString();
  const nonce = randomBytes(8).toString('hex');
  const binding = `POST ${path} ${port}`;
  const signature = createHmac('sha256', 'compiled-production-smoke-host-secret').update(`${ts}:${nonce}:${binding}`).digest('base64url');
  return { 'content-type': 'application/json', 'X-Botmux-Cli-Ts': ts, 'X-Botmux-Cli-Nonce': nonce, 'X-Botmux-Cli-Auth': signature };
}

try {
  await startDaemon();
  await waitForHealth('initial');
  if (production) {
    const { DatabaseSync } = await import('node:sqlite');
    const databasePath = join(dataDir, 'botmux-task-control-plane.sqlite');
    if (!existsSync(databasePath)) throw new Error('production control-plane SQLite missing');
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      if (String(database.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase() !== 'wal') throw new Error('production control-plane WAL not active');
    } finally { database.close(); }
    const route = '/api/task-control/mappings';
    const routeResponse = await fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: daemonHeaders(route), body: '{}' });
    if (routeResponse.status !== 400) throw new Error(`production task-control route unavailable:${routeResponse.status}`);
    await stopDaemon();
    await startDaemon();
    await waitForHealth('recovery');
  }
  console.log(`smoke: ✅ nonempty apiOnly ${production ? 'production-flag ' : ''}daemon reached __health`);
} catch (error) {
  console.error(`smoke: FAIL [nonempty-daemon] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}

/**
 * Fleet runtime resolution — the single source of truth for what the supervisor
 * (and cmdStart) need to launch the fleet: the bot specs, the shared daemon env,
 * the node args, the dist dir, and the state-file path. Mirrors what the old
 * pm2 `ecosystemConfig` computed, minus pm2 itself.
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { readFileSync, openSync, mkdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import type { FleetBotSpec } from './fleet-supervisor.js';
import { pidAlive } from './fleet-supervisor.js';
import { resolveEntrySpawn } from './self-spawn.js';
import { readFleetState } from './fleet-state-store.js';
import { resolveBotmuxDataDir } from './data-dir.js';
import { enqueueFleetCommand } from './fleet-command-queue.js';
import type { FleetProcState, FleetState } from './fleet-supervisor-policy.js';
import { FLEET_GRACEFUL_EXIT_CODE } from './fleet-supervisor-policy.js';
import { botProcessName } from '../setup/bot-config-editor.js';
import { resolveDaemonEnv } from '../cli/daemon-lifecycle-env.js';
import { scrubDetachedRestartEnvRefresh } from './restart-env-refresh.js';
import type { RestartEnvFallback } from './restart-env-refresh.js';
import { stripDashboardH5Env } from '../utils/child-env.js';
import { findQuotaFallbackCycles } from '../services/quota-fallback.js';
import { resolveBotsConfigFile } from './config-dir.js';
import { readDeviceIsolationRosterSnapshot } from '../services/device-isolation-roster.js';
import { SUPERVISOR_SHUTDOWN_PROTOCOL } from './supervisor-shutdown-protocol.js';
import { readSupervisorProcessStartIdentity } from './process-start-identity.js';
import { listOnlineDaemons, type OnlineDaemonInfo } from '../utils/daemon-discovery.js';
import {
  FLEET_LAUNCH_PLAN_ENV,
  encodeFleetLaunchPlan,
  fleetLaunchPlanFromRoster,
  validateFleetLaunchPlan,
  type FleetLaunchPlan,
} from './fleet-launch-plan.js';

const CONFIG_DIR = join(homedir(), '.botmux');
const HEAPSHOT_DIR = join(CONFIG_DIR, 'heapshots');
const ENV_FILE = join(CONFIG_DIR, '.env');

/** Path to the fleet state file (replaces pm2 jlist/dump). */
export function fleetStatePath(): string {
  return join(CONFIG_DIR, 'fleet-state.json');
}

/** Directory for per-bot daemon logs (daemon-<index>-out/err.log), the same
 *  LOG_DIR the old pm2 ecosystem wrote out_file/error_file into. */
export function fleetLogDir(): string {
  return LOG_DIR;
}

/** Path to the CLI→supervisor single-bot command queue (start-bot / stop-bot). */
export function fleetCommandPath(): string {
  return join(CONFIG_DIR, 'fleet-commands.json');
}

/** dist/ directory of THIS build (Node path). Under the standalone binary the
 *  spawner ignores it and re-execs the binary, so any value is fine there. */
export function fleetDistDir(): string {
  // dist/core/fleet-runtime.js → dist/
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/** Node interpreter args every daemon gets (heap ceiling + heap-snapshot dir).
 *  Matches the old ecosystem node_args; ignored for the standalone binary. */
export function fleetDaemonNodeArgs(): string[] {
  return ['--max-old-space-size=8192', `--diagnostic-dir=${HEAPSHOT_DIR}`];
}

/** The shared env every supervised member (bot daemons + the dashboard) inherits.
 *  Loads the legacy global .env for backward compat (WEB_HOST etc.), same as
 *  index-daemon did via dotenv. */
export type FleetDaemonEnvFileRead =
  | { status: 'loaded'; text: string }
  | { status: 'missing' }
  | { status: 'failed' };

export interface FleetDaemonEnvFileReadOptions {
  retryDelaysMs?: readonly number[];
  sleep?: (delayMs: number) => void;
}

const DEFAULT_ENV_FILE_RETRY_DELAYS_MS = [10, 25] as const;

/**
 * Read the optional fleet .env without mistaking an unlink-to-rename update for
 * deletion. The first read happens immediately; only ENOENT enters a finite
 * synchronous quiet period that may recover a replacement which appears while
 * we wait. Exhausting that period is still uncertain: elapsed time is not a
 * writer barrier, so an external unlink-to-rename update may remain in flight.
 * Without an explicit deletion signal we fail safe and let callers retain their
 * authenticated fallback snapshot.
 */
export function readFleetDaemonEnvFile(
  envFilePath = ENV_FILE,
  readTextFile: (path: string) => string = path => readFileSync(path, 'utf-8'),
  statFile: (path: string) => unknown = path => statSync(path),
  options: FleetDaemonEnvFileReadOptions = {},
): FleetDaemonEnvFileRead {
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_ENV_FILE_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? sleepSyncMs;

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      return { status: 'loaded', text: readTextFile(envFilePath) };
    } catch (readError) {
      if ((readError as NodeJS.ErrnoException).code !== 'ENOENT') return { status: 'failed' };
    }

    try {
      statFile(envFilePath);
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') return { status: 'failed' };
    }

    if (attempt < retryDelaysMs.length) sleep(retryDelaysMs[attempt]);
  }

  return { status: 'failed' };
}

export function resolveFleetDaemonEnv(
  inheritedEnv: NodeJS.ProcessEnv = process.env,
  envFile: FleetDaemonEnvFileRead | string | undefined = readFleetDaemonEnvFile(),
  options: boolean | StartFleetOptions = Boolean(inheritedEnv.BOTMUX_SESSION_ID?.trim()),
  planValue?: FleetLaunchPlan,
): NodeJS.ProcessEnv {
  // A restart invoked inside a managed session inherits the old daemon's
  // settings. Resolve the persisted lifecycle snapshot before spawning the
  // supervisor; its entrypoint deliberately drops BOTMUX_SESSION_ID, after
  // which it is too late to distinguish a session restart from a shell start.
  const envFileRead: FleetDaemonEnvFileRead = typeof envFile === 'string'
    ? { status: 'loaded', text: envFile }
    : envFile ?? { status: 'missing' };
  const refreshPersistedEnv = typeof options === 'boolean'
    ? options
    : options.refreshPersistedEnv ?? Boolean(inheritedEnv.BOTMUX_SESSION_ID?.trim());
  const inferredSessionRefresh = typeof options !== 'boolean'
    && options.refreshPersistedEnv === undefined
    && Boolean(inheritedEnv.BOTMUX_SESSION_ID?.trim());
  const readFailureFallback = typeof options === 'boolean'
    ? (options ? inheritedEnv : undefined)
    : options.readFailureFallback ?? (inferredSessionRefresh ? inheritedEnv : undefined);
  const lifecycleSource = envFileRead.status === 'failed' && refreshPersistedEnv
    ? readFailureFallback ?? {}
    : inheritedEnv;
  const env: NodeJS.ProcessEnv = {
    ...inheritedEnv,
    ...resolveDaemonEnv(
      lifecycleSource,
      envFileRead.status === 'loaded' ? envFileRead.text : undefined,
      envFileRead.status === 'failed' ? false : refreshPersistedEnv,
    ),
  };
  scrubDetachedRestartEnvRefresh(env);
  stripDashboardH5Env(env);
  //
  // MIGRATION-CRITICAL: pin SESSION_DATA_DIR for every supervised child. The old
  // pm2 ecosystem injected `SESSION_DATA_DIR: DATA_DIR` into both the bot daemons
  // AND the dashboard; the pm2→supervisor migration deleted that ecosystem and
  // did NOT re-inject it. Without it, `config.session.dataDir` (a lazy getter)
  // had NO env to read and the daemon/dashboard entrypoints don't run the CLI's
  // `??= resolveDataDir()` — so it resolved to the PACKAGE dir (<pkg>/data)
  // instead of ~/.botmux/data. On an upgrade that silently moves the whole
  // fleet's data root: every existing session / pairing / federation / VC
  // binding under ~/.botmux/data becomes invisible (a fresh install has no old
  // data, so this never shows in author self-test — but a live upgrade always
  // hits it). resolveBotmuxDataDir() reproduces the CLI's resolution
  // (SESSION_DATA_DIR env > ~/.botmux/.data-dir breadcrumb > ~/.botmux/data).
  //
  // Two further reasons the ENV must be present, beyond config.session.dataDir
  // (whose own fallback is now the same canonical resolver — see config.ts):
  //   • Some readers deliberately consult `process.env.SESSION_DATA_DIR` INSTEAD
  //     of config.session.dataDir and DEGRADE when absent — e.g. session-manager's
  //     effectivePromptHookConfigPath, whose comment asserts "daemon 进程必有此
  //     env" and which silently falls back to the GLOBAL hook config (losing
  //     per-bot isolation). A config.ts-level fix cannot reach those.
  //   • It guarantees the dashboard reads the SAME store as the bot daemons.
  //
  // Blank-guarded rather than plain `??=`: `??=` keeps an empty/whitespace value,
  // and every downstream `resolve('')` would then silently mean CWD. A blank is
  // treated as unset; a real explicit value (test/dev override) is preserved.
  if (!env.SESSION_DATA_DIR?.trim()) env.SESSION_DATA_DIR = resolveBotmuxDataDir({ env });
  env.BOTS_CONFIG = planValue
    ? validateFleetLaunchPlan(planValue).requestedConfigPath
    : resolveBotsConfigFile({ env });
  // Parity with the old ecosystem's stop_exit_codes:[90] sentinel — restores the
  // graceful-exit code for self-exit paths (e.g. dashboard self-update) that read
  // it. The supervisor's own restart suppression already covers operator stops via
  // explicitStop/stopping, so this is belt-and-suspenders, not load-bearing.
  env.BOTMUX_PM2_GRACEFUL_EXIT_CODE ??= String(FLEET_GRACEFUL_EXIT_CODE);
  return env;
}

/** Build the fleet's bot specs from bots.json: name, appId, and the 0-based
 *  index the daemon reads via BOTMUX_BOT_INDEX. The name MUST equal
 *  botProcessName(bot, index) so it correlates 1:1 with what the CLI (status,
 *  logs --bot, start-bot/stop-bot) and the dashboard address a bot by. */
/** Pure projection used by startup and regression tests. Cyclic handoff members
 * are intentionally absent; the dashboard is appended separately by
 * resolveFleetMembers(), so operators retain a recovery surface. */
export function resolveFleetBotsFromEntries(list: readonly unknown[]): FleetBotSpec[] {
  const cyclicAppIds = new Set(findQuotaFallbackCycles(list as any[]).flat());
  return list.map((b, index) => {
    const bot = (b ?? {}) as { name?: unknown; larkAppId?: unknown };
    return {
      name: botProcessName(bot as { name?: unknown }, index),
      appId: typeof bot.larkAppId === 'string' ? bot.larkAppId : '',
      botIndex: index,
    };
  }).filter(spec => !cyclicAppIds.has(spec.appId));
}

export function resolveFleetBots(planValue?: FleetLaunchPlan): FleetBotSpec[] {
  if (planValue) {
    const plan = validateFleetLaunchPlan(planValue);
    return plan.bots.map(bot => ({
      name: bot.name,
      appId: bot.appId,
      botIndex: bot.botIndex,
      botsConfigPath: plan.requestedConfigPath,
      rosterRevision: plan.rosterRevision,
    }));
  }
  const roster = readDeviceIsolationRosterSnapshot({ allowMissingDefault: true });
  const cyclicAppIds = quotaFallbackCycleIds(roster.configPath);
  return roster.members.map((bot) => {
    return {
      // Canonical process name — reuse botProcessName so the supervisor's proc
      // name is byte-identical to every other addressing surface (no second,
      // divergent normalization that would desync status/logs/start-bot).
      name: botProcessName(bot, bot.index),
      appId: bot.larkAppId,
      botIndex: bot.index,
      botsConfigPath: roster.requestedConfigPath,
      rosterRevision: roster.revision,
    };
  }).filter(spec => !cyclicAppIds.has(spec.appId));
}

function quotaFallbackCycleIds(configPath: string): Set<string> {
  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw error;
  }
  const raw = JSON.parse(text) as unknown;
  if (!Array.isArray(raw)) return new Set();
  return new Set(findQuotaFallbackCycles(raw).flat());
}

const LOG_DIR = join(CONFIG_DIR, 'logs');

/** Canonical process name of the dashboard fleet member — byte-identical to the
 *  name the old pm2 ecosystem used, so status/logs correlate across the
 *  migration. */
export const DASHBOARD_PROCESS_NAME = 'botmux-dashboard';

/**
 * The dashboard's fleet spec. The dashboard is supervised exactly like a bot
 * daemon (crash-restart, graceful-exit code 90 → no restart, max_restarts park),
 * but runs the `dashboard` entry (index-dashboard.ts) instead of a bot daemon,
 * carries no bot index/appId, and logs to dashboard-{out,err}.log. This is what
 * replaces the old unconditional `apps.push({ name: 'botmux-dashboard', … })` in
 * pm2's ecosystemConfig — the dashboard was always a fleet app under pm2, so it
 * is always a supervised member now too.
 */
export function resolveDashboardSpec(): FleetBotSpec {
  return {
    name: DASHBOARD_PROCESS_NAME,
    appId: '',
    botIndex: -1, // not a bot; never used because entry !== 'daemon'
    entry: 'dashboard',
    logBaseName: 'dashboard',
  };
}

/**
 * Every process the supervisor manages: the bot daemons from bots.json PLUS the
 * dashboard. This is the list the supervisor `start()` reconciles and the set
 * `botmux restart` health-gates on. Kept separate from `resolveFleetBots()`,
 * which stays bot-only so bot addressing (start-bot/stop-bot by appId, status
 * rows) is unaffected.
 */
export function resolveFleetMembers(planValue?: FleetLaunchPlan): FleetBotSpec[] {
  return [...resolveFleetBots(planValue), resolveDashboardSpec()];
}

/** Capture a secret-free launch plan from the exact locked config generation. */
export function captureFleetLaunchPlan(
  requestedConfigPath: string,
  lockedCanonicalPath?: string,
): FleetLaunchPlan {
  const roster = readDeviceIsolationRosterSnapshot({
    configPath: requestedConfigPath,
    allowMissingDefault: true,
  });
  if (lockedCanonicalPath && roster.configPath !== lockedCanonicalPath) {
    throw new Error('locked bots-config target does not match the roster canonical target');
  }
  const plan = fleetLaunchPlanFromRoster(roster, lockedCanonicalPath);
  const cyclicAppIds = quotaFallbackCycleIds(roster.configPath);
  return validateFleetLaunchPlan({
    ...plan,
    bots: plan.bots.filter(bot => !cyclicAppIds.has(bot.appId)),
  });
}

/** Detached-supervisor startup validation: never replace the supplied plan by rereading. */
export function validateSupervisorLaunchPlan(planValue: unknown): FleetLaunchPlan {
  const plan = validateFleetLaunchPlan(planValue);
  const roster = readDeviceIsolationRosterSnapshot({ configPath: plan.requestedConfigPath });
  const expected = captureFleetLaunchPlan(plan.requestedConfigPath, roster.configPath);
  if (JSON.stringify(plan) !== JSON.stringify(expected)) {
    throw new Error('fleet launch plan does not match the configured roster generation');
  }
  return plan;
}

/** True if a live fleet supervisor is already running (per fleet-state pid + kill -0). */
export function liveSupervisorPid(): number | undefined {
  const state = readFleetState(fleetStatePath());
  const pid = state?.supervisorPid ?? 0;
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
  try { process.kill(pid, 0); return pid; } catch { return undefined; }
}

export interface StartFleetResult {
  action: 'started' | 'already-running';
  supervisorPid: number;
  supervisorProcessStartIdentity: string;
  botCount: number;
}

/**
 * Launch the fleet supervisor as a detached, long-lived process (replaces
 * `pm2 start`). Single-supervisor guarantee: if a live supervisor already owns
 * the fleet, this is a no-op ('already-running') — the running supervisor is
 * itself idempotent and keeps the fleet reconciled. The spawned supervisor
 * outlives this CLI (detached + unref), with stdout/err to the botmux log dir;
 * boot persistence (systemd/launchd) re-invokes `botmux start` → here.
 *
 * NOTE: the caller must already hold the fleet-mutation file lock so two
 * concurrent `botmux start` invocations can't both pass the liveness check.
 */
export interface StartFleetOptions {
  refreshPersistedEnv?: boolean;
  readFailureFallback?: RestartEnvFallback;
}

export function startFleetViaSupervisor(
  planValue: FleetLaunchPlan,
  options: StartFleetOptions = {},
): StartFleetResult {
  const plan = validateFleetLaunchPlan(planValue);
  const existing = liveSupervisorPid();
  if (existing !== undefined) {
    const processStartIdentity = readSupervisorProcessStartIdentity(existing);
    if (!processStartIdentity) throw new Error('cannot identify the live fleet supervisor generation');
    return {
      action: 'already-running',
      supervisorPid: existing,
      supervisorProcessStartIdentity: processStartIdentity,
      botCount: plan.bots.length,
    };
  }
  mkdirSync(LOG_DIR, { recursive: true });
  const out = openSync(join(LOG_DIR, 'supervisor-out.log'), 'a');
  const err = openSync(join(LOG_DIR, 'supervisor-err.log'), 'a');
  const { command, args } = resolveEntrySpawn('supervisor', fleetDistDir());
  const nodeArgs = args.length > 0 && args[0].startsWith('__') ? [] : ['--enable-source-maps'];
  const child = spawn(command, [...nodeArgs, ...args], {
    cwd: CONFIG_DIR,
    detached: true,
    stdio: ['ignore', out, err],
    env: {
      ...resolveFleetDaemonEnv(process.env, readFleetDaemonEnvFile(), options, plan),
      [FLEET_LAUNCH_PLAN_ENV]: encodeFleetLaunchPlan(plan),
    },
  });
  const supervisorPid = child.pid ?? 0;
  const supervisorProcessStartIdentity = readSupervisorProcessStartIdentity(supervisorPid);
  if (!supervisorProcessStartIdentity) {
    try { child.kill('SIGKILL'); } catch { /* spawn already failed/exited */ }
    throw new Error('cannot bind the new fleet supervisor to a process generation');
  }
  child.unref();
  return {
    action: 'started',
    supervisorPid,
    supervisorProcessStartIdentity,
    botCount: plan.bots.length,
  };
}

const STOP_POLL_INTERVAL_MS = 100;
const DEFAULT_STOP_TIMEOUT_MS = 15_000;

export interface StopFleetResult {
  action: 'stopped' | 'not-running' | 'timeout';
  supervisorPid: number;
}

/**
 * Stop the whole fleet by signaling the live supervisor and waiting for it to
 * exit (replaces `pm2 stop` + God teardown). SIGTERM triggers the supervisor's
 * own `stopAll()` — graceful SIGTERM→kill_timeout→SIGKILL of every daemon, plus
 * finalizing fleet-state (procs → stopped, supervisorPid → 0). We poll the pid
 * with kill-0 until it's gone; on timeout we escalate to SIGKILL of the
 * supervisor itself (its children still received SIGTERM and self-reap).
 *
 * NOTE: caller must hold the fleet-mutation lock (single stop/start/restart at
 * a time), same contract as startFleetViaSupervisor.
 */
export function stopFleet(timeoutMs = DEFAULT_STOP_TIMEOUT_MS): StopFleetResult {
  const pid = liveSupervisorPid();
  if (pid === undefined) return { action: 'not-running', supervisorPid: 0 };
  try { process.kill(pid, 'SIGTERM'); } catch { return { action: 'not-running', supervisorPid: pid }; }
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return { action: 'stopped', supervisorPid: pid };
    sleepSyncMs(STOP_POLL_INTERVAL_MS);
  }
  if (!pidAlive(pid)) return { action: 'stopped', supervisorPid: pid };
  // Supervisor outlasted its graceful window — hard-kill it. Its daemon children
  // already got SIGTERM from stopAll() and will exit on their own.
  try { process.kill(pid, 'SIGKILL'); } catch { /* raced to exit */ }
  return pidAlive(pid) ? { action: 'timeout', supervisorPid: pid } : { action: 'stopped', supervisorPid: pid };
}

export type RestartFleetResult =
  | { action: 'started'; stop: StopFleetResult; start: StartFleetResult }
  | { action: 'stop-timeout'; stop: StopFleetResult; start?: never };

export interface RestartFleetDependencies {
  stop?: (timeoutMs: number) => StopFleetResult;
  start?: (plan: FleetLaunchPlan) => StartFleetResult;
}

/**
 * Restart the fleet: stop the live supervisor (if any), then start a fresh one
 * from the caller's immutable launch plan. Caller must hold the fleet-mutation
 * lock; a stop timeout explicitly suppresses successor launch.
 */
export interface RestartFleetOptions extends StartFleetOptions {
  timeoutMs?: number;
}

export function restartFleet(
  planValue: FleetLaunchPlan,
  optionsOrTimeout: RestartFleetOptions | number = {},
  dependencies: RestartFleetDependencies = {},
): RestartFleetResult {
  const plan = validateFleetLaunchPlan(planValue);
  const options = typeof optionsOrTimeout === 'number' ? {} : optionsOrTimeout;
  const timeoutMs = typeof optionsOrTimeout === 'number'
    ? optionsOrTimeout
    : options.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const stop = (dependencies.stop ?? stopFleet)(timeoutMs);
  if (stop.action === 'timeout') return { action: 'stop-timeout', stop };
  const start = dependencies.start
    ? dependencies.start(plan)
    : startFleetViaSupervisor(plan, options);
  return { action: 'started', stop, start };
}

export interface FleetStatusRow {
  name: string;
  appId: string;
  pid: number;
  status: FleetProcState['status'];
  alive: boolean;
  restarts: number;
  lastExitCode: number | null;
  startedAt: string | null;
}

export interface FleetStatus {
  supervisorPid: number;
  supervisorAlive: boolean;
  supervisorStartedAt: string;
  rows: FleetStatusRow[];
}

/**
 * Project a raw FleetState into a status view, cross-checking each recorded pid
 * with a liveness probe so a stale 'online' row whose daemon actually died is
 * reported alive:false. Pure over (state, isAlive) — unit-testable without HOME.
 */
export function projectFleetStatus(
  state: FleetState | null,
  isAlive: (pid: number) => boolean = pidAlive,
): FleetStatus {
  const supervisorPid = state?.supervisorPid ?? 0;
  return {
    supervisorPid,
    supervisorAlive: isAlive(supervisorPid),
    supervisorStartedAt: state?.supervisorStartedAt ?? '',
    rows: (state?.procs ?? []).map((p) => ({
      name: p.name,
      appId: p.appId,
      pid: p.pid,
      status: p.status,
      alive: isAlive(p.pid),
      restarts: p.restarts,
      lastExitCode: p.lastExitCode,
      startedAt: p.startedAt,
    })),
  };
}

/**
 * Read the current fleet status from fleet-state.json (replaces `pm2 status`).
 * Cross-checks each recorded pid with kill-0 so a stale 'online' row whose
 * daemon actually died is reported alive:false — the supervisor reconciles it
 * on its next tick, but status should never lie about liveness in the meantime.
 */
export function readFleetStatus(statePath: string = fleetStatePath()): FleetStatus {
  return projectFleetStatus(readFleetState(statePath));
}

export interface FleetSupervisorGeneration {
  pid: number;
  processStartIdentity: string;
}

export interface FleetReadinessInspection {
  supervisorReady: boolean;
  daemonReadyNames: string[];
  dashboardProcessReady: boolean;
  pending: string[];
}

/**
 * Pure exact-generation half of restart readiness. A fleet-state PID is only a
 * spawn receipt; a bot is ready only after its modern descriptor is published
 * and matches the planned tuple, state PID, and live kernel process birth.
 */
export function inspectFleetReadiness(
  planValue: FleetLaunchPlan,
  supervisor: FleetSupervisorGeneration,
  state: FleetState | null,
  daemons: readonly OnlineDaemonInfo[],
  processStart: (pid: number) => string | undefined = readSupervisorProcessStartIdentity,
): FleetReadinessInspection {
  const plan = validateFleetLaunchPlan(planValue);
  const liveSupervisorStart = processStart(supervisor.pid);
  const supervisorReady = state?.supervisorPid === supervisor.pid
    && liveSupervisorStart === supervisor.processStartIdentity;
  const daemonReadyNames: string[] = [];
  const pending: string[] = [];

  if (!supervisorReady) pending.push('fleet-supervisor');
  for (const bot of plan.bots) {
    const row = state?.procs.find(candidate => candidate.name === bot.name);
    const liveStart = row?.pid ? processStart(row.pid) : undefined;
    const matches = row
      && row.appId === bot.appId
      && row.status === 'online'
      && row.pid > 1
      && liveStart
      ? daemons.filter(daemon =>
          daemon.larkAppId === bot.appId
          && daemon.botIndex === bot.botIndex
          && daemon.pid === row.pid
          && daemon.processStartIdentity === liveStart
          && daemon.rosterRevision === plan.rosterRevision
          && daemon.supervisorShutdownProtocol === SUPERVISOR_SHUTDOWN_PROTOCOL
          && typeof daemon.bootInstanceId === 'string'
          && daemon.bootInstanceId.length > 0)
      : [];
    // More than one modern descriptor claiming the same process/plan tuple is
    // malformed authority, not extra confidence. Fail closed by keeping pending.
    if (matches.length === 1) daemonReadyNames.push(bot.name);
    else pending.push(bot.name);
  }

  const dashboard = state?.procs.find(candidate => candidate.name === DASHBOARD_PROCESS_NAME);
  const dashboardProcessReady = !!dashboard
    && dashboard.appId === ''
    && dashboard.status === 'online'
    && dashboard.pid > 1
    && processStart(dashboard.pid) !== undefined;
  if (!dashboardProcessReady) pending.push(DASHBOARD_PROCESS_NAME);

  return { supervisorReady, daemonReadyNames, dashboardProcessReady, pending };
}

export interface WaitFleetReadyResult {
  healthy: boolean;
  online: number;
  expected: number;
  pending: string[];
  error?: string;
}

export interface WaitFleetReadyOptions {
  statePath?: string;
  registryDir?: string;
  processStart?: (pid: number) => string | undefined;
  processExists?: (pid: number) => boolean;
  dashboardReady: (remainingMs: number) => Promise<boolean>;
  pollIntervalMs?: number;
}

export interface WaitBotDescriptorReadyOptions {
  statePath?: string;
  registryDir?: string;
  processStart?: (pid: number) => string | undefined;
  processExists?: (pid: number) => boolean;
  pollIntervalMs?: number;
  allowRosterRevisionAdvance?: boolean;
}

/** Exact descriptor readiness for the independently queued `start-bot` path. */
export function waitBotDescriptorReady(
  spec: Pick<FleetBotSpec, 'name' | 'appId' | 'botIndex' | 'botsConfigPath' | 'rosterRevision'>,
  timeoutMs: number,
  options: WaitBotDescriptorReadyOptions = {},
): boolean {
  if (!spec.rosterRevision) return false;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const processStart = options.processStart ?? readSupervisorProcessStartIdentity;
  const processExists = options.processExists ?? pidAlive;
  const statePath = options.statePath ?? fleetStatePath();
  const registryDir = options.registryDir ?? join(resolveBotmuxDataDir(), 'dashboard-daemons');
  for (;;) {
    try {
      let expectedRevision = spec.rosterRevision;
      if (options.allowRosterRevisionAdvance) {
        if (!spec.botsConfigPath) return false;
        const roster = readDeviceIsolationRosterSnapshot({ configPath: spec.botsConfigPath });
        const member = roster.members.find(candidate =>
          candidate.index === spec.botIndex && candidate.larkAppId === spec.appId);
        if (!member || botProcessName(member, member.index) !== spec.name) return false;
        expectedRevision = roster.revision;
      }
      const row = readFleetState(statePath)?.procs.find(candidate => candidate.name === spec.name);
      const liveStart = row?.pid ? processStart(row.pid) : undefined;
      if (row
          && row.appId === spec.appId
          && row.status === 'online'
          && row.pid > 1
          && liveStart) {
        const matches = listOnlineDaemons({
          registryDir, processStart, processExists, cleanupStale: false,
        }).filter(daemon =>
          daemon.larkAppId === spec.appId
          && daemon.botIndex === spec.botIndex
          && daemon.pid === row.pid
          && daemon.processStartIdentity === liveStart
          && daemon.rosterRevision === expectedRevision
          && daemon.supervisorShutdownProtocol === SUPERVISOR_SHUTDOWN_PROTOCOL
          && typeof daemon.bootInstanceId === 'string'
          && daemon.bootInstanceId.length > 0);
        if (matches.length === 1) return true;
      }
    } catch {
      return false;
    }
    if (Date.now() >= deadline) return false;
    sleepSyncMs(Math.min(options.pollIntervalMs ?? 150, Math.max(1, deadline - Date.now())));
  }
}

/** One-deadline readiness gate for a newly launched full-fleet generation. */
export async function waitFleetReady(
  planValue: FleetLaunchPlan,
  supervisor: FleetSupervisorGeneration,
  timeoutMs: number,
  options: WaitFleetReadyOptions,
): Promise<WaitFleetReadyResult> {
  const plan = validateFleetLaunchPlan(planValue);
  const expected = plan.bots.length + 2; // exact supervisor + every daemon + dashboard
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const processStart = options.processStart ?? readSupervisorProcessStartIdentity;
  const processExists = options.processExists ?? pidAlive;
  const statePath = options.statePath ?? fleetStatePath();
  const registryDir = options.registryDir ?? join(resolveBotmuxDataDir(), 'dashboard-daemons');
  let pending = ['fleet-supervisor', ...plan.bots.map(bot => bot.name), DASHBOARD_PROCESS_NAME];

  for (;;) {
    try {
      const state = readFleetState(statePath);
      const daemons = listOnlineDaemons({
        registryDir,
        processStart,
        processExists,
        cleanupStale: false,
      });
      const inspected = inspectFleetReadiness(plan, supervisor, state, daemons, processStart);
      pending = inspected.pending;
      if (inspected.supervisorReady
          && inspected.daemonReadyNames.length === plan.bots.length
          && inspected.dashboardProcessReady) {
        const remainingMs = deadline - Date.now();
        if (remainingMs > 0 && await options.dashboardReady(remainingMs)) {
          // The authenticated request can take time. Re-read exact daemon and
          // supervisor evidence before committing success under the same deadline.
          const after = inspectFleetReadiness(
            plan,
            supervisor,
            readFleetState(statePath),
            listOnlineDaemons({ registryDir, processStart, processExists, cleanupStale: false }),
            processStart,
          );
          if (after.supervisorReady
              && after.daemonReadyNames.length === plan.bots.length
              && after.dashboardProcessReady) {
            return { healthy: true, online: expected, expected, pending: [] };
          }
          pending = after.pending;
        } else if (!pending.includes(DASHBOARD_PROCESS_NAME)) {
          pending = [...pending, DASHBOARD_PROCESS_NAME];
        }
      }
    } catch (error) {
      return {
        healthy: false, online: 0, expected, pending,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return { healthy: false, online: expected - pending.length, expected, pending };
    }
    await new Promise(resolveWait => setTimeout(resolveWait, Math.min(options.pollIntervalMs ?? 250, remainingMs)));
  }
}

/** Block for `ms` without a busy-spin (one-shot CLI; stalling its loop is fine). */
function sleepSyncMs(ms: number): void {
  if (ms <= 0) return;
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* SAB unavailable → no-op */ }
}

export interface WaitFleetOnlineResult {
  healthy: boolean;
  online: number;
  expected: number;
  /** Names not online+alive at timeout (empty when healthy). */
  pending: string[];
}

/**
 * Legacy/basic fleet-state liveness poll. It proves only online rows plus live
 * PIDs and MUST NOT gate start/restart success; use `waitFleetReady` for that.
 */
export function waitFleetOnline(
  expectedNames: readonly string[],
  timeoutMs = 30_000,
  statePath: string = fleetStatePath(),
): WaitFleetOnlineResult {
  const expected = expectedNames.length;
  if (expected === 0) return { healthy: true, online: 0, expected: 0, pending: [] };
  const want = new Set(expectedNames);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let pending: string[] = [...want];
  for (;;) {
    const status = readFleetStatus(statePath);
    const onlineNames = new Set(
      status.rows.filter((r) => want.has(r.name) && r.status === 'online' && r.alive).map((r) => r.name),
    );
    pending = [...want].filter((n) => !onlineNames.has(n));
    if (pending.length === 0) return { healthy: true, online: expected, expected, pending: [] };
    if (Date.now() >= deadline) return { healthy: false, online: expected - pending.length, expected, pending };
    sleepSyncMs(250);
  }
}

/** Every supervised member's name for basic status/liveness consumers. */
export function fleetMemberNames(): string[] {
  return resolveFleetMembers().map((m) => m.name);
}

/** Resolve one bot's fleet spec by larkAppId (null if not in bots.json). */
export function resolveFleetBotByAppId(appId: string): FleetBotSpec | null {
  return resolveFleetBots().find((b) => b.appId === appId) ?? null;
}

export type StartBotSupervisorResult =
  | { ok: true; state: 'started' | 'already-online'; name: string }
  | { ok: false; reason: 'not_found' | 'fleet_down' | 'timeout'; message: string; name?: string };

export type StopBotSupervisorResult =
  | { ok: true; state: 'stopped' | 'already-stopped'; name: string }
  | { ok: false; reason: 'not_found' | 'fleet_down' | 'timeout'; message: string; name?: string };

/**
 * Ask the LIVE supervisor to bring one bot online (the `botmux start-bot` core).
 * The supervisor owns every daemon child, so we enqueue a start-bot command,
 * SIGHUP the supervisor to drain it, and poll fleet-state until that bot is
 * online+alive. When no supervisor is running we return fleet_down — a lone bot
 * belongs to `botmux start`, which brings up the whole fleet (matches the old
 * pm2 semantics). Idempotent: already-online short-circuits.
 *
 * `idFactory`/`nowIso` are injected (no Date/random in shared code paths that
 * also run under the workflow sandbox); the CLI passes real ones.
 */
export function startBotViaSupervisor(
  appId: string,
  idFactory: () => string,
  nowIso: () => string,
  timeoutMs = 30_000,
): StartBotSupervisorResult {
  const spec = resolveFleetBotByAppId(appId);
  if (!spec) return { ok: false, reason: 'not_found', message: `appId ${appId} 不在 bots.json 中` };
  return startBotSpecViaSupervisor(spec, idFactory, nowIso, timeoutMs);
}

export function startBotSpecViaSupervisor(
  spec: FleetBotSpec,
  idFactory: () => string,
  nowIso: () => string,
  timeoutMs = 30_000,
): StartBotSupervisorResult {
  if (!spec.botsConfigPath || !spec.rosterRevision || (spec.entry ?? 'daemon') !== 'daemon') {
    return { ok: false, reason: 'not_found', message: `invalid authoritative bot spec for ${spec.name}` };
  }
  const supervisorPid = liveSupervisorPid();
  if (supervisorPid === undefined) {
    return { ok: false, reason: 'fleet_down', message: 'daemon 未在运行，请先 botmux start', name: spec.name };
  }
  // Already online+alive? No-op.
  const existing = readFleetStatus().rows.find((r) => r.name === spec.name);
  if (existing
      && existing.status === 'online'
      && existing.alive
      && waitBotDescriptorReady(spec, 0, { allowRosterRevisionAdvance: true })) {
    return { ok: true, state: 'already-online', name: spec.name };
  }
  enqueueFleetCommand(fleetCommandPath(), {
    id: idFactory(), op: 'start-bot', name: spec.name, appId: spec.appId, botIndex: spec.botIndex,
    botsConfigPath: spec.botsConfigPath, rosterRevision: spec.rosterRevision, at: nowIso(),
  });
  try { process.kill(supervisorPid, 'SIGHUP'); } catch {
    return { ok: false, reason: 'fleet_down', message: 'supervisor 已不在运行', name: spec.name };
  }
  if (waitBotDescriptorReady(spec, timeoutMs, { allowRosterRevisionAdvance: true })) {
    return { ok: true, state: 'started', name: spec.name };
  }
  return { ok: false, reason: 'timeout', message: `${spec.name} 未在超时时间内上线`, name: spec.name };
}

/**
 * Ask the LIVE supervisor to stop one bot (the `botmux stop-bot` core). Enqueue a
 * stop-bot command, SIGHUP, poll fleet-state until that bot is no longer
 * online+alive. The supervisor marks it explicit-stop so its SIGTERM exit is not
 * treated as a crash-to-restart. fleet_down when no supervisor is running.
 */
export function stopBotViaSupervisor(
  appId: string,
  idFactory: () => string,
  nowIso: () => string,
  timeoutMs = 15_000,
): StopBotSupervisorResult {
  const spec = resolveFleetBotByAppId(appId);
  if (!spec) return { ok: false, reason: 'not_found', message: `appId ${appId} 不在 bots.json 中` };
  const supervisorPid = liveSupervisorPid();
  if (supervisorPid === undefined) {
    return { ok: false, reason: 'fleet_down', message: 'daemon 未在运行', name: spec.name };
  }
  const existing = readFleetStatus().rows.find((r) => r.name === spec.name);
  // Short-circuit as already-stopped ONLY when the bot is genuinely at rest with
  // no supervisor-side work pending: absent, 'stopped' (pid 0), or 'errored'
  // (parked, no restart timer). A 'launching' bot is mid-crash-backoff — the
  // supervisor still holds a pending restart timer that WILL respawn it, so it is
  // NOT stopped; reporting 'already-stopped' here would be a lie and the bot
  // reappears ~200ms later. 'online' (with or without a live pid) likewise needs
  // the supervisor to act. In all those cases we must enqueue + SIGHUP so the
  // supervisor's stopOneBot cancels the timer and marks it stopped authoritatively.
  const atRest = !existing || existing.status === 'stopped' || existing.status === 'errored';
  if (atRest) {
    return { ok: true, state: 'already-stopped', name: spec.name };
  }
  enqueueFleetCommand(fleetCommandPath(), {
    id: idFactory(), op: 'stop-bot', name: spec.name, appId: spec.appId, botIndex: spec.botIndex, at: nowIso(),
  });
  try { process.kill(supervisorPid, 'SIGHUP'); } catch {
    return { ok: false, reason: 'fleet_down', message: 'supervisor 已不在运行', name: spec.name };
  }
  // Poll until the bot has actually come to rest (stopped/errored/absent), or
  // timeout. 'launching' and 'online' both mean the supervisor is still working
  // (or the restart timer hasn't been cancelled yet), so keep waiting.
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const row = readFleetStatus().rows.find((r) => r.name === spec.name);
    if (!row || row.status === 'stopped' || row.status === 'errored') return { ok: true, state: 'stopped', name: spec.name };
    if (Date.now() >= deadline) return { ok: false, reason: 'timeout', message: `${spec.name} 未在超时时间内停止`, name: spec.name };
    sleepSyncMs(150);
  }
}

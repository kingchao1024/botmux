/**
 * Fleet supervisor — LIVE layer (owns spawn/kill/fs/timers). Replaces pm2's God
 * daemon for the multi-bot fleet. One `FleetSupervisor` process (the `__supervisor`
 * entry) spawns each bot's daemon as a `__daemon` child, monitors exits, and
 * applies the pure policy decisions (restart-with-backoff / stop / park). All
 * state goes through fleet-state-store (atomic + locked). Boot persistence stays
 * with systemd/launchd, which re-run `botmux start`.
 *
 * Safety decisions (graceful-exit, max_restarts, projection identity, idempotent
 * start, generation addressing) come from fleet-supervisor-policy — this layer
 * only does the I/O the policy tells it to.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { openSync, closeSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveEntrySpawn, type BotmuxEntry } from './self-spawn.js';
import { scrubExternalMemberEnv } from '../utils/child-env.js';
import {
  decideOnExit,
  freshProc,
  planStart,
  DEFAULT_RESTART_POLICY,
  type FleetProcState,
  type RestartPolicy,
  type ChildExit,
} from './fleet-supervisor-policy.js';
import { mutateFleetState, readFleetState } from './fleet-state-store.js';
import type { FleetCommand } from './fleet-command-queue.js';
import {
  bindDeviceIsolationStartupReservationToChild,
  clearDeviceIsolationStartupIntent,
  reserveDeviceIsolationDaemonStartup,
} from '../services/device-isolation-startup-intent-store.js';
import { withDeviceCredentialIsolationActivationLockSync } from '../platform/device-isolation.js';
import { readDeviceIsolationRosterSnapshot } from '../services/device-isolation-roster.js';
import { FileLockTimeoutError } from '../utils/file-lock.js';
import { botProcessName } from '../setup/bot-config-editor.js';

export interface FleetBotSpec {
  /** botmux-<index> process name (or 'botmux-dashboard' for the dashboard). */
  name: string;
  appId: string;
  /** 0-based bot index passed to the daemon via BOTMUX_BOT_INDEX. Ignored for
   *  non-'daemon' members (the dashboard has no bot index). */
  botIndex: number;
  /** Requested authority path and exact revision from which this daemon was planned. */
  botsConfigPath?: string;
  rosterRevision?: string;
  /** Which entry module to spawn. Defaults to 'daemon' — a normal bot. The
   *  dashboard is a fleet member too ('dashboard'), so the supervisor gives it
   *  the SAME crash-restart / graceful-exit / stop machinery as a bot daemon,
   *  which is why it isn't a bespoke spawn. */
  entry?: BotmuxEntry;
  /** Log file basename under logDir (default `daemon-<botIndex>`). The two
   *  streams become `<base>-out.log` / `<base>-err.log`. Lets the dashboard
   *  write `dashboard-out.log` / `dashboard-err.log` instead of a bot-indexed
   *  name. */
  logBaseName?: string;
  /**
   * A member that is NOT one of botmux's own entry modules — an arbitrary
   * long-lived command (today: a plugin service). Set this INSTEAD of `entry`.
   *
   * WHY THE SUPERVISOR AND NOT pm2: plugin services used to run under a pm2 God
   * at `PLUGIN_PM2_HOME`, which does not work in the shipped build at all —
   * MEASURED in a real compiled binary, `require.resolve('pm2/bin/pm2')` throws
   * (the module graph lives in the virtual `/$bunfs/`), so `pm2Bin()` fell back
   * to a bare `'pm2'` that is not on a user's PATH. The supervisor already gives
   * the dashboard — also not a bot — the same crash-restart / graceful-exit /
   * stop machinery a plugin service needs, and it re-execs `process.execPath`,
   * so it works in the compiled binary by construction.
   *
   * ENV IS SCRUBBED HARDER THAN FOR OUR OWN MEMBERS, deliberately. A bot daemon
   * and the dashboard scrub the full set of session-scoped keys in their OWN
   * boot (index-daemon.ts / index-dashboard.ts) — they are our code, so they can
   * be asked to. An external command will NOT do that for us, and the keys it
   * would inherit are exactly the ones that turn one session's private state
   * into fleet-wide state (a sibling bot's CLI home, the dashboard's H5 app
   * secret, one turn's session identity). So `spawnBot` runs the same scrub the
   * pm2 path used to run (`scrubExternalMemberEnv`) before handing env over.
   */
  external?: {
    /** Executable to run. Resolved by the OS (PATH) unless absolute. */
    command: string;
    args?: string[];
    /** Working directory for the child. Defaults to the supervisor's own cwd. */
    cwd?: string;
    /** Extra env merged UNDER the scrub: it is applied first and the scrub runs
     *  after it, so a manifest cannot revive a key we deliberately strip. Same
     *  order (and same reason) as the pm2 path it replaces — a service needing
     *  its own data root must resolve it internally, not via CLAUDE_CONFIG_DIR /
     *  CODEX_HOME. Anything outside the scrubbed families passes through. */
    env?: Record<string, string>;
    /** Hash of the definition this member is being started from; persisted into
     *  fleet-state so a later reconcile can detect "running from a stale config"
     *  and restart it. See FleetProcState.configHash. */
    configHash?: string;
  };
}

export interface FleetSupervisorOptions {
  statePath: string;
  distDir: string;
  /** Base env every daemon child inherits (already scrubbed by the caller). */
  daemonEnv: NodeJS.ProcessEnv;
  cwd: string;
  policy?: RestartPolicy;
  /** ms to wait after SIGTERM before SIGKILL on stop (pm2 kill_timeout). */
  killTimeoutMs?: number;
  /** Node interpreter args (heap/diag) — Node path only; ignored in standalone. */
  daemonNodeArgs?: string[];
  /** Directory for per-bot daemon logs (daemon-<index>-out/err.log). When set,
   *  each child's stdout/stderr is redirected there so `botmux logs --bot <i>`
   *  can tail a specific bot — mirrors pm2's out_file/error_file. When unset
   *  (tests), children inherit the supervisor's stdio. */
  logDir?: string;
  /** Injected for tests; defaults to console. */
  log?: (msg: string) => void;
  /** Test seams for the retryable pre-spawn isolation admission. */
  startupAdmissionLockWaitMs?: number;
  startupAdmissionRetryMs?: number;
  startupAdmissionHomeDir?: string;
  /** Injected only by spawn-failure tests. */
  spawnProcess?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
}

/** True if a pid is alive (kill -0). pid<=1 is never a real supervised child. */
export function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function sameStartupGeneration(left: FleetBotSpec, right: FleetBotSpec): boolean {
  return left.name === right.name
    && left.appId === right.appId
    && left.botIndex === right.botIndex
    && left.botsConfigPath === right.botsConfigPath
    && left.rosterRevision === right.rosterRevision
    && (left.entry ?? 'daemon') === (right.entry ?? 'daemon');
}

function sameStartupTarget(left: FleetBotSpec, right: FleetBotSpec): boolean {
  return left.name === right.name
    && left.appId === right.appId
    && left.botIndex === right.botIndex
    && left.botsConfigPath === right.botsConfigPath
    && (left.entry ?? 'daemon') === (right.entry ?? 'daemon');
}

interface StartupAdmissionRetry {
  timer: ReturnType<typeof setTimeout>;
  spec: FleetBotSpec;
  isRestart: boolean;
  allowRosterRevisionAdvance: boolean;
  ownedGeneration?: number;
}

export class FleetSupervisor {
  private readonly children = new Map<string, ChildProcess>();
  /** External callers await this exec-boundary acknowledgement so a failed
   * plugin spawn is not reported as a successful service start. */
  private readonly spawnReady = new WeakMap<ChildProcess, Promise<void>>();
  /** Per-name generation the live child was spawned with — guards stale exits. */
  private readonly liveGeneration = new Map<string, number>();
  private readonly restartTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly startupAdmissionTimers = new Map<string, StartupAdmissionRetry>();
  /** Names an operator explicitly stopped (stop-bot). Their SIGTERM would look
   *  like a crash to onChildExit, so we suppress the restart for exactly one exit
   *  and mark them stopped. Cleared when the bot is explicitly started again. */
  private readonly explicitStop = new Set<string>();
  /** Bot specs pinned by the last start() reconcile. Queue admission resolves
   *  names here, then explicitly re-reads the authoritative roster when a
   *  revision transition is permitted. */
  private readonly knownSpecs = new Map<string, FleetBotSpec>();
  private stopping = false;
  private readonly policy: RestartPolicy;
  private readonly killTimeoutMs: number;
  private readonly startupAdmissionLockWaitMs: number;
  private readonly startupAdmissionRetryMs: number;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: FleetSupervisorOptions) {
    this.policy = opts.policy ?? DEFAULT_RESTART_POLICY;
    this.killTimeoutMs = opts.killTimeoutMs ?? 8000;
    this.startupAdmissionLockWaitMs = opts.startupAdmissionLockWaitMs ?? 5_000;
    this.startupAdmissionRetryMs = opts.startupAdmissionRetryMs ?? 250;
    this.log = opts.log ?? ((m) => console.error(`[fleet-supervisor] ${m}`));
  }

  /** Start (or reconcile) the fleet: spawn every configured bot not already
   *  alive. Idempotent — an already-live child (per state + kill -0) is left be.
   *  This is both the initial start and the resurrect path. */
  start(bots: readonly FleetBotSpec[]): void {
    const specByName = new Map(bots.map((b) => [b.name, b]));
    for (const [name, pending] of this.startupAdmissionTimers) {
      if (specByName.has(name)) continue;
      clearTimeout(pending.timer);
      this.startupAdmissionTimers.delete(name);
    }
    // Remember the spec set so queued start-bot/stop-bot can resolve name→spec.
    this.knownSpecs.clear();
    for (const b of bots) this.knownSpecs.set(b.name, b);
    // A full fleet start clears any explicit-stop marks — `botmux start` means
    // "bring everything up", overriding a prior single-bot stop.
    this.explicitStop.clear();
    // Record our supervisor identity + reconcile the persisted proc set against
    // reality before deciding what to (re)spawn.
    //
    // OWNERSHIP SAFETY: a proc that is 'online' with a live pid but which THIS
    // supervisor process did not spawn (not in `this.children`) is an orphan from
    // a previous supervisor generation that died hard (SIGKILL/OOM/panic) while
    // its daemon children kept running. If we left it 'online', planStart would
    // skip it and — when every member is such an orphan — we would spawn NOTHING,
    // hold no child handles or timers, and the event loop would drain: the new
    // supervisor exits immediately, leaving the whole fleet (bot daemons AND the
    // dashboard) running unsupervised, with `botmux start/restart` unable to bring
    // it back. A supervisor must OWN every live member, so we kill these orphans
    // here and let planStart respawn them under our ownership.
    //
    // The `!this.children.has` ownership check is the whole criterion — no pid /
    // generation comparison. On the SAME supervisor re-reconciling (idempotent
    // re-start), every child it spawned IS in `this.children`, so this loop and
    // the reconcile branch below are both natural no-ops; only genuinely unowned
    // live procs are reclaimed. (Relying on pid-inequality would miss the corner
    // where the OS recycles the dead supervisor's pid onto the new one.)
    const unowned = (p: FleetProcState): boolean =>
      specByName.has(p.name) && p.status === 'online' && pidAlive(p.pid) && !this.children.has(p.name);
    for (const p of readFleetState(this.opts.statePath)?.procs ?? []) {
      if (unowned(p)) {
        try { process.kill(p.pid, 'SIGTERM'); } catch { /* already gone */ }
        this.log(`reclaiming unowned live ${p.name} (pid ${p.pid}) from a prior supervisor — SIGTERM + respawn`);
      }
    }
    mutateFleetState(this.opts.statePath, (cur) => {
      // Refresh the start time whenever a NEW supervisor takes over (pid differs
      // from the one on record); a plain `||` would pin it to the first-ever
      // start forever, so status/uptime would misreport across restarts. Keep it
      // only when the SAME supervisor re-reconciles (idempotent re-start).
      const recordedPid = cur.supervisorPid;
      if (recordedPid !== process.pid || !cur.supervisorStartedAt) {
        cur.supervisorStartedAt = new Date().toISOString();
      }
      cur.supervisorPid = process.pid;
      // Drop procs no longer configured; mark not-online any proc we don't own a
      // live handle to (dead pid, OR alive-but-unowned orphan we just SIGTERM'd)
      // so planStart respawns it under our ownership — an orphan we hold no handle
      // to is not a member we supervise.
      cur.procs = cur.procs.filter((p) => specByName.has(p.name));
      for (const p of cur.procs) {
        if (p.status === 'online' && (!pidAlive(p.pid) || !this.children.has(p.name))) { p.pid = 0; p.status = 'stopped'; }
      }
      return cur;
    });

    const current = readFleetState(this.opts.statePath)?.procs ?? [];
    const toStart = planStart([...specByName.keys()], current, (p) => p.status === 'online' && pidAlive(p.pid));
    for (const name of toStart) {
      const spec = specByName.get(name);
      if (spec) this.spawnBot(spec, /* isRestart */ false);
    }
  }

  /** Start (or reconcile) ONE bot without touching the rest — the live side of
   *  `botmux start-bot`. Idempotent: a no-op if that bot is already online+alive.
   *  Registers the spec so a later exit is handled with the right identity, and
   *  clears any explicit-stop mark (an explicit start overrides a prior stop). */
  startOneBot(spec: FleetBotSpec, allowRosterRevisionAdvance = false): void {
    if (this.stopping) return;
    const prior = this.knownSpecs.get(spec.name);
    let currentSpec = spec;
    try {
      if (!spec.external && (spec.entry ?? 'daemon') === 'daemon') {
        if ((!spec.botsConfigPath || !spec.rosterRevision)
            && (prior?.botsConfigPath || prior?.rosterRevision)) {
          throw new Error('queued start-bot command lacks its authoritative roster generation');
        }
        // The queued command authenticates the stable path/index/App tuple. A
        // same-target config update after enqueue is legitimate; start from the
        // freshly-read full revision, never the cached generation.
        currentSpec = this.resolveCurrentDaemonSpec(spec, allowRosterRevisionAdvance);
      }
    } catch (error) {
      this.failStartupAdmission(spec, error);
      return;
    }
    this.knownSpecs.set(currentSpec.name, currentSpec);
    this.explicitStop.delete(spec.name);
    // Cancel any pending crash-restart timer FIRST (mirrors stopOneBot). A bot
    // that just crashed is mid-backoff: status 'launching', pid 0, not in
    // `children`, with a restart timer scheduled to respawn it. Without this
    // cancel, the guard below (which needs online+alive+children) does not match,
    // so we spawn a fresh child here — and then the stale timer ALSO fires and
    // spawns a SECOND one. The first becomes an orphan the supervisor no longer
    // tracks (not in `children`/state, its exit ignored by the generation guard),
    // never reaped by stopAll/stop-bot: two daemons for one bot. Cancelling the
    // timer makes this the single, owned (re)spawn.
    const pendingRestart = this.restartTimers.get(spec.name);
    if (pendingRestart) { clearTimeout(pendingRestart); this.restartTimers.delete(spec.name); }
    const pendingAdmission = this.startupAdmissionTimers.get(spec.name);
    if (pendingAdmission && !sameStartupGeneration(pendingAdmission.spec, currentSpec)) {
      clearTimeout(pendingAdmission.timer);
      this.startupAdmissionTimers.delete(spec.name);
    }
    const proc = readFleetState(this.opts.statePath)?.procs.find((p) => p.name === currentSpec.name);
    if (proc && proc.status === 'online' && pidAlive(proc.pid) && this.children.has(currentSpec.name)) {
      this.log(`start-bot ${currentSpec.name}: already online (pid ${proc.pid})`);
      return;
    }
    this.spawnBot(
      currentSpec,
      /* isRestart */ false,
      undefined,
      allowRosterRevisionAdvance,
    );
  }

  /** Replace an external definition only after its prior child has stopped. */
  async upsertExternal(spec: FleetBotSpec): Promise<void> {
    if (!spec.external) throw new Error('fleet: external spec required');
    const known = this.knownSpecs.get(spec.name);
    if (known && JSON.stringify(known.external) !== JSON.stringify(spec.external)) {
      await this.stopOneBot(spec.name);
    }
    this.startOneBot(spec);
    const child = this.children.get(spec.name);
    if (!child) throw new Error(`fleet: failed to start ${spec.name}`);
    await this.spawnReady.get(child);
  }

  async removeExternal(name: string): Promise<void> {
    const spec = this.knownSpecs.get(name);
    if (spec && !spec.external) throw new Error(`fleet: not an external member: ${name}`);
    await this.stopOneBot(name);
    this.knownSpecs.delete(name);
    this.liveGeneration.delete(name);
    mutateFleetState(this.opts.statePath, current => {
      current.procs = current.procs.filter(proc => proc.name !== name);
      return current;
    });
  }

  /** Stop ONE bot without touching the rest — the live side of `botmux stop-bot`.
   *  Cancels a pending restart, marks it explicit-stop so the ensuing SIGTERM exit
   *  is not treated as a crash, then SIGTERM→(kill_timeout)→SIGKILL. Resolves when
   *  the child is gone. A no-op (marks stopped in state) if nothing is live. */
  async stopOneBot(name: string): Promise<void> {
    const timer = this.restartTimers.get(name);
    if (timer) { clearTimeout(timer); this.restartTimers.delete(name); }
    const pendingAdmission = this.startupAdmissionTimers.get(name);
    if (pendingAdmission) {
      clearTimeout(pendingAdmission.timer);
      this.startupAdmissionTimers.delete(name);
    }
    const child = this.children.get(name);
    if (!child) {
      // Nothing live to signal (already down, or mid-backoff we just cancelled).
      // Reflect stopped in state so status is truthful and no restart is pending.
      this.explicitStop.delete(name);
      mutateFleetState(this.opts.statePath, (cur) => {
        const p = cur.procs.find((x) => x.name === name);
        if (p && p.status !== 'errored') { p.status = 'stopped'; p.pid = 0; }
        return cur;
      });
      this.log(`stop-bot ${name}: not running (marked stopped)`);
      return;
    }
    this.explicitStop.add(name); // onChildExit will suppress the restart + mark stopped
    await this.stopOne(name, child);
  }

  /** Drain + execute queued single-bot commands (SIGHUP handler). */
  async drainCommands(commands: readonly FleetCommand[]): Promise<void> {
    for (const cmd of commands) {
      // PREFER THE KNOWN SPEC over the command payload. A daemon command carries
      // its config path and roster revision for admission, but it cannot describe
      // an EXTERNAL member, whose command/args/cwd/env live in the spec.
      // Rebuilding from the payload alone would spawn a plugin service as if it
      // were a bot daemon (resolveEntrySpawn + no scrub). start() records every
      // member in knownSpecs, so use that and fall back to the payload only for
      // a name we have never seen.
      const known = this.knownSpecs.get(cmd.name);
      const queuedSpec: FleetBotSpec = {
          name: cmd.name, appId: cmd.appId, botIndex: cmd.botIndex,
          ...(cmd.botsConfigPath ? { botsConfigPath: cmd.botsConfigPath } : {}),
          ...(cmd.rosterRevision ? { rosterRevision: cmd.rosterRevision } : {}),
        };
      if (cmd.op === 'start-bot') {
        if (known?.external) {
          if (known.appId !== cmd.appId || known.botIndex !== cmd.botIndex) {
            this.failStartupAdmission(queuedSpec, new Error(`queued member tuple changed for ${cmd.name}`));
            continue;
          }
          this.startOneBot(known);
          continue;
        }

        const authoritative = !!(
          known?.botsConfigPath || known?.rosterRevision
          || cmd.botsConfigPath || cmd.rosterRevision
        );
        if (authoritative) {
          // The queue is an admission credential, not a replacement spec. It
          // must exactly match the generation this supervisor already pinned.
          // Once authenticated, startOneBot re-reads that same path and may
          // advance to a newer FULL revision when the stable tuple is unchanged.
          if (!known || !sameStartupGeneration(known, queuedSpec)) {
            this.failStartupAdmission(queuedSpec, new Error(`queued roster identity changed for ${cmd.name}`));
            continue;
          }
          this.startOneBot(queuedSpec, true);
          continue;
        }
        this.startOneBot(known ?? queuedSpec);
      } else {
        await this.stopOneBot(cmd.name);
      }
    }
  }

  private spawnBot(
    spec: FleetBotSpec,
    isRestart: boolean,
    ownedGeneration?: number,
    allowRosterRevisionAdvance = isRestart,
  ): void {
    if (this.stopping) return;
    const queuedAdmission = this.startupAdmissionTimers.get(spec.name);
    if (queuedAdmission) {
      if (sameStartupGeneration(queuedAdmission.spec, spec)
          && queuedAdmission.isRestart === isRestart) return;
      clearTimeout(queuedAdmission.timer);
      this.startupAdmissionTimers.delete(spec.name);
    }
    const entry = spec.entry ?? 'daemon';
    // An external member (a plugin service) runs an arbitrary command instead of
    // one of our entry modules. Everything BELOW this point — logs, state,
    // restart budget, graceful stop — is shared verbatim; only the command and
    // the env differ, which is the whole reason this is a spec variant rather
    // than a second spawn path.
    const { command, args } = spec.external
      ? { command: spec.external.command, args: spec.external.args ?? [] }
      : resolveEntrySpawn(entry, this.opts.distDir);
    // node_args (heap/diag) apply only to the Node path; a compiled binary has
    // no separate interpreter args. resolveEntrySpawn already picks the shape;
    // we prepend node_args only when the command is a node/JS invocation.
    // An external command is neither: its argv is the plugin's own, so our
    // interpreter flags would be nonsense (or worse, consumed as its args).
    const isStandalone = args.length > 0 && args[0].startsWith('__');
    const nodeArgs = (spec.external || isStandalone) ? [] : (this.opts.daemonNodeArgs ?? []);
    // Per-member log files (mirrors pm2 out_file/error_file → `botmux logs`).
    // Bot daemons write daemon-<index>-{out,err}.log; the dashboard writes
    // dashboard-{out,err}.log (spec.logBaseName). Opened in append mode so a
    // restart keeps history; fds are closed when the child exits (see
    // onChildExit). When no logDir is configured (tests), the child inherits
    // our stdio.
    const spawnChild = (): ChildProcess => {
      const logBase = spec.logBaseName ?? `daemon-${spec.botIndex}`;
      let stdio: Array<'ignore' | 'inherit' | number> = ['ignore', 'inherit', 'inherit'];
      let outFd: number | undefined;
      let errFd: number | undefined;
      if (this.opts.logDir) {
        try {
          mkdirSync(this.opts.logDir, { recursive: true });
          outFd = openSync(join(this.opts.logDir, `${logBase}-out.log`), 'a');
          errFd = openSync(join(this.opts.logDir, `${logBase}-err.log`), 'a');
          stdio = ['ignore', outFd, errFd];
        } catch (err) {
          this.log(`${spec.name} log file open failed, inheriting stdio: ${err instanceof Error ? err.message : err}`);
          if (outFd !== undefined) { try { closeSync(outFd); } catch { /* */ } outFd = undefined; }
          if (errFd !== undefined) { try { closeSync(errFd); } catch { /* */ } errFd = undefined; }
        }
      }
      try {
        const spawnArgs = [...nodeArgs, ...args];
        const spawnOptions: SpawnOptions = {
          cwd: spec.external?.cwd ?? this.opts.cwd, stdio, env: childEnv, windowsHide: true,
        };
        return this.opts.spawnProcess
          ? this.opts.spawnProcess(command, spawnArgs, spawnOptions)
          : spawn(command, spawnArgs, spawnOptions);
      } finally {
        // Open only after admission and close on every success/failure path.
        if (outFd !== undefined) { try { closeSync(outFd); } catch { /* */ } }
        if (errFd !== undefined) { try { closeSync(errFd); } catch { /* */ } }
      }
    };
    // Bot daemons need their 0-based index (BOTMUX_BOT_INDEX); the dashboard is
    // app-agnostic and takes only the shared base env (it loads its own
    // ~/.botmux/.env H5 family in index-dashboard.ts). Injecting a bot index
    // into the dashboard would be meaningless and misleading, so gate it on the
    // 'daemon' entry.
    //
    // An EXTERNAL member takes neither: it is not a bot (no index) and it is not
    // our code, so it gets the base env with the session-scoped families removed.
    // See scrubExternalMemberEnv for why our own members do not need this (they
    // scrub in their own boot) and why an external command does.
    //
    // ORDER IS LOAD-BEARING: the spec's own `env` is merged BEFORE the scrub, so
    // the scrub has the last word and a plugin manifest cannot revive a key we
    // deliberately strip. This is the order the pm2 path used and stated outright
    // ("applies it AFTER the manifest env merge, so a plugin manifest cannot
    // revive a scrubbed key" — plugins/pm2.ts), with a test pinning it. Merging
    // after the scrub would silently undo it for exactly the keys that matter
    // (a sibling's CLI home, the dashboard app secret, the graceful sentinel).
    // A service needing its own data root must resolve it internally.
    let childEnv: NodeJS.ProcessEnv;
    if (spec.external) {
      childEnv = { ...this.opts.daemonEnv, ...(spec.external.env ?? {}) };
      scrubExternalMemberEnv(childEnv);
    } else if (entry === 'daemon') {
      childEnv = {
        ...this.opts.daemonEnv,
        BOTMUX_BOT_INDEX: String(spec.botIndex),
        ...(spec.botsConfigPath ? { BOTS_CONFIG: spec.botsConfigPath } : {}),
        ...(spec.rosterRevision ? {
          BOTMUX_EXPECTED_APP_ID: spec.appId,
          BOTMUX_ROSTER_REVISION: spec.rosterRevision,
        } : {}),
      };
    } else {
      childEnv = { ...this.opts.daemonEnv };
    }
    let child: ChildProcess | undefined;
    let provisionalErrorListener: ((error: Error) => void) | undefined;
    let managedErrorHandler: ((error: Error) => void) | undefined;
    let provisionalTerminalized = false;
    let reservationCleanup = (): void => {};
    const attachProvisionalErrorGuard = (spawned: ChildProcess, cleanup?: () => void): void => {
      let cleaned = false;
      reservationCleanup = () => {
        if (cleaned) return;
        cleaned = true;
        cleanup?.();
      };
      provisionalErrorListener = (error: Error) => {
        if (managedErrorHandler) {
          managedErrorHandler(error);
          return;
        }
        reservationCleanup();
        if (provisionalTerminalized) return;
        provisionalTerminalized = true;
        this.log(`${spec.name} spawn error: ${error.message}`);
        this.failStartupAdmission(spec, error, ownedGeneration);
      };
      // spawn(2) failures such as ENOENT/EACCES/EAGAIN are reported
      // asynchronously on this object, often with pid still undefined. Install
      // the guard before inspecting pid or binding the startup reservation.
      spawned.once('error', provisionalErrorListener);
    };
    const terminalizeProvisionalSpawn = (spawned: ChildProcess, error: Error): void => {
      try { spawned.kill('SIGKILL'); } catch { /* a pidless spawn is already terminal */ }
      reservationCleanup();
      if (provisionalTerminalized) return;
      provisionalTerminalized = true;
      this.failStartupAdmission(spec, error, ownedGeneration);
    };
    if (entry === 'daemon' && spec.rosterRevision && spec.appId) {
      try {
        child = withDeviceCredentialIsolationActivationLockSync(() => {
          const current = this.knownSpecs.get(spec.name);
          const roster = readDeviceIsolationRosterSnapshot({ configPath: spec.botsConfigPath });
          if (
            !current
            || !sameStartupGeneration(current, spec)
            || roster.revision !== spec.rosterRevision
            || !roster.members.some(member =>
              member.index === spec.botIndex && member.larkAppId === spec.appId)
          ) {
            throw new Error(`startup admission refused stale roster generation for ${spec.name}`);
          }
          const reservation = reserveDeviceIsolationDaemonStartup({
            homeDir: this.opts.startupAdmissionHomeDir,
            larkAppId: spec.appId,
            rosterRevision: spec.rosterRevision!,
          });
          childEnv.BOTMUX_STARTUP_RESERVATION_ID = reservation.intentId;
          childEnv.BOTMUX_STARTUP_RESERVATION_TOKEN = reservation.reservationToken;
          let spawned: ChildProcess | undefined;
          try {
            spawned = spawnChild();
            const clearReservation = () => {
              clearDeviceIsolationStartupIntent({
                homeDir: this.opts.startupAdmissionHomeDir,
                intentId: reservation.intentId,
                reservationToken: reservation.reservationToken,
              });
            };
            attachProvisionalErrorGuard(spawned, clearReservation);
            if (!spawned.pid) {
              terminalizeProvisionalSpawn(spawned, new Error(`spawn returned no pid for ${spec.name}`));
              return undefined;
            }
            if (!bindDeviceIsolationStartupReservationToChild({
              homeDir: this.opts.startupAdmissionHomeDir,
              intentId: reservation.intentId,
              reservationToken: reservation.reservationToken,
              childPid: spawned.pid,
            })) {
              terminalizeProvisionalSpawn(spawned, new Error(`cannot bind startup reservation for ${spec.name}`));
              return undefined;
            }
            return spawned;
          } catch (error) {
            if (spawned) {
              terminalizeProvisionalSpawn(
                spawned,
                error instanceof Error ? error : new Error(String(error)),
              );
              return undefined;
            }
            clearDeviceIsolationStartupIntent({
              homeDir: this.opts.startupAdmissionHomeDir,
              intentId: reservation.intentId,
              reservationToken: reservation.reservationToken,
            });
            throw error;
          }
        }, {
          homeDir: this.opts.startupAdmissionHomeDir,
          lock: { maxWaitMs: this.startupAdmissionLockWaitMs },
        });
      } catch (error) {
        if (error instanceof FileLockTimeoutError) {
          this.scheduleStartupAdmissionRetry(
            spec,
            isRestart,
            allowRosterRevisionAdvance,
            ownedGeneration,
          );
          return;
        }
        this.failStartupAdmission(spec, error, ownedGeneration);
        return;
      }
    } else {
      try {
        child = spawnChild();
        attachProvisionalErrorGuard(child);
        if (!child.pid) {
          terminalizeProvisionalSpawn(child, new Error(`spawn returned no pid for ${spec.name}`));
          child = undefined;
        }
      }
      catch (error) {
        this.failStartupAdmission(spec, error, ownedGeneration);
        return;
      }
    }
    if (!child) return;
    const ready = new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => { child.removeListener('error', onError); resolve(); };
      const onError = (error: Error): void => { child.removeListener('spawn', onSpawn); reject(error); };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });
    void ready.catch(() => {});
    this.spawnReady.set(child, ready);
    const now = new Date().toISOString();

    // Persist the new generation + pid atomically, bumping generation on restart.
    const generation = mutateFleetState(this.opts.statePath, (cur) => {
      const existing = cur.procs.find((p) => p.name === spec.name);
      if (existing) {
        existing.pid = child.pid ?? 0;
        existing.generation += 1;
        existing.status = 'online';
        existing.startedAt = now;
        existing.lastExitCode = null;
        // A crash-driven respawn (isRestart) must PRESERVE restarts — that's the
        // running tally the exit handler compares against maxRestarts. But a fresh
        // operator-initiated start (isRestart=false: `botmux start` reconcile or
        // start-bot) gives the bot a CLEAN restart budget; otherwise a proc that
        // crashlooped in a previous supervisor generation would carry its stale
        // count and be parked one crash later instead of getting a full budget.
        if (!isRestart) existing.restarts = 0;
        // Record which config this generation was actually started from, so the
        // caller can later tell "running, but from a stale definition" apart from
        // "running and current". Only external members have one.
        if (spec.external?.configHash !== undefined) existing.configHash = spec.external.configHash;
        else delete existing.configHash;
      } else {
        cur.procs.push({ ...freshProc(spec.name, spec.appId, child.pid ?? 0, now, spec.external?.configHash) });
      }
      return cur;
    }).procs.find((p) => p.name === spec.name)!.generation;

    this.children.set(spec.name, child);
    this.liveGeneration.set(spec.name, generation);
    this.log(`${isRestart ? 'restarted' : 'started'} ${spec.name} (pid ${child.pid}, gen ${generation})`);

    let childSettled = false;
    const onManagedExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (childSettled) return;
      childSettled = true;
      reservationCleanup();
      this.onChildExit(spec, generation, { code, signal });
    };
    const onManagedError = (error: Error): void => {
      if (childSettled) return;
      childSettled = true;
      reservationCleanup();
      this.log(`${spec.name} spawn error: ${error.message}`);
      this.onChildExit(spec, generation, { code: 1, signal: null });
    };
    managedErrorHandler = onManagedError;
    child.once('exit', onManagedExit);
    child.once('error', onManagedError);
    if (provisionalErrorListener) child.removeListener('error', provisionalErrorListener);
  }

  private resolveCurrentDaemonSpec(spec: FleetBotSpec, allowRevisionAdvance: boolean): FleetBotSpec {
    if (spec.external || (spec.entry ?? 'daemon') !== 'daemon') return spec;
    if (!spec.botsConfigPath && !spec.rosterRevision) return spec;
    if (!spec.botsConfigPath || !spec.rosterRevision) {
      throw new Error(`incomplete authoritative roster identity for ${spec.name}`);
    }
    const roster = readDeviceIsolationRosterSnapshot({ configPath: spec.botsConfigPath });
    const member = roster.members.find(candidate =>
      candidate.index === spec.botIndex && candidate.larkAppId === spec.appId);
    if (!member || botProcessName(member, member.index) !== spec.name) {
      throw new Error(`configured member tuple changed for ${spec.name}`);
    }
    if (!allowRevisionAdvance && roster.revision !== spec.rosterRevision) {
      throw new Error(`queued roster generation changed for ${spec.name}`);
    }
    return { ...spec, botsConfigPath: roster.requestedConfigPath, rosterRevision: roster.revision };
  }

  private failStartupAdmission(
    spec: FleetBotSpec,
    error: unknown,
    ownedGeneration?: number,
  ): void {
    if (ownedGeneration !== undefined && this.liveGeneration.get(spec.name) !== ownedGeneration) return;
    this.log(`startup admission failed for ${spec.name}: ${error instanceof Error ? error.message : error}`);
    // A rejected duplicate/forged start-bot command must not orphan the exact
    // live child we already own. It has no generation authority over that child.
    if (ownedGeneration === undefined && this.children.has(spec.name)) return;
    const restartTimer = this.restartTimers.get(spec.name);
    if (restartTimer) {
      clearTimeout(restartTimer);
      this.restartTimers.delete(spec.name);
    }
    const pendingAdmission = this.startupAdmissionTimers.get(spec.name);
    if (pendingAdmission
        && (ownedGeneration === undefined || pendingAdmission.ownedGeneration === ownedGeneration)) {
      clearTimeout(pendingAdmission.timer);
      this.startupAdmissionTimers.delete(spec.name);
    }
    mutateFleetState(this.opts.statePath, (state) => {
      const proc = state.procs.find(candidate => candidate.name === spec.name);
      if (ownedGeneration !== undefined) {
        if (!proc || proc.generation !== ownedGeneration || proc.appId !== spec.appId) return state;
      }
      if (proc) {
        proc.status = 'errored';
        proc.pid = 0;
      } else {
        state.procs.push({
          ...freshProc(spec.name, spec.appId, 0, new Date().toISOString()),
          status: 'errored',
        });
      }
      return state;
    });
    if (ownedGeneration === undefined || this.liveGeneration.get(spec.name) === ownedGeneration) {
      this.liveGeneration.delete(spec.name);
    }
  }

  private scheduleStartupAdmissionRetry(
    spec: FleetBotSpec,
    isRestart: boolean,
    allowRosterRevisionAdvance: boolean,
    ownedGeneration?: number,
  ): void {
    if (this.stopping) return;
    const current = this.knownSpecs.get(spec.name);
    if (!current || !sameStartupTarget(current, spec)) return;
    const existing = this.startupAdmissionTimers.get(spec.name);
    if (existing) return;
    this.log(
      `startup admission busy for ${spec.name}; retrying same roster generation `
      + `in ${this.startupAdmissionRetryMs}ms`,
    );
    const timer = setTimeout(() => {
      const pending = this.startupAdmissionTimers.get(spec.name);
      if (!pending || pending.timer !== timer) return;
      this.startupAdmissionTimers.delete(spec.name);
      const latest = this.knownSpecs.get(spec.name);
      if (
        this.stopping
        || !latest
        || !sameStartupTarget(latest, spec)
        || (ownedGeneration !== undefined && this.liveGeneration.get(spec.name) !== ownedGeneration)
      ) return;
      try {
        const currentSpec = this.resolveCurrentDaemonSpec(latest, allowRosterRevisionAdvance);
        this.knownSpecs.set(currentSpec.name, currentSpec);
        this.spawnBot(currentSpec, isRestart, ownedGeneration, allowRosterRevisionAdvance);
      } catch (error) {
        this.failStartupAdmission(spec, error, ownedGeneration);
      }
    }, this.startupAdmissionRetryMs);
    this.startupAdmissionTimers.set(spec.name, {
      timer, spec, isRestart, allowRosterRevisionAdvance, ownedGeneration,
    });
  }

  private onChildExit(spec: FleetBotSpec, generation: number, exit: ChildExit): void {
    // Generation guard: ignore an exit from a child we already replaced. A stale
    // exit must never mutate the newer generation's row or trigger a double spawn.
    if (this.liveGeneration.get(spec.name) !== generation) return;
    this.children.delete(spec.name);
    if (this.stopping) return;

    // Explicit stop-bot: this exit is operator-intended, not a crash. Suppress the
    // restart and mark it stopped, then clear the one-shot mark. (A SIGTERM exit
    // looks like a crash to decideOnExit, so this check must come first.)
    if (this.explicitStop.has(spec.name)) {
      this.explicitStop.delete(spec.name);
      this.log(`${spec.name} stopped by operator (stop-bot); not restarting`);
      this.markStopped(spec.name, exit, 'stopped'); // clears liveGeneration too
      return;
    }

    const current = readFleetState(this.opts.statePath)?.procs.find((p) => p.name === spec.name);
    // An external member does not get the 90-is-graceful sentinel: it is not our
    // code and may use 90 as an ordinary failure code, in which case honouring it
    // would silently retire the service instead of restarting it (see
    // isGracefulExit). Operator stops are already handled above via explicitStop,
    // which does not depend on the exit code at all.
    const decision = decideOnExit({ restarts: current?.restarts ?? 0 }, exit, this.policy, !spec.external);

    if (decision.action === 'stop') {
      this.log(`${spec.name} exited cleanly (graceful); not restarting`);
      this.markStopped(spec.name, exit, 'stopped');
      return;
    }
    if (decision.action === 'park') {
      this.log(`${spec.name} exceeded max_restarts (${decision.atRestarts}); parking errored`);
      this.markStopped(spec.name, exit, 'errored');
      return;
    }
    // restart: record the bump, then respawn after the backoff.
    mutateFleetState(this.opts.statePath, (cur) => {
      const p = cur.procs.find((x) => x.name === spec.name);
      if (p) { p.restarts = decision.nextRestarts; p.status = 'launching'; p.pid = 0; p.lastExitCode = exit.code; }
      return cur;
    });
    this.log(`${spec.name} crashed (code=${exit.code} signal=${exit.signal}); restart ${decision.nextRestarts}/${this.policy.maxRestarts} in ${this.policy.restartDelayMs}ms`);
    // The restart timer MUST keep the event loop alive: when the crashed child
    // was the supervisor's only live handle, an unref'd timer would let the loop
    // drain and the supervisor would exit mid-backoff — never respawning the bot
    // (observed under bun: single-bot fleet, child crashloops, supervisor dies
    // after scheduling the first restart). A ref'd timer holds the process until
    // the respawn fires. (stopOne's kill timer stays unref'd — it's a shutdown
    // safety net that must NOT keep the loop alive.)
    const timer = setTimeout(() => {
      if (this.restartTimers.get(spec.name) !== timer) return;
      this.restartTimers.delete(spec.name);
      if (this.stopping || this.liveGeneration.get(spec.name) !== generation) return;
      try {
        const known = this.knownSpecs.get(spec.name);
        if (!known || !sameStartupTarget(known, spec)) {
          throw new Error(`restart target changed for ${spec.name}`);
        }
        const currentSpec = this.resolveCurrentDaemonSpec(known, true);
        this.knownSpecs.set(currentSpec.name, currentSpec);
        this.spawnBot(currentSpec, true, generation);
      } catch (error) {
        this.failStartupAdmission(spec, error, generation);
      }
    }, this.policy.restartDelayMs);
    this.restartTimers.set(spec.name, timer);
  }

  private markStopped(name: string, exit: ChildExit, status: 'stopped' | 'errored'): void {
    mutateFleetState(this.opts.statePath, (cur) => {
      const p = cur.procs.find((x) => x.name === name);
      if (p) { p.status = status; p.pid = 0; p.lastExitCode = exit.code; }
      return cur;
    });
    this.liveGeneration.delete(name);
  }

  /** Graceful stop of the whole fleet: SIGTERM each child, then SIGKILL any that
   *  outlast kill_timeout. Cancels pending restart timers first so a mid-backoff
   *  crash can't respawn during shutdown. Resolves when all children are gone.
   *  Finalizes fleet-state (all procs stopped, supervisorPid cleared) so a later
   *  `status` reflects reality — onChildExit is short-circuited while stopping. */
  async stopAll(): Promise<void> {
    this.stopping = true;
    for (const t of this.restartTimers.values()) clearTimeout(t);
    this.restartTimers.clear();
    for (const pending of this.startupAdmissionTimers.values()) clearTimeout(pending.timer);
    this.startupAdmissionTimers.clear();
    const pending = [...this.children.entries()];
    await Promise.all(pending.map(([name, child]) => this.stopOne(name, child)));
    // Reflect the stop in the durable record. onChildExit ignored these exits
    // (stopping=true), so without this the state file would keep the now-dead
    // pids as 'online'. Clear supervisorPid too: this supervisor is exiting.
    mutateFleetState(this.opts.statePath, (cur) => {
      for (const p of cur.procs) {
        if (p.status === 'online' || p.status === 'launching') { p.status = 'stopped'; p.pid = 0; }
      }
      cur.supervisorPid = 0;
      return cur;
    });
  }

  private stopOne(name: string, child: ChildProcess): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(killTimer); resolve(); };
      const killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, this.killTimeoutMs);
      killTimer.unref?.();
      child.once('exit', finish);
      try { child.kill('SIGTERM'); } catch { finish(); }
    });
  }
}

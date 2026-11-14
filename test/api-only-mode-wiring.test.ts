import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as botRegistry from '../src/bot-registry.js';
import { LarkTransportDisabledError } from '../src/bot-registry.js';
import { shellWrapperScript } from '../src/adapters/backend/tmux-backend.js';
import {
  __testOnly_resetCoreOnlyReadiness,
  setIpcAuthSecret,
  setLarkAppId,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import { triggerSessionTurn } from '../src/core/trigger-session.js';
import * as workerPool from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';
import { readProcessStartIdentity } from '../src/core/session-marker.js';
import { downloadMessageResource } from '../src/im/lark/client.js';
import { __testOnly_driveApiCall } from '../src/im/lark/doc-comment.js';
import * as groupsStore from '../src/services/groups-store.js';
import type { TriggerRequest } from '../src/services/trigger-types.js';
import * as userToken from '../src/utils/user-token.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { spawnSyncTsScript } from './helpers/ts-runner.js';

/**
 * API-only (core-only / headless) bot mode and no-Feishu-transport sessions.
 *
 * Behavioural tests drive the real entry points (HTTP IPC routes, the trigger
 * path, Lark primitives, the CLI, the core-only entrypoint). The remaining
 * source-structure guards cover security wiring that lives inside the daemon /
 * worker closures with no injectable seam; each one says why it reads source.
 */

const read = (file: string) => readFileSync(resolve(file), 'utf8');

/** Drop whole-line `//` comments so a commented-out copy of the correct code
 *  cannot satisfy a guard while the live statement is broken. */
function stripLineComments(source: string): string {
  return source.split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
}

function region(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start, `${startMarker} not found`).toBeGreaterThan(-1);
  expect(end, `${endMarker} not found after ${startMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** Brace-balanced block opening at the first `{` at/after `marker`. */
function braceBlock(source: string, marker: string): string {
  const at = source.indexOf(marker);
  expect(at, `${marker} not found`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = source.indexOf('{', at); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(at, i + 1);
  }
  throw new Error(`unbalanced block after ${marker}`);
}

/** Top-level argument lists of every call to `callee` (definitions skipped). */
function callArgs(source: string, callee: string): string[][] {
  const calls: string[][] = [];
  for (const m of source.matchAll(new RegExp(`(?<![\\w.])${callee}\\(`, 'g'))) {
    if (/function\s+$/.test(source.slice(Math.max(0, m.index! - 16), m.index))) continue;
    const args: string[] = [];
    let depth = 0;
    let cur = '';
    for (let i = m.index! + callee.length; i < source.length; i++) {
      const ch = source[i];
      if ('([{'.includes(ch) && depth++ === 0) continue;
      if (')]}'.includes(ch) && --depth === 0) { args.push(cur.trim()); break; }
      if (ch === ',' && depth === 1) { args.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    calls.push(args.filter(a => a !== ''));
  }
  return calls;
}

const daemonSource = stripLineComments(read('src/daemon.ts'));
const workerSource = stripLineComments(read('src/worker.ts'));
const workerPoolSource = read('src/core/worker-pool.ts');
const clientSource = read('src/im/lark/client.ts');

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function apiOnlyBot(larkAppId = 'local_riff') {
  return {
    config: { larkAppId, larkAppSecret: 'secret-on-disk', apiOnly: true, cliId: 'codex-app', brand: 'feishu' },
    botName: 'Riff',
    botOpenId: `bot_${larkAppId}`,
    resolvedAllowedUsers: [],
  } as any;
}

describe('no-transport sessions on the daemon IPC surface', () => {
  let handle: IpcServerHandle | null = null;
  afterEach(async () => {
    if (handle) await handle.close();
    handle = null;
    __testOnly_resetCoreOnlyReadiness();
    setIpcAuthSecret(null);
    setLarkAppId('');
  });

  const CAP = 'cd34ab12'.repeat(8);
  function activeSession(chatId: string, larkAppId: string) {
    return {
      session: { sessionId: 's-nt', chatId, larkAppId, scope: 'chat', status: 'active', chatDisplayName: 'old' },
      managedTurnOrigin: { capability: CAP },
      larkAppId,
      chatId,
      chatType: 'group',
      scope: 'chat',
    } as any;
  }

  it('session-write and history routes refuse to touch Feishu for an apiOnly bot or an HTTP virtual chat', async () => {
    const renameChat = vi.spyOn(groupsStore, 'renameChat').mockResolvedValue({ ok: true, oldName: 'old', newName: 'new', changed: true } as any);
    vi.spyOn(botRegistry, 'getBot').mockImplementation((id: string) => (
      id === 'local_riff' ? apiOnlyBot() : { config: { larkAppId: id, larkAppSecret: 's' } } as any));
    const find = vi.spyOn(workerPool, 'findActiveBySessionId');
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${handle.port}/api/sessions/s-nt`;

    for (const [label, chatId, appId] of [
      ['HTTP virtual chat on a normal bot', 'http_async_nt', 'app_normal'],
      ['CLI headless chat on a normal bot', 'headless_hl_11111111-1111-4111-8111-111111111111', 'app_normal'],
      ['apiOnly bot in a real-looking chat', 'oc_real_nt', 'local_riff'],
    ] as const) {
      find.mockReturnValue(activeSession(chatId, appId));
      const rename = await fetch(`${base}/chat-rename`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'new', proactive: true, originCapability: CAP }),
      });
      expect(await rename.json(), label).toMatchObject({ ok: false, error: 'no_feishu_transport' });
      const project = await fetch(`${base}/project`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'init', title: 'must not persist', goal: 'must not send', originCapability: CAP }),
      });
      expect(project.status, label).toBe(409);
      expect(await project.json(), label).toMatchObject({ ok: false, error: 'no_feishu_transport' });
      const history = await fetch(`${base}/history`);
      expect(history.status, label).toBe(200);
      expect(await history.json(), label).toMatchObject({ ok: true, messages: [], hint: 'no_feishu_transport' });
    }
    expect(renameChat).not.toHaveBeenCalled();
  });

  it('getBotClient is the authoritative bot-level gate (reads AND writes)', () => {
    // The true single chokepoint: EVERY Feishu call resolves its client here, so
    // gating getBotClient covers client.ts primitives, doc-comment drive API,
    // open-platform rename/avatar, identity cache — reads included (apiOnly =
    // zero Feishu network, not merely "no writes").
    const registrySource = readFileSync(resolve('src/bot-registry.ts'), 'utf8');
    const block = region(registrySource, 'export function getBotClient(', 'return bot.client;');
    expect(block).toContain('bot.config.apiOnly === true');
    expect(block).toContain('throw new LarkTransportDisabledError(larkAppId');
    // The error class is defined in bot-registry (no import cycle) and re-exported.
    expect(registrySource).toContain('export class LarkTransportDisabledError');
    expect(clientSource).toContain('export { LarkTransportDisabledError }');
  });

  it('downloadMessageResource gates BEFORE the app→user-token fallback', () => {
    // getBotClient throws for apiOnly; without an early gate the app-token attempt
    // is caught and silently falls back to a raw user-token fetch (codex round-5).
    const clientSource = readFileSync(resolve('src/im/lark/client.ts'), 'utf8');
    const block = region(clientSource, 'export async function downloadMessageResource(', 'Try App Token first');
    expect(block).toContain("assertLarkTransport(larkAppId, 'downloadMessageResource')");
  });

  it('worker-pool suppresses ALL aux UI for no-transport sessions in managedAuxUiSuppressed', () => {
    // Plan B merge (2026-08): master had refactored this into a shared
    // auxUiSuppressedFor() that managedAuxUiSuppressed delegated to — but that
    // shared helper gates on the pre-Plan-B `vcMeetingReceiver` blanket, which
    // would re-suppress a plain user turn on a meeting-agent chat session (the
    // "手动@不回复" regression). So the merge KEEPS managedAuxUiSuppressed inline
    // with the no-transport gate + isMeetingDrivenTurn. Lock the no-transport
    // gate in its live home (the closure), not the delegation.
    const closure = region(workerPoolSource, 'const managedAuxUiSuppressed =', 'const managedFinalOutputSuppressed');
    expect(closure).toContain('larkTransportEnabled({ chatId: ds.chatId, apiOnly: getBot(ds.larkAppId).config.apiOnly })');
    expect(closure).toContain('return true;');
    // auxUiSuppressedFor still exists for the mojo quarantine caller and keeps its
    // own no-transport gate (fail-closed behaviour covered behaviourally in
    // test/mojo-quarantine-notice-policy.test.ts).
    const shared = region(workerPoolSource, 'export function auxUiSuppressedFor(', 'isSilentScheduledTurn');
    expect(shared).toContain('larkTransportEnabled({');
    expect(shared).toContain('apiOnly: getBot(ds.larkAppId).config.apiOnly,');
  });

  it('managedAuxUiSuppressed no longer special-cases a VC meeting agent (Plan B: ordinary chat session)', () => {
    // Plan B: a VC meeting agent is an ordinary chat-scope session, so its
    // streaming card / reactions flow through the ordinary suppression path just
    // like any group session. The old `vcMeetingReceiver` branch (and the
    // exposeReceiverStreamingCard opt-in it delegated to) is gone; the final
    // group-posting policy (silent vs listener_thread) is enforced separately in
    // managedFinalOutputSuppressed, not here.
    const block = region(workerPoolSource, 'const managedAuxUiSuppressed =', 'const goalCardEnabled =');
    expect(block).not.toContain('vcMeetingReceiver');
    expect(block).not.toContain('vcReceiverStreamingCardSuppressed');
    expect(block).toContain('return ordinaryManagedSuppression(turnId, dispatchAttempt);');
  });

  it('managedFinalOutputSuppressed gates the VC durable policy to meeting-driven turns only (plain user turns post normally)', () => {
    // Plan B: the meeting agent hosts BOTH transcript deliveries and plain user
    // IM turns. The durable silent/listener_thread policy must apply only to a
    // meeting-driven turn — a durable delivery (dispatchAttempt) or a stamped
    // meeting @mention follow-up (isMeetingDrivenTurn). A plain user turn has
    // neither and must fall to ordinaryManagedSuppression so the user's own reply
    // is never wrongly suppressed.
    const block = region(workerPoolSource, 'const managedFinalOutputSuppressed', 'const bot = getBot(ds.larkAppId);');
    expect(block).toContain('if (!isMeetingDrivenTurn(ds, turnId, dispatchAttempt)) {');
    expect(block).toContain('return ordinaryManagedSuppression(turnId, dispatchAttempt);');
    // The durable send-policy check still runs for meeting-driven turns.
    expect(block).toContain('evaluateVcMeetingManagedSend(config.session.dataDir, {');
  });

  it('isMeetingDrivenTurn distinguishes transcript deliveries / stamped follow-ups from plain user turns', () => {
    // The shared module-level gate both managedAuxUiSuppressed /
    // managedFinalOutputSuppressed (setupWorkerHandlers) and deliverFinalOutput
    // consult. A non-meeting session is never meeting-driven; a delivery carries a
    // dispatchAttempt; an @mention follow-up is recognised by its stamped origin.
    const block = region(workerPoolSource, 'function isMeetingDrivenTurn(', 'function setupWorkerHandlers(');
    expect(block).toContain('if (!ds.session.vcMeetingReceiver) return false;');
    expect(block).toContain('if (dispatchAttempt !== undefined) return true;');
    expect(block).toContain('return resolveVcMeetingImTurnOrigin(ds.session, turnId) !== undefined;');
  });

  it('VC delivery dispatch arms the streaming-card turn (beginNewTurn) for every meeting-agent delivery', () => {
    // triggerSessionTurn (the VC transcript-delivery route) never calls
    // beginNewTurn, so the card lifecycle must be armed here — for every delivery
    // turn now that the meeting agent is an ordinary session whose card should
    // surface (no exposeReceiverStreamingCard opt-in gate anymore).
    const block = region(daemonSource, 'dispatchTurn: (request, context) => {', 'return triggerSessionTurn(');
    expect(block).not.toContain('exposeReceiverStreamingCard');
    expect(block).toContain('beginNewTurn(target, title, context.stableTurnId)');
    expect(block).toContain('target?.session.vcMeetingReceiver && context.stableTurnId');
  });

  it('Plan B keeps in-meeting output: action-request still recognises the meeting agent via the retained marker', () => {
    // The whole in-meeting text/voice output chain (request-output → action-request
    // → managed-action) authorizes against the RETAINED vcMeetingReceiver marker +
    // managedTurnOrigin/vcMeetingImTurnOrigin, all keyed by sessionId — never by the
    // activeSessions map key that Stage 1 changed. This is why in-meeting output
    // survives the normal-session refactor with no code change. Pin the entry guard
    // so a future marker cleanup can't silently kill 会中发言.
    const block = region(daemonSource, "ipcRoute('POST', '/api/vc-meetings/action-request'", 'const claimedAttempt =');
    expect(block).toContain('findActiveBySessionId(receiverSessionId)');
    expect(block).toContain('if (!ds?.session.vcMeetingReceiver) {');
    expect(block).toContain("errorCode: 'not_receiver_session'");
  });

  it('Plan B idle-gap: request-output falls back to the durable receipt when the live managedTurnOrigin was cleared', () => {
    // A meeting agent reaches idle between the delivery turn (which armed
    // ds.managedTurnOrigin) and the moment it runs request-output — the origin is
    // cleared at the delivery turn's terminal edge, so the live-origin gate fails.
    // The handler must fall back to re-deriving authority from the DURABLE delivery
    // receipt (evaluateVcMeetingManagedSend) for a claimed delivery origin, which
    // never authorizes anything the receipt itself wouldn't (attempt match +
    // dispatched/completed status + active projection). It uses forInMeetingOutput
    // so a silent responseMode (which only gates listener auto-post) does NOT block
    // in-meeting speech — the hub still applies capability + text/voiceOutputPolicy.
    const block = region(daemonSource, 'let effectiveVerified = verified;', 'if (!effectiveVerified.ok) return jsonRes');
    // The fallback runs whenever live verification failed — including while a
    // delivery turn is still executing. Live verification proves origin via the
    // rotating worker capability only, and non-sandboxed sessions have no
    // origin-channel transport for it, so gating the fallback on "live origin
    // cleared" (the old `!ds.managedTurnOrigin` guard) hard-bricked in-turn
    // speech from non-sandboxed meeting agents (idle-gap gate #5).
    expect(block).not.toContain('!ds.managedTurnOrigin');
    expect(block).toContain('claimedAttempt !== undefined');
    expect(block).toContain('evaluateVcMeetingManagedSend(config.session.dataDir, {');
    expect(block).toContain('allowTerminalReceipt: true');
    // In-meeting output channel is silent-independent (decoupled from responseMode).
    expect(block).toContain('forInMeetingOutput: true');
    // Only a listener_thread durable decision synthesizes the verified origin.
    expect(block).toContain("durable.ok && durable.kind === 'listener_thread'");
    expect(block).toContain('dispatchAttempt: claimedAttempt');
  });

  it('scheduleCardPatch is a defense-in-depth no-op for no-transport sessions', () => {
    const block = region(workerPoolSource, 'export function scheduleCardPatch(', 'if (streamingCardDisabled(ds, turnId)) return false;');
    expect(block).toContain('larkTransportEnabled({ chatId: ds.chatId, apiOnly: getBot(ds.larkAppId).config.apiOnly })');
  });

  it('every Feishu-touching CLI command consults the central session-transport gate', () => {
    const cliSource = readFileSync(resolve('src/cli.ts'), 'utf8');
    // The central gate is defined once and keys on apiOnly bot OR virtual chatId.
    const helper = region(cliSource, 'function currentTurnHasNoTransport(', 'function assertTurnTransportOrExit(');
    expect(helper).toContain('isHttpVirtualSession(chatId)');
    expect(helper).toContain('currentBotIsApiOnly(appId)');
    // Region-scoped per command (NOT file-wide contains): deleting the gate from
    // any ONE command's body must fail this test. Map op → (fn start, fn end).
    const envGated: Array<[string, string, string]> = [
      ['history', 'async function cmdHistory(', 'async function cmdQuoted('],
      ['quoted', 'async function cmdQuoted(', 'async function cmdSend('],
      ['send', 'async function cmdSend(', 'async function cmdDispatch('],
      ['dispatch', 'async function cmdDispatch(', 'async function cmdCreateGroup('],
      ['create-group', 'async function cmdCreateGroup(', 'async function cmdBots('],
    ];
    for (const [op, start, end] of envGated) {
      const body = region(cliSource, start, end);
      expect(body, `${op} env gate`).toContain(`assertTurnTransportOrExit('${op}')`);
    }
    // Target-aware gate scoped per command: --session-id-accepting commands gate
    // on the RESOLVED session (closes the cross-session bypass).
    const targetGated: Array<[string, string, string]> = [
      ['history', 'async function cmdHistory(', 'async function cmdQuoted('],
      ['quoted', 'async function cmdQuoted(', 'async function cmdSend('],
      ['send', 'async function cmdSend(', 'async function cmdDispatch('],
      ['dispatch', 'async function cmdDispatch(', 'async function cmdCreateGroup('],
    ];
    for (const [op, start, end] of targetGated) {
      const body = region(cliSource, start, end);
      expect(body, `${op} target-aware`).toContain('assertSessionTransportOrExit({ chatId: ');
    }
    // Root-dispatch gate: managed no-transport turn refused for ALL Lark-facing
    // commands, resolved via TAMPER-RESISTANT pid-marker ancestry (not raw env).
    const rootGate = region(cliSource, 'const LARK_FACING_COMMANDS = new Set(', 'switch (command) {');
    // The gate is memoized behind resolveManagedOriginTransport(); the ancestry
    // judgement it returns is asserted below.
    expect(rootGate).toContain('resolveManagedOriginTransport()');
    // The command set includes the verbs codex flagged (vc-agent, report).
    for (const cmd of ['send', 'dispatch', 'create-group', 'grant', 'vc-agent', 'report']) {
      expect(rootGate, `LARK_FACING has ${cmd}`).toContain(`'${cmd}'`);
    }
    // The managed-origin verdict resolves via ancestry (env-independent).
    const originGate = region(cliSource, 'function judgeManagedOriginTransport(', 'function managedOriginConflictMessage(');
    expect(originGate).toContain('findLiveAncestorSessionContext(dataDir)');
    expect(originGate).toContain('loadSessions().get(ctx.sessionId)');
    expect(originGate).toContain('isHttpVirtualSession(chatId)');
    const sessGate = region(cliSource, 'function assertSessionTransportOrExit(', 'process.exit(2);\n}');
    expect(sessGate).toContain('isHttpVirtualSession(chatId)');
    expect(sessGate).toContain('currentBotIsApiOnly(session.larkAppId)');
  });

  it('daemon session-write IPC routes gate no-transport via sessionTransportDisabled', () => {
    const ipcSource = readFileSync(resolve('src/core/dashboard-ipc-server.ts'), 'utf8');
    // Central daemon helper keyed on apiOnly bot OR virtual chatId.
    const helper = region(ipcSource, 'function sessionTransportDisabled(', '\n}\n');
    expect(helper).toContain('getBot(appId).config.apiOnly === true');
    expect(helper).toContain('larkTransportEnabled({');
    // Region-scoped per route (NOT file-wide count): each write route's body
    // must call the gate, so deleting one seam fails.
    const routes: Array<[string, string, string]> = [
      ['chat-rename', "ipcRoute('POST', '/api/sessions/:sessionId/chat-rename'", 'executeChatRename('],
      ['write-link-card', "ipcRoute('POST', '/api/sessions/:sessionId/write-link-card'", 'deliverWriteLinkCardToOwners(ds)'],
      ['locate', "ipcRoute('POST', '/api/sessions/:sessionId/locate'", 'sendSessionOwnerThreadNotification('],
    ];
    for (const [name, start, end] of routes) {
      const body = region(ipcSource, start, end);
      expect(body, `${name} route`).toContain('sessionTransportDisabled(');
    }
    // resume-notice gates its notice block. The wording now comes from
    // resumeSuccessMessage(), so the block is located by its poster instead.
    const resumeNotice = region(ipcSource, 'const postResumeNotice = async', 'getChatMode(ds.larkAppId');
    expect(resumeNotice).toContain('!sessionTransportDisabled(ds)');
  });

  it('daemon dashboard IPC session-history + restart-notice gate no-transport sessions', () => {
    const ipcSource = readFileSync(resolve('src/core/dashboard-ipc-server.ts'), 'utf8');
    const hist = region(ipcSource, "ipcRoute('GET', '/api/sessions/:sessionId/history'", 'listChatMessages(appId');
    expect(hist).toContain('larkTransportEnabled({ chatId: session.chatId, apiOnly: getBot(appId).config.apiOnly })');
    const notice = region(ipcSource, 'function postRestartNotice(', 'localeForBot(ds.larkAppId)');
    expect(notice).toContain('larkTransportEnabled({ chatId: ds.chatId, apiOnly: getBot(ds.larkAppId).config.apiOnly })');
  });

  it('createTeamGroup: no-transport (local apiOnly + remote apiOnly) excluded from creator AND members; remote normal kept', () => {
    const dashSource = readFileSync(resolve('src/dashboard.ts'), 'utf8');
    const block = region(dashSource, 'let noTransportRosterIds', 'proxyToDaemon(plan.creatorLarkAppId');
    // Remote apiOnly detected via the federated roster's larkTransportEnabled===false
    // (propagated spoke→sync→store→roster), NOT just local bots.json.
    expect(block).toContain('buildFederatedRoster(');
    expect(block).toContain('b.larkTransportEnabled === false');
    // Local apiOnly still detected from config.
    expect(block).toContain("b.larkAppId === id)?.apiOnly === true");
    // Creator = local-online AND transport; member excludes no-transport only.
    expect(block).toContain('const canBeCreator = (id: string): boolean => !!registry.getByAppId(id) && !isNoTransportBot(id);');
    expect(block).toContain('selectedIds.filter(id => !isNoTransportBot(id))');
    expect(block).not.toContain('selectedIds.filter(canBeCreator)');
  });

  it('federation propagates larkTransportEnabled (spoke pack → sanitizer → roster)', () => {
    const store = readFileSync(resolve('src/services/federation-store.ts'), 'utf8');
    expect(store).toContain('larkTransportEnabled?: boolean;');
    // Spoke packs it from local apiOnly config.
    const spoke = readFileSync(resolve('src/dashboard/federation-spoke-api.ts'), 'utf8');
    const localBots = region(spoke, 'function localBots(', '// owner (union_id+name) federated');
    expect(localBots).toContain('larkTransportEnabled: configReadable ? !apiOnlyIds.has(b.larkAppId) : false');
    // Receiver preserves it (explicit boolean only; absent→undefined→legacy normal).
    const api = readFileSync(resolve('src/dashboard/federation-api.ts'), 'utf8');
    expect(api).toContain("larkTransportEnabled: typeof r.larkTransportEnabled === 'boolean' ? r.larkTransportEnabled : undefined");
    // Aggregated roster carries it for remote bots.
    const fedRoster = readFileSync(resolve('src/services/federation-roster.ts'), 'utf8');
    expect(fedRoster).toContain('larkTransportEnabled: b.larkTransportEnabled,');
  });

  it('no-transport session read isolation FOLLOWS local sandbox config (no forced isolation); adopt is refused at restore', () => {
    // fresh-spawn forkWorker (shared by fresh/resume/restart) NO LONGER force-
    // isolates a no-transport session. readIsolation is opt-in only, driven purely
    // by explicit per-bot `readIsolation`; a no-transport session with no sandbox
    // config reads bots.json like a normal chat (accepted trade-off — lateral
    // sibling-cred protection now depends on the owner enabling sandbox).
    const wp = readFileSync(resolve('src/core/worker-pool.ts'), 'utf8');
    expect(wp).toContain('readIsolation: botCfg.readIsolation === true,');
    // The old forced-isolation disjunct is gone: readIsolation must NOT be tied to
    // transport state anymore.
    expect(wp).not.toContain('readIsolation: botCfg.readIsolation === true\n      || !larkTransportEnabled(');
    // Adopt does NOT gate via the init field (the observe branch returns before
    // fs-policy is built — an init readIsolation would be a dead no-op). Instead
    // adoptSandboxBlocked refuses a no-transport adopt at daemon restore and
    // converts it to cold-start: adopt attaches to an ALREADY-running external CLI
    // that could never be wrapped, so a no-transport turn must cold-start instead.
    const gate = region(wp, 'export function adoptSandboxBlocked(', 'export function forkAdoptWorker(');
    expect(gate).toContain('botCfg.apiOnly === true');
    expect(gate).toContain('isHttpVirtualSession(session?.chatId)');
  });
});

describe('API-only bot mode — non-client direct-Feishu paths (source lock)', () => {
  it('doc-comment driveApiCall enforces the same bot-level gate', () => {
    // doc-comment has its OWN drive API (subscribe/reply/comment/reaction) that
    // bypasses im/lark/client.ts — it must call assertLarkTransport too.
    const docSource = readFileSync(resolve('src/im/lark/doc-comment.ts'), 'utf8');
    const block = region(docSource, 'async function driveApiCall(', 'const bot = getBot(larkAppId);');
    expect(block).toContain('assertLarkTransport(larkAppId');
  });

  it('worker screenshot upload is disabled for apiOnly AND virtual-session (capability rides init)', () => {
    // The worker uploads via its OWN client (utils/lark-upload), bypassing the
    // daemon getBot gate, so the no-transport capability must ride the init
    // message. Covers apiOnly bot AND a normal bot in an HTTP virtual session.
    // The gate is derived from the CENTRAL larkTransportEnabled predicate keyed on
    // the init message (msg.chatId/msg.apiOnly), NOT ambient/cfg — so a normal bot
    // in an HTTP virtual session (real creds, apiOnly=false) is still disabled.
    // Matched STRUCTURALLY (predicate + both keys), not as one exact sentence:
    // an equivalent reformat (property reorder, prettier line-wrap) must not turn
    // this guard red, or the next person deletes it instead of fixing the code.
    // Each fragment is unique in worker.ts, so the trio still pins this one site.
    // Line comments are stripped first: a commented-out copy of the correct call
    // must not satisfy the guard while the live code is broken.
    const workerSource = stripLineComments(readFileSync(resolve('src/worker.ts'), 'utf8'));
    expect(workerSource).toMatch(/apiOnlyForUpload\s*=\s*!sessionLarkTransportEnabled\(/);
    expect(workerSource).toMatch(/chatId:\s*msg\.chatId/);
    expect(workerSource).toMatch(/apiOnly:\s*msg\.apiOnly/);
    expect(workerSource).toContain("if (apiOnlyForUpload)");
    // worker-pool forwards apiOnly on the init message (both fork sites).
    const wpSource = readFileSync(resolve('src/core/worker-pool.ts'), 'utf8');
    expect((wpSource.match(/apiOnly: botCfg\.apiOnly/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // And WITHHOLDS the real secret from a no-transport worker (removes the
    // capability rather than trusting a flag the sandboxed agent could flip).
    expect(wpSource).toContain("larkTransportEnabled({ chatId: ds.chatId, apiOnly: botCfg.apiOnly }) ? botCfg.larkAppSecret : ''");
  });
});

describe('API-only bot mode — apiOnly survives config reconstruction (source lock)', () => {
  it('worker init message + cred file + riff synthetic config all carry apiOnly', () => {
    const workerSource = readFileSync(resolve('src/worker.ts'), 'utf8');
    const cliSource = readFileSync(resolve('src/cli.ts'), 'utf8');
    // Worker forwards apiOnly into the sandbox env (riffModeSession reads it) and
    // persists it in the send-cred file (registerSelfFromCredFile reads it).
    expect(workerSource).toContain("sessionEnv.BOTMUX_API_ONLY = '1'");
    expect(workerSource).toContain('apiOnly: cfg.apiOnly');
    // riffModeSession synthetic BotConfig picks up the env flag.
    expect(cliSource).toContain("apiOnly: process.env.BOTMUX_API_ONLY === '1'");
    // registerSelfFromCredFile keeps apiOnly (and no longer bails on empty secret
    // when apiOnly — an apiOnly bot legitimately has none).
    expect(cliSource).toContain('cred.apiOnly === true');
  });

  it('withholds LARK_APP_SECRET from the worker CLI env for no-transport sessions', () => {
    // SEPARATE leak from the init-message field: forkWorker + forkAdoptWorker
    // inject LARK_APP_SECRET into the spawned CLI env directly from botCfg.
    const wpSource = readFileSync(resolve('src/core/worker-pool.ts'), 'utf8');
    const envInjections = wpSource.match(
      /LARK_APP_SECRET: larkTransportEnabled\(\{ chatId: ds\.chatId, apiOnly: botCfg\.apiOnly \}\) \? botCfg\.larkAppSecret : ''/g,
    ) ?? [];
    expect(envInjections.length).toBeGreaterThanOrEqual(2);
  });

  it('skips open-platform rename/avatar/description handler registration for apiOnly bots', () => {
    // These drive the console via a browser web-session (NOT getBotClient), so
    // the bot-level gate can't catch them — skip registration entirely.
    const daemonSrc = readFileSync(resolve('src/daemon.ts'), 'utf8');
    const block = region(daemonSrc, 'setDisplayNameRefresher(refreshBotNameState);', 'One cap implementation shared');
    expect(block).toContain('if (!cfg.apiOnly) {');
    expect(block.indexOf('if (!cfg.apiOnly) {')).toBeLessThan(block.indexOf('setBotRenamer('));
    expect(block.indexOf('if (!cfg.apiOnly) {')).toBeLessThan(block.indexOf('setBotAvatarChanger('));
    expect(block.indexOf('if (!cfg.apiOnly) {')).toBeLessThan(block.indexOf('setBotDescriptionManager('));
  });
});

describe('API-only bot mode — riff env re-freeze + VC listener exclusion (source lock)', () => {
  it('re-freezes no-transport keys AFTER the riff env merge (backendConfig.env cannot override)', () => {
    const workerSource = readFileSync(resolve('src/worker.ts'), 'utf8');
    const block = region(workerSource, 'const mergedEnv: Record<string, string> = {', 'riffBackendConfig = Object.assign(');
    // The merge puts backendConfig.env LAST; the re-freeze must run after it.
    expect(block).toContain('delete mergedEnv.BOTMUX_LARK_APP_SECRET;');
    expect(block).toContain("mergedEnv.BOTMUX_API_ONLY = '1';");
    expect(block).toContain('mergedEnv.BOTMUX_CHAT_ID = cfg.chatId;');
    expect(block.indexOf('...cfg.backendConfig.env')).toBeLessThan(block.indexOf('delete mergedEnv.BOTMUX_LARK_APP_SECRET;'));
  });

  it('excludes apiOnly bots from VC meeting preflight and fail-closes scope fetch', () => {
    // 全局「会议事件接收 Bot」下拉退役后（daemon 侧改成谁收到会议事件谁处理），
    // 会给某个 bot 开权限/订事件的入口只剩这一个 preflight。apiOnly bot 结构上收不到
    // 飞书事件，必须在跑开放平台自动化之前就被挡住。
    const dashSource = readFileSync(resolve('src/dashboard.ts'), 'utf8');
    const preflightBlock = region(dashSource, 'async function preflightVcMeetingBot(', '\n}\n');
    const guardAt = preflightBlock.indexOf("if (bot.apiOnly === true) return { ok: false, error: 'vcMeetingBot_preflight_api_only' };");
    expect(guardAt).toBeGreaterThan(-1);
    // 拦截必须排在任何开放平台调用之前（自动化 + scope 回读）。
    for (const call of ['await automateOpenPlatformSetup(', 'await validateVcMeetingScopesForBot(']) {
      const callAt = preflightBlock.indexOf(call);
      expect(callAt, `${call} not found`).toBeGreaterThan(-1);
      expect(guardAt, `apiOnly guard must precede ${call}`).toBeLessThan(callAt);
    }
    const fetchBlock = region(dashSource, 'async function fetchGrantedScopesForBot(', 'const brand =');
    expect(fetchBlock).toContain('bot.apiOnly === true');
    expect(fetchBlock).toContain('api_only_bot_has_no_feishu_credentials');
  });

  it('never seeds per-bot meeting roles while granting permissions (the cross-bot invite regression)', () => {
    // 「拉 A 进会却把 B 拉进监听群」的根因是给 bot 配置时顺手播种了一条 per-bot
    // 预设，并把执行方 appId 焊了进去（本 bot 结构上不合格时还会静默换成别人）。
    // 角色预设现在归 fleet 共享目录，执行方在读路径绑定为收到会议事件的 bot 自己；
    // 这个入口只负责权限与事件订阅，落盘只允许补 larkCliProfile。
    const dashSource = readFileSync(resolve('src/dashboard.ts'), 'utf8');
    const preflightBlock = region(dashSource, 'async function preflightVcMeetingBot(', '\n}\n');
    for (const forbidden of ['consumerProfiles', 'defaultConsumerIds', 'defaultProfileBootstrap', 'agentAppId']) {
      expect(preflightBlock, `preflight must not touch ${forbidden}`).not.toContain(`${forbidden} =`);
      expect(preflightBlock, `preflight must not touch ${forbidden}`).not.toContain(`${forbidden}:`);
    }
    // 唯一允许的落盘字段。
    const writeBlock = region(preflightBlock, 'withBotsJsonLock(', ', { caller:');
    expect(writeBlock).toContain('next.larkCliProfile = targetAppId;');
    expect(writeBlock).not.toMatch(/next\.(?!larkCliProfile\b)[A-Za-z]+\s*=/u);
    expect(preflightBlock).toContain("caller: 'dashboard', operation: 'vc-agent-profile'");
  });

  it('skips open-platform rename/avatar/description handler registration for apiOnly (fails closed to local rename)', () => {
    // Daemon owns the config: with the handler unregistered, the IPC route
    // returns renamer_not_wired (local displayName only, no console/Feishu call).
    const daemonSrc = readFileSync(resolve('src/daemon.ts'), 'utf8');
    expect(daemonSrc).toContain('} // end !cfg.apiOnly (open-platform profile handlers)');
  });
});

describe('API-only bot mode — no-transport fs-policy authority provenance (worker wiring source lock)', () => {
  // codex P2: prior fs-policy tests hand-fed authority roots and never touched
  // worker.ts's REAL path assembly — deleting the freeze stayed green. These
  // lock the actual worker→buildFsPolicy wiring so the freeze can't be removed
  // silently. The behavioral half lives in fs-policy.test.ts (the pure helper).
  const workerSource = readFileSync(resolve('src/worker.ts'), 'utf8');
  const workerPoolSource = readFileSync(resolve('src/core/worker-pool.ts'), 'utf8');

  it('worker passes BOTH the configured botmuxHome AND the frozen default ~/.botmux into buildFsPolicy', () => {
    const block = region(workerSource, 'const fsPolicyCtx = {', 'redirectedCliData: willRedirectCliData,');
    // configured root (= dirname(dataDir)) and the ALWAYS-frozen default root
    expect(block).toContain('botmuxHome: canonical(dirname(dataDir)),');
    expect(block).toContain('defaultBotmuxHome: canonical(defaultBotmuxHome),');
    // and the daemon-frozen loaded config path (not a BOTS_CONFIG env guess)
    expect(block).toContain('loadedBotsConfigPath: cfg.loadedBotsConfigPath ? canonical(cfg.loadedBotsConfigPath) : undefined,');
    // the OLD guess-the-dir approach is gone (no larkAuthorityRoots off env)
    expect(workerSource).not.toContain('larkAuthorityRoots');
  });

  it('worker turns an unconfined no-transport layout into a fail-closed spawn abort', () => {
    // FsPolicyConfigError (external bots-config / workingDir-is-authority) must
    // abort the spawn with a diagnostic, never fall through to an unconfined run.
    // Assert the meaningful imports are present (not a frozen full-literal named-import
    // list — that list legitimately grows, e.g. resolveLarkCliLinuxStoreDir for the
    // Linux keystore fix — so match the module + the two symbols this test relies on).
    const fsPolicyImport = region(workerSource, "import {", "} from './adapters/cli/fs-policy.js';");
    expect(fsPolicyImport).toContain('buildFsPolicy');
    expect(fsPolicyImport).toContain('FsPolicyConfigError');
    const block = region(workerSource, 'const policy = (() => {', 'suppressedAuthorityPaths?.length');
    expect(block).toContain('if (err instanceof FsPolicyConfigError) {');
    expect(block).toContain('refusing to start ${scope}');
    expect(block).toContain("'no-transport session'");
    // suppressed (dropped) authority allow paths are LOGGED, not silent
    expect(workerSource).toContain('no-transport suppressed');
  });

  it('worker injects a host CA bundle for sandboxed Codex without overriding an explicit value', () => {
    // Candidate list and selection rules are behaviour, covered by
    // test/darwin-ca-bundle.test.ts. What can only be asserted here is the
    // WIRING: both Codex cliIds, sandbox-only, explicit value wins, and the
    // worker's own logger carries the writable-bundle warning.
    expect(workerSource).toContain("from './utils/darwin-ca-bundle.js'");
    // Assert both cliIds are covered, not the exact clause text: swapping the
    // two sides of `||` is semantically identical and must not fail this.
    // Either the two literal ids or the shared predicate that is exactly those two.
    expect(workerSource).toMatch(/isCodexFamilyCliId\(cfg\.cliId\)|cfg\.cliId === 'codex'/);
    expect(workerSource).toMatch(/isCodexFamilyCliId\(cfg\.cliId\)|cfg\.cliId === 'codex-app'/);
    // Operator precedence: childEnv starts from the daemon env, so an
    // operator-supplied SSL_CERT_FILE is what this guard preserves.
    expect(workerSource).toContain('&& !childEnv.SSL_CERT_FILE');
    expect(workerSource).toContain('resolveDarwinCodexCaBundle({ warn: log })');
    expect(workerSource).toContain('if (caBundle) childEnv.SSL_CERT_FILE = caBundle;');
  });

  it('persistent-pane guard: state-machine + injectable executor wiring (behavioral tests in read-isolation)', () => {
    // The reattach guard delegates the DECISION to evaluatePersistentPaneMigration
    // and the ORDERED, fail-closed side effects to executePersistentPaneMigration.
    // Behavioral truth table + failure-path ordering live in read-isolation.test.ts
    // (real behavioral tests, not source-locks). Here we lock the WORKER WIRING.
    expect(workerSource).toContain('const migration = evaluatePersistentPaneMigration({');
    expect(workerSource).toContain('executePersistentPaneMigration(migration, migrationEffects)');
    expect(workerSource).not.toContain('persistentPaneReattachGuardEngaged');
    // issue #1 + #4: the gate must ENTER without requiring provenance for the
    // live-pane arms (a NEITHER-file no-transport tmux pane still reaches the
    // state machine), AND must ALSO enter on ANY session/backend that has stale
    // provenance on disk — so a dead pane's leftover marker/tombstone is cleared
    // before cold-spawn even for a transport-enabled chat that turned sandbox OFF
    // (else re-enabling sandbox warm-reattaches a fresh UNisolated pane as
    // "isolated" against the stale matching marker).
    expect(workerSource).toContain(
      'const persistentPaneGuardApplies = appliedIsolationCapabilities.length > 0\n'
      + '    || (noTransportSession && isolationCapableBackend)\n'
      + '    || stalePaneMarkerPresent || policyOffTombstonePresent;',
    );
    // issue #3: tombstone authorization requires a SECURE read + schema validation,
    // not a bare lstat "present".
    expect(workerSource).toContain('policyOffTombstoneValid(readManagedOriginAuthorityFile(policyOffTombstoneFilePath))');
    // Provenance removal is VERIFIED (unlink → re-probe → throw if still present).
    const remover = region(workerSource,
      'const removeProvenanceOrThrow =', 'const staleSessionName = persistentSessionName;');
    expect(remover).toContain('hostEntryExistsNoFollow(path)');
    expect(remover).toContain('could not remove stale');
    // The effects wire the real kill/probe/clear/reselect; the executor enforces
    // ordering + stop-on-failure (proven behaviorally in read-isolation.test.ts).
    const effects = region(workerSource,
      'const migrationEffects: PersistentPaneMigrationEffects = {',
      'executePersistentPaneMigration(migration, migrationEffects)');
    expect(effects).toContain('killStalePane:');
    expect(effects).toContain('confirmPaneGone:');
    // Tri-state fix: migration teardown fail-closes on ANY non-`missing` post-kill
    // probe for EVERY backend (kill unconfirmed on `unknown` — tmux swallows kill
    // errors, zellij ignores its exit — must not publish a new generation). This is
    // STRICTER than the shared shouldRejectPersistentPostKillProbe (ZMX-only
    // unknown), which the migration path deliberately no longer uses.
    expect(effects).toContain("postKillProbe !== 'missing'");
    expect(effects).not.toContain('shouldRejectPersistentPostKillProbe(');
    // Tri-state fix: an inconclusive (`unknown`) liveness probe fails closed via a
    // dedicated effect — never clear provenance / cold-spawn around a possibly-live
    // confined pane.
    expect(effects).toContain('refuseInconclusiveProbe:');
    expect(workerSource).toContain('could not verify existing ${effectiveBackendType} pane');
    expect(effects).toContain('clearProvenanceVerified:');
    expect(effects).toContain('reselectBackend:');
    // Generational-race fix: provenance is written PENDING before spawn (a nonce
    // record both validators reject) and only rewritten to committed AFTER spawn
    // confirms a fresh, non-reattached generation.
    expect(workerSource).toContain('provenancePendingContent(nonce)');
    expect(workerSource).toContain('let pendingProvenanceCommit: PersistentPaneCommit | null = null;');
    // The PENDING presence is fed into the state machine as a dominant input.
    expect(workerSource).toContain('pendingProvenancePresent,');
    expect(workerSource).toContain('provenancePendingNonce(readManagedOriginAuthorityFile(stalePaneMarkerPath))');
    // Commit runs AFTER actuallyReattachedPersistent is known, with a generation
    // fence + compare-before-replace on the pending nonce.
    const commitBlock = region(workerSource,
      'if (pendingProvenanceCommit) {', 'finalizeCodexAppControlGeneration(');
    // Condition #2: a predicted-fresh launch that dynamically reattached a late
    // pane must tear down + refuse, not silently keep running.
    expect(commitBlock).toContain('if (actuallyReattachedPersistent) {');
    expect(commitBlock).toContain('dynamically reattached a late-arriving pane');
    // Option B: isolation-capable zellij never commits (stays pending → cold-spawn).
    expect(commitBlock).toContain("effectiveBackendType === 'zellij'");
    expect(commitBlock).toContain('does not warm-reattach');
    // Condition #3: fence + compare-before-replace + commit-fail teardown.
    expect(commitBlock).toContain('spawnGeneration !== cliSpawnGeneration');
    expect(commitBlock).toContain('provenancePendingNonce(readManagedOriginAuthorityFile(commit.path))');
    expect(commitBlock).toContain('pending proof nonce mismatch');
    expect(commitBlock).toContain('replaceManagedOriginCapabilityFile(commit.path, commit.committedContent)');
    // Teardown = kill the EXACT backend target → confirm authoritative missing →
    // else keep pending + refuse (never erase evidence of a possibly-live pane).
    // CRITICAL: must NOT name-only kill — an isolated/MCP herdr agent lives on the
    // SHARED host session `botmux`, so a name-only killPersistentSession('herdr',
    // 'botmux') would tear down every bot's agent. Mirror the migration effects:
    // target helper for herdr's agent scope, frozen PID + socket dir for ZMX identity.
    const teardown = region(commitBlock,
      'const teardownTarget = selectedBackend.persistentBackendTarget;', 'Condition #2:');
    // Dispatches on the pure, behaviorally-tested policy (read-isolation.test.ts).
    expect(teardown).toContain('persistentTeardownKillKind({');
    expect(teardown).toContain('killPersistentBackendTarget(teardownTarget!, cfg.sessionId)');
    expect(teardown).toContain('probePaneAfterKill(persistentSessionName, killKind === \'target\' ? teardownTarget : undefined)');
    expect(teardown).toContain('ZmxBackend.killManagedSession(persistentSessionName, cfg.sessionId, resolvedZmxSessionPid, zmxEnv(process.env, resolvedZmxSocketDir))');
    expect(workerSource).toContain('probeOwnedZmxSession(name, cfg.sessionId, undefined, resolvedZmxSocketDir).probe');
    expect(teardown).toContain("postKill !== 'missing'");
    expect(teardown).toContain('pending proof retained');

    // Blocker #3: the policy-ON PENDING write is a spawn-time ADMISSION
    // PRECONDITION, not best-effort — a write failure must THROW before spawn (else
    // a late-flip reattach skips the pendingProvenanceCommit-gated teardown and
    // runs unattributed). Assert the policy-ON arm fails closed, same as policy-off.
    const pendingWrite = region(workerSource,
      "if (appliedIsolationCapabilities.length > 0 && persistentSessionName && !willReattachPersistent) {",
      "} else if (appliedIsolationCapabilities.length === 0");
    expect(pendingWrite).toContain('could not record pending isolation-marker generation proof');
    expect(pendingWrite).not.toContain('non-fatal');
  });

  it('daemon freezes the actual loaded bots-config path into the worker init message', () => {
    // getLoadedConfigPath() is host-frozen; the worker must not re-guess from env.
    const block = region(workerPoolSource, 'apiOnly: botCfg.apiOnly,', 'brand: normalizeBrand(botCfg.brand),');
    expect(block).toContain('loadedBotsConfigPath: getLoadedConfigPath(),');
    // ...and its PROVENANCE travels with it, so the child-pin decision is made
    // from a host-owned fact instead of an existence probe (see config-dir.ts).
    expect(block).toContain('loadedBotsConfigProvenance: getLoadedConfigProvenance(),');
    // Assert the import contents, not one frozen line: pinning the exact string
    // makes this fail on any unrelated addition to the same import.
    const importLine = workerPoolSource.match(/import \{[^}]*\} from '\.\.\/bot-registry\.js';/)?.[0];
    expect(importLine).toBeDefined();
    for (const sym of ['getBot', 'getAllBots', 'loadBotConfigs', 'resolveBrandLabel',
      'getLoadedConfigPath', 'getLoadedConfigProvenance', 'resolveUsageDisplay']) {
      expect(importLine, `missing ${sym}`).toContain(sym);
    }
  });
});

describe('core-only entrypoint hardening (codex 4 P1s — source lock)', () => {
  const daemonSource = readFileSync(resolve('src/daemon.ts'), 'utf8');
  const ipcSource = readFileSync(resolve('src/core/dashboard-ipc-server.ts'), 'utf8');
  const registrySource = readFileSync(resolve('src/bot-registry.ts'), 'utf8');
  const entrySource = readFileSync(resolve('src/index-core-only.ts'), 'utf8');

  it('P1-1: keeps HMAC on (authRequired:true) and only ALLOWLISTS the tight riff routes', () => {
    // The bug: authRequired:false opened all 96 IPC routes. The fix keeps auth on
    // and adds a narrow core-only public allowlist — NOT a wholesale auth-off.
    const block = region(daemonSource, 'const coreOnly = process.env.BOTMUX_CORE_ONLY', 'desc.ipcPort = ipcHandle.port;');
    expect(block).toContain('authRequired: true,');
    expect(block).toContain('coreOnlyPublicRoutes: coreOnly,');
    expect(block).not.toContain('authRequired: coreOnly');   // old auth-off gone
    expect(block).not.toContain('BOTMUX_API_REQUIRE_AUTH');  // old opt-back-in gone
    // The allowlist is exactly trigger + trigger-result + insight (NOT /answer,
    // which is askId-keyed with no session binding — codex).
    const allow = region(ipcSource, 'function routeIsCoreOnlyPublic(', '\n}\n');
    expect(allow).toContain("pathname === '/api/trigger'");
    expect(allow).toContain('trigger-result$');
    expect(allow).toContain('insight$');
    expect(allow).not.toContain('answer');
    // And the gate consults it only under the core-only flag.
    expect(ipcSource).toContain('opts.coreOnlyPublicRoutes === true && routeIsCoreOnlyPublic(method, url.pathname)');
  });

  it('P1-2: core-only skips fleet sandbox migration + synthesis ignores ambient BOTS_CONFIG', () => {
    // Migration reads/backs-up/rewrites the on-disk fleet bots.json — must not run
    // for a headless core-only service.
    expect(daemonSource).toContain("if (process.env.BOTMUX_CORE_ONLY !== '1') {\n    await migrateSandboxConfigAtStartup();");
    // Synthesis is authoritative: no early-return on BOTS_CONFIG (the old
    // `if (process.env.BOTS_CONFIG) return null;` deference is gone).
    const synth = region(registrySource, 'function maybeSynthesizeCoreOnlyConfig(', 'return configs;');
    expect(synth).toContain("if (process.env.BOTMUX_CORE_ONLY !== '1') return null;");
    expect(synth).not.toContain('if (process.env.BOTS_CONFIG) return null;');
  });

  it('P1-3: readiness barrier — gate armed BEFORE bind; control routes + /healthz 503 until ready', () => {
    // /healthz reports 503 while armed-but-not-ready (via coreOnlyNotReady()).
    const health = region(ipcSource, "ipcRoute('GET', '/healthz'", '\n});');
    expect(health).toContain('coreOnlyNotReady()');
    expect(health).toContain('503');
    // The server-level gate ALSO 503s the public control routes when not ready —
    // so a trigger during 'starting' can't slip past by skipping the healthz probe.
    expect(ipcSource).toContain('if (coreOnlyPublic && coreOnlyNotReady())');
    // Ordering: arm BEFORE the bind (no bound-but-unarmed window), release only
    // after restore, ready line last.
    const armAt = daemonSource.indexOf('armCoreOnlyReadinessGate()');
    const bindAt = daemonSource.indexOf('const ipcHandle = await startIpcServer(');
    const restoreAt = daemonSource.indexOf('await restoreSessionsAndScheduleStartupRecovery({');
    const readyAt = daemonSource.indexOf('setCoreOnlyReady()');
    const readyLineAt = daemonSource.indexOf('[core-only] listening on 127.0.0.1:');
    expect(armAt).toBeGreaterThan(0);
    expect(bindAt).toBeGreaterThan(armAt);             // arm BEFORE bind (P1)
    expect(restoreAt).toBeGreaterThan(bindAt);
    expect(readyAt).toBeGreaterThan(restoreAt);        // release AFTER restore
    expect(readyLineAt).toBeGreaterThan(readyAt);      // ready line after release

    const helperCall = region(
      daemonSource,
      'await restoreSessionsAndScheduleStartupRecovery({',
      '\n\n  // Restore complete:',
    );
    expect(helperCall).toContain(
      'restoreSessions: () => restoreActiveSessions(activeSessions, idempotencyQuarantinedSessionIds, {',
    );
    expect(helperCall).toContain(
      'prepareTurn: (ds, turnId) => prepareTurnCliIdentity(ds, turnId),',
    );
    expect(helperCall).toContain('markSessionsRestored: () => {');
    expect(helperCall).toContain('sessionsRestored = true;');

    // Supplemental ordering guard only; this assertion does not prove callback
    // delivery semantics and must not be treated as load-bearing evidence.
    const dispatcherStartAt = daemonSource.indexOf(
      'for (const startDispatcher of startEventDispatchers) startDispatcher();',
    );
    const quarantineNoticeAt = daemonSource.indexOf(
      'for (const notice of startupXpiQuarantineNotices)',
    );
    expect(dispatcherStartAt).toBeGreaterThan(restoreAt);
    expect(quarantineNoticeAt).toBeGreaterThan(dispatcherStartAt);

    const helperBody = region(
      daemonSource,
      'async function restoreSessionsAndScheduleStartupRecovery(opts: {',
      '\n}\n/** Once-per-daemon guard for the mojo containment boot reconciliation.',
    );
    const helperAwaitRestoreAt = helperBody.indexOf('await opts.restoreSessions();');
    const helperScheduleAt = helperBody.indexOf('scheduleRestoredStreamingCardPinRecovery(opts.larkAppId);');
    const helperMarkReadyAt = helperBody.indexOf('opts.markSessionsRestored();');
    expect(helperAwaitRestoreAt).toBeGreaterThan(0);
    expect(helperScheduleAt).toBeGreaterThan(helperAwaitRestoreAt);
    expect(helperMarkReadyAt).toBeGreaterThan(helperScheduleAt);
  });

  it('P1-4: core-only forces terminal proxy + worker HTTP to loopback (unconditional)', () => {
    expect(daemonSource).toContain("const terminalProxyHost = coreOnly ? '127.0.0.1' : config.web.host;");
    expect(daemonSource).toContain('host: terminalProxyHost,');
    // Entrypoint pins the worker HTTP host to loopback UNCONDITIONALLY (a stray
    // parent/dotenv 0.0.0.0 must not survive) and drops the legacy alias.
    expect(entrySource).toContain("process.env.BOTMUX_WORKER_HTTP_HOST = '127.0.0.1';");
    expect(entrySource).toContain('delete process.env.BOTMUX_WORKER_HOST;');
    // NOT gated on "only when unset" anymore.
    expect(entrySource).not.toContain('if (!process.env.BOTMUX_WORKER_HTTP_HOST');
  });

  it('stamps the turn sender type onto the trusted caller at both IM entry points', () => {
    // A bot's turn carries a perfectly valid union_id (its own), so a consumer
    // cannot tell "a person asked" from "a bot triggered itself" unless the host
    // says which it was. Both inbound paths must therefore pass it — a missed
    // one silently degrades to "unknown" exactly where a bot could slip through.
    expect(daemonSource).toContain('senderIsBot?: boolean,');
    expect(daemonSource).toContain("senderType: senderIsBot ? 'bot' as const : 'user' as const");
    // Pin the SEMANTICS, not the argument's spelling: every call must pass a
    // non-empty 4th argument, and it must be the tri-state helper rather than a
    // bare `sender_type` comparison — that one reads a cross-ref-identified peer
    // bot as `'user'`, i.e. it vouches for a bot turn as a person.
    // Both IM entry points stamp the sender type; the tri-state value is
    // computed once per message and passed in as the 4th argument.
    expect(daemonSource).toContain('trustedCallerForTurn(larkAppId, operatorOpenId, undefined, operatorIsBot)');
    expect((daemonSource.match(/trustedCallerForTurn\(/g) || []).length).toBeGreaterThanOrEqual(3);
    // The peer-bot leg is wired at both IM entry points through the tri-state
    // helper (a bare `sender_type` comparison misses cross-ref peer bots).
    expect(daemonSource).toContain('senderIsBotTriState(message.senderType');
    expect(daemonSource).toContain('senderIsBotTriState(parsed.senderType, isForeignBotSender)');
  });

  it('P1-2: entrypoint strips BOTS_CONFIG so no worker fork inherits it', () => {
    // The parser ignores BOTS_CONFIG for identity, but the raw env is inherited by
    // forked workers — an agent could cat $BOTS_CONFIG. Delete it after dotenv,
    // before startDaemon (so workerForkEnv(process.env) sees it gone).
    expect(entrySource).toContain('delete process.env.BOTS_CONFIG;');
    const delAt = entrySource.indexOf('delete process.env.BOTS_CONFIG;');
    const startAt = entrySource.indexOf('await startDaemon()');
    expect(delAt).toBeGreaterThan(0);
    expect(startAt).toBeGreaterThan(delAt); // stripped BEFORE the daemon (and any fork)
    // cmdServe (the CLI spawn path) also scrubs it from the child env.
    const cliSource = readFileSync(resolve('src/cli.ts'), 'utf8');
    const serve = region(cliSource, 'async function cmdServe(', 'child.on(');
    expect(serve).toContain('delete e.BOTS_CONFIG;');
    expect(serve).toContain("BOTMUX_WORKER_HTTP_HOST: '127.0.0.1',");
  });

  it('P1(2nd round): entrypoint FREEZES a dedicated state root, ignoring ambient SESSION_DATA_DIR', () => {
    // A managed turn that spawns `serve --api-only` carries the host's
    // SESSION_DATA_DIR; core-only must NOT read/mutate that fleet store. The
    // entrypoint overwrites SESSION_DATA_DIR with a dedicated per-bot root before
    // any config module reads it.
    expect(entrySource).toContain('process.env.SESSION_DATA_DIR = frozenStateDir;');
    expect(entrySource).toContain("join(homedir(), '.botmux', 'core-only', coreBotId, 'data')");
    expect(entrySource).toContain('BOTMUX_CORE_STATE_DIR'); // explicit override knob
    // Freeze happens before startDaemon (which reads config.session.dataDir).
    const freezeAt = entrySource.indexOf('process.env.SESSION_DATA_DIR = frozenStateDir;');
    const startAt = entrySource.indexOf('await startDaemon()');
    expect(freezeAt).toBeGreaterThan(0);
    expect(startAt).toBeGreaterThan(freezeAt);
    // cmdServe also strips ambient SESSION_DATA_DIR from the spawn env.
    const cliSource = readFileSync(resolve('src/cli.ts'), 'utf8');
    const serve = region(cliSource, 'async function cmdServe(', 'child.on(');
    expect(serve).toContain('delete e.SESSION_DATA_DIR;');
  });

  it('P1(2nd round): core-only skips host-wide maintenance / auto-restart / restart-report', () => {
    // The synthetic bot is idx=0 but must NOT own fleet maintenance (global
    // botmux update + detached `botmux restart`). Gate the whole block on !coreOnly.
    expect(daemonSource).toContain('if (idx === 0 && !coreOnly) {');
    // The maintenance starter is inside that gated block.
    const block = region(daemonSource, 'if (idx === 0 && !coreOnly) {', 'Host-overload watcher');
    expect(block).toContain('startMaintenance();');
    expect(block).toContain('startCliRuntimeUpdateMonitor(');
    expect(block).toContain('sendRestartReportIfPending(');
    expect(block).toContain('notifyOnRestart: readGlobalConfig().maintenance?.notifyOnRestart !== false,');
  });

  it('P1(3rd round): core-only does NOT write shared-HOME .data-dir breadcrumb or ~/.botmux/bin wrapper', () => {
    // writePidFile writes the global ~/.botmux/.data-dir signpost + ~/.botmux/bin
    // wrapper. Both are shared-HOME: core-only must not rewrite them (would point a
    // same-HOME host operator/fleet PATH at the core-only store/canary dist, unrestored
    // on exit). breadcrumb skipped in core-only; wrapper goes to a dedicated bin dir.
    const wp = region(daemonSource, 'function writePidFile(', 'logger.info(`PID file written');
    expect(wp).toContain("if (process.env.BOTMUX_CORE_ONLY !== '1') {"); // breadcrumb gated
    // The daemon resolves the wrapper bin dir via the single source of truth.
    expect(daemonSource).toContain('const BOTMUX_BIN_DIR = resolveBotmuxWrapperBinDir(process.env);');
    // fs-policy grants the dedicated bin dir readOnly for the sandboxed no-transport turn.
    const policySrc = readFileSync(resolve('src/adapters/cli/fs-policy.ts'), 'utf8');
    expect(policySrc).toContain('`${ctx.sessionDataDir}/bin`');
  });

  it('P1(4th round): wrapper bin dir has ONE resolver; every PATH consumer routes through it (no hardcoded ~/.botmux/bin prepend)', () => {
    // codex P1: the WRITE went to a dedicated dir but the CONSUMERS (worker.ts x4,
    // tmux x2) still prepended the shared ~/.botmux/bin — so PATH became
    // shared:dedicated:… and `command -v botmux` hit the shared/fleet wrapper.
    const wrapperSrc = readFileSync(resolve('src/core/botmux-wrapper.ts'), 'utf8');
    expect(wrapperSrc).toContain('export function resolveBotmuxWrapperBinDir(');
    expect(wrapperSrc).toContain("env.BOTMUX_CORE_ONLY === '1' && env.SESSION_DATA_DIR");
    // worker.ts: all 4 PATH prepends go through the resolver; NO hardcoded bin join.
    const workerSrc = readFileSync(resolve('src/worker.ts'), 'utf8');
    const prependCount = (workerSrc.match(/prependBotmuxBin\(/g) || []).length;
    expect(prependCount).toBeGreaterThanOrEqual(4);
    expect(workerSrc).toContain('childEnv.BOTMUX_WRAPPER_BIN = resolveBotmuxWrapperBinDir(process.env);');
    expect(workerSrc).not.toContain("join(homedir(), '.botmux', 'bin')");
    // worker-pool: fork PATH via the resolver.
    const wpSrc = readFileSync(resolve('src/core/worker-pool.ts'), 'utf8');
    expect(wpSrc).toContain('const botmuxBinDir = resolveBotmuxWrapperBinDir(process.env);');
    expect(wpSrc).not.toContain("join(homedir(), '.botmux', 'bin')");
    // tmux backend: pane scripts bake a HOST-RESOLVED bin dir literal (codex P1:
    // the pane can't resolve at runtime — BOTMUX_CORE_ONLY/SESSION_DATA_DIR are
    // scrubbed before the script runs). shellWrapperScript(binDir) takes it as an
    // arg; call sites resolve via resolveBotmuxWrapperBinDir(opts.env). NO hardcoded
    // $HOME/.botmux/bin and NO runtime-env shell resolution.
    const tmuxSrc = readFileSync(resolve('src/adapters/backend/tmux-backend.ts'), 'utf8');
    expect(tmuxSrc).toContain("export function shellWrapperScript(binDir: string, kind: ShellKind = 'sh')");
    // The tmux pane spawn lives in the pipe backend, which must also resolve the
    // dir through the single source of truth (never a hardcoded PATH literal).
    const tmuxPipeSrc = readFileSync(resolve('src/adapters/backend/tmux-pipe-backend.ts'), 'utf8');
    expect(tmuxPipeSrc).toContain('shellWrapperScript(resolveBotmuxWrapperBinDir(opts.env ?? process.env), shellKind)');
    expect(tmuxSrc).not.toContain('export PATH="$HOME/.botmux/bin:$PATH"');
    expect(tmuxSrc).not.toContain('botmuxWrapperPathExportSh'); // footgun removed
    const fishAwarePersistentBackendCalls: Record<string, RegExp> = {
      // The pane script may take the resolved kind local (shellKind) or inline it.
      'src/adapters/backend/tmux-pipe-backend.ts': /shellWrapperScript\(\s*resolveBotmuxWrapperBinDir\(opts\.env \?\? process\.env\),\s*(?:shellKind|shellKindForPath\(shellSpec\.shell\)),?\s*\)/,
      'src/adapters/backend/zellij-backend.ts': /shellWrapperScript\(resolveBotmuxWrapperBinDir\(opts\.env \?\? process\.env\), kind\)/,
      'src/adapters/backend/zmx-backend.ts': /shellWrapperScript\(wrapperBinDir, shellKind\)/,
    };
    for (const [f, callPattern] of Object.entries(fishAwarePersistentBackendCalls)) {
      const src = readFileSync(resolve(f), 'utf8');
      expect(src, f).toContain('resolveBotmuxWrapperBinDir(opts.env ?? process.env)');
      expect(src, f).toMatch(callPattern);
      expect(src, f).not.toMatch(/import \{[^}]*\bSHELL_WRAPPER_SCRIPT\b/);
      expect(src, f).not.toMatch(/'-c', SHELL_WRAPPER_SCRIPT\b/);
    }
  });
});

describe('core-only host facts isolation', () => {
  let handle: IpcServerHandle | null = null;
  afterEach(async () => {
    if (handle) await handle.close();
    handle = null;
    __testOnly_resetCoreOnlyReadiness();
    setIpcAuthSecret(null);
    setLarkAppId('');
  });
  it('host-facts (unauthenticated in core-only) answers only for this daemon\'s apiOnly HTTP virtual sessions', async () => {
    setIpcAuthSecret('core-only-host-facts-secret');
    setLarkAppId('local_riff');
    let apiOnly = true;
    vi.spyOn(botRegistry, 'getBot').mockImplementation(() => (apiOnly ? apiOnlyBot() : { config: { larkAppId: 'local_riff' } } as any));
    const find = vi.spyOn(workerPool, 'findActiveBySessionId');
    handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true, coreOnlyPublicRoutes: true });
    const hostFacts = async (chatId: string, larkAppId = 'local_riff') => {
      find.mockReturnValue({ session: { sessionId: 's-hf', chatId, larkAppId, status: 'active' }, larkAppId, chatId } as any);
      return fetch(`http://127.0.0.1:${handle!.port}/api/sessions/s-hf/host-facts`);
    };

    const owned = await hostFacts('http_async_hf');
    expect(owned.status).toBe(200);
    expect((await owned.json()).facts).toMatchObject({ sessionId: 's-hf' });

    expect((await hostFacts('oc_real_chat')).status).toBe(404);
    expect((await hostFacts('http_async_hf', 'local_other')).status).toBe(404);
    apiOnly = false;
    expect((await hostFacts('http_async_hf')).status).toBe(404);
  });
});

describe('apiOnly trigger request shape', () => {
  it('may only resume its own HTTP virtual session, never a real-chat session', async () => {
    vi.spyOn(botRegistry, 'getBot').mockReturnValue(apiOnlyBot());
    const request = (sessionId: string): TriggerRequest => ({
      source: { type: 'ui', requestId: 'r-resume' },
      target: { kind: 'turn', botId: 'local_riff', sessionId },
      envelope: { format: 'botmux.ui.v1', sourceName: 'riff', trusted: false, payload: {} },
      options: { asyncReturnSessionId: true, dryRun: true },
    });
    const activeSessions = new Map<string, DaemonSession>([
      ['real', { session: { sessionId: 's-real' }, chatId: 'oc_real_chat', larkAppId: 'local_riff' } as any],
      ['virtual', { session: { sessionId: 's-virtual' }, chatId: 'http_async_v', larkAppId: 'local_riff' } as any],
    ]);

    const real = await triggerSessionTurn(request('s-real'), { larkAppId: 'local_riff', activeSessions });
    expect(real).toMatchObject({ ok: false, errorCode: 'bad_request' });
    const virtual = await triggerSessionTurn(request('s-virtual'), { larkAppId: 'local_riff', activeSessions });
    expect(virtual).toMatchObject({ ok: true, action: 'dry_run' });
  });
});

describe('apiOnly paths that would otherwise fall back to a user token', () => {
  function armUserTokenFallback() {
    vi.spyOn(botRegistry, 'getBot').mockReturnValue(apiOnlyBot());
    const tokenSpy = vi.spyOn(userToken, 'resolveUserToken').mockResolvedValue('u-token-live' as any);
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    return { tokenSpy, fetchSpy };
  }

  it('downloadMessageResource refuses before the app-token attempt can fall through to a user token', async () => {
    const { tokenSpy, fetchSpy } = armUserTokenFallback();
    const dir = mkdtempSync(join(tmpdir(), 'api-only-download-'));
    try {
      await expect(downloadMessageResource('local_riff', 'om_x', 'file_x', 'file', join(dir, 'out.bin'), 'ou_sender'))
        .rejects.toBeInstanceOf(LarkTransportDisabledError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(tokenSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('doc-comment drive calls refuse an apiOnly bot even when an acting user token exists', async () => {
    const { tokenSpy, fetchSpy } = armUserTokenFallback();
    await expect(__testOnly_driveApiCall('local_riff', {
      method: 'GET', path: '/open-apis/drive/v1/files/doc_x/comments', userOpenId: 'ou_actor',
    } as any)).rejects.toBeInstanceOf(LarkTransportDisabledError);
    expect(tokenSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('CLI transport gate for a managed no-transport turn', () => {
  it('is resolved from the pid-marker ancestry, so stripping every BOTMUX_* env var does not bypass it', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'api-only-cli-gate-'));
    try {
      seedPersistedSessionRows(dataDir, 'cli_gate_bot', {
        s_virtual: { sessionId: 's_virtual', chatId: 'http_async_gate', larkAppId: 'cli_gate_bot', rootMessageId: '', scope: 'chat', status: 'active' },
      });
      // The worker writes this marker for its CLI's process tree; the spawned
      // CLI's parent is this test process.
      mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
      writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({ sessionId: 's_virtual' }));
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('BOTMUX_') && v !== undefined) env[k] = v;
      env.SESSION_DATA_DIR = dataDir;
      for (const command of ['create-group', 'top-notice']) {
        const r = spawnSyncTsScript('src/cli.ts', [command], { env, encoding: 'utf8', timeout: 60_000 });
        expect(r.status, command).toBe(2);
        expect(String(r.stderr), command).toMatch(/no Feishu transport/);
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('follows the session record when a bound session still carries its spawn-time headless env', () => {
    // A headless session that is later bound/transferred to a real chat keeps the
    // CLI process it was spawned with: the tmux backend re-attaches to the
    // surviving bmx-<sessionId> instead of respawning, so BOTMUX_CHAT_ID stays
    // `headless_*` for the rest of that generation. The session record has
    // already moved and is the routing truth — `send` (and every sibling verb)
    // must not be refused for the whole life of that process.
    const dataDir = mkdtempSync(join(tmpdir(), 'api-only-cli-bound-'));
    try {
      seedPersistedSessionRows(dataDir, 'cli_gate_bot', {
        s_bound: { sessionId: 's_bound', chatId: 'oc_bound_gate', larkAppId: 'cli_gate_bot', rootMessageId: 'om_bound_root', scope: 'thread', status: 'active' },
      });
      mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
      writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({ sessionId: 's_bound' }));
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('BOTMUX_') && v !== undefined) env[k] = v;
      env.SESSION_DATA_DIR = dataDir;
      env.BOTMUX_SESSION_ID = 's_bound';
      env.BOTMUX_CHAT_ID = 'headless_hl_stale';
      env.BOTMUX_LARK_APP_ID = 'cli_gate_bot';
      for (const { args, status, downstream } of [
        // `send` validates --response-kind and similar argv shapes before the
        // root gate, so the bad value must be one cmdSend checks after its gate.
        { args: ['send', '--plugin-card-action', 'BAD!', 'hello'], status: 2, downstream: /无效 plugin id/ },
        { args: ['create-group'], status: 1, downstream: /--bot/ },
      ]) {
        const r = spawnSyncTsScript('src/cli.ts', args, { env, encoding: 'utf8', timeout: 60_000 });
        // Invalid arguments stop before credentials or network activity, but
        // only after both transport gates have accepted the bound session.
        expect(r.status, args.join(' ')).toBe(status);
        expect(String(r.stderr), args.join(' ')).toMatch(downstream);
        expect(String(r.stderr), args.join(' ')).not.toMatch(/headless automation session|no Feishu transport/);
      }
      // tabs / top-notice prefer the caller's env chat over the record; the
      // headless snapshot must not shadow the chat the session was bound to.
      // No bot is configured here, so the command fails before any Feishu call
      // and reports the chat it resolved.
      const tabs = spawnSyncTsScript('src/cli.ts', ['tabs', 'list', '--json'], { env, encoding: 'utf8', timeout: 60_000 });
      const tabsResult = String(tabs.stdout).trim().split('\n').pop() ?? '';
      expect(tabsResult, String(tabs.stderr)).toMatch(/^\{/);
      expect(JSON.parse(tabsResult).chatId).toBe('oc_bound_gate');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 120_000);

  it.each(['headless_gate', 'http_async_gate', 'http_wait_gate'])(
    'refuses a conflicting env session while its ancestor remains %s', chatId => {
      const dataDir = mkdtempSync(join(tmpdir(), 'api-only-cli-conflict-'));
      try {
        seedPersistedSessionRows(dataDir, 'cli_gate_bot', {
          s_virtual: { sessionId: 's_virtual', chatId, larkAppId: 'cli_gate_bot', scope: 'chat', status: 'active' },
          s_real: { sessionId: 's_real', chatId: 'oc_real_gate', larkAppId: 'cli_gate_bot', scope: 'chat', status: 'active' },
        });
        mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
        writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({ sessionId: 's_virtual' }));
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('BOTMUX_') && v !== undefined) env[k] = v;
        env.SESSION_DATA_DIR = dataDir;
        env.BOTMUX_SESSION_ID = 's_real';
        env.BOTMUX_CHAT_ID = 'oc_real_gate';
        env.BOTMUX_LARK_APP_ID = 'cli_gate_bot';
        const r = spawnSyncTsScript('src/cli.ts', ['create-group'], { env, encoding: 'utf8', timeout: 60_000 });
        expect(r.status).toBe(2);
        expect(String(r.stderr)).toMatch(/marker names session s_virtual, but BOTMUX_SESSION_ID names s_real/);
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    }, 120_000,
  );

  it('refuses when a verified ancestor marker and BOTMUX_SESSION_ID name two different real sessions', () => {
    // Either session could reach Feishu on its own, so only the conflict check
    // stands between this call and routing it through a session it may not own.
    const dataDir = mkdtempSync(join(tmpdir(), 'api-only-cli-real-conflict-'));
    try {
      seedPersistedSessionRows(dataDir, 'cli_gate_bot', {
        s_marker: { sessionId: 's_marker', chatId: 'oc_marker_gate', larkAppId: 'cli_gate_bot', scope: 'chat', status: 'active' },
        s_env: { sessionId: 's_env', chatId: 'oc_env_gate', larkAppId: 'cli_gate_bot', scope: 'chat', status: 'active' },
      });
      mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
      writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({
        sessionId: 's_marker',
        procStart: readProcessStartIdentity(process.pid),
      }));
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('BOTMUX_') && v !== undefined) env[k] = v;
      env.SESSION_DATA_DIR = dataDir;
      env.BOTMUX_SESSION_ID = 's_env';
      env.BOTMUX_CHAT_ID = 'oc_env_gate';
      env.BOTMUX_LARK_APP_ID = 'cli_gate_bot';
      for (const args of [['create-group'], ['send', '--plugin-card-action', 'BAD!', 'hello']]) {
        const r = spawnSyncTsScript('src/cli.ts', args, { env, encoding: 'utf8', timeout: 60_000 });
        expect(r.status, args.join(' ')).toBe(2);
        expect(String(r.stderr), args.join(' ')).toMatch(/marker names session s_marker, but BOTMUX_SESSION_ID names s_env/);
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('refuses an apiOnly bot even with a real-chat session record', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'api-only-cli-real-'));
    try {
      seedPersistedSessionRows(dataDir, 'cli_gate_bot', {
        s_real: { sessionId: 's_real', chatId: 'oc_real_gate', larkAppId: 'cli_gate_bot', scope: 'chat', status: 'active' },
      });
      mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
      writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({ sessionId: 's_real' }));
      mkdirSync(join(dataDir, '.botmux'), { recursive: true });
      writeFileSync(join(dataDir, '.botmux', 'bots.json'), JSON.stringify([
        { larkAppId: 'cli_gate_bot', apiOnly: true, cliId: 'traex' },
      ]));
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('BOTMUX_') && v !== undefined) env[k] = v;
      env.HOME = dataDir;
      env.SESSION_DATA_DIR = dataDir;
      env.BOTMUX_SESSION_ID = 's_real';
      env.BOTMUX_CHAT_ID = 'oc_real_gate';
      env.BOTMUX_LARK_APP_ID = 'cli_gate_bot';
      const r = spawnSyncTsScript('src/cli.ts', ['create-group'], { env, encoding: 'utf8', timeout: 60_000 });
      expect(r.status).toBe(2);
      expect(String(r.stderr)).toMatch(/no Feishu transport/);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('core-only entrypoint', () => {
  it('freezes a dedicated state root, strips BOTS_CONFIG and pins worker HTTP to loopback before the daemon starts', async () => {
    const home = mkdtempSync(join(tmpdir(), 'core-only-entry-'));
    const before = { ...process.env };
    let envAtStart: NodeJS.ProcessEnv | undefined;
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.resetModules();
    vi.doMock('../src/daemon.js', () => ({ startDaemon: async () => { envAtStart = { ...process.env }; } }));
    try {
      Object.assign(process.env, {
        HOME: home,
        BOTMUX_API_PORT: '45931',
        BOTS_CONFIG: '/fleet/bots.json',
        SESSION_DATA_DIR: '/fleet/data',
        BOTMUX_WORKER_HTTP_HOST: '0.0.0.0',
        BOTMUX_WORKER_HOST: '0.0.0.0',
      });
      delete process.env.BOTMUX_CORE_STATE_DIR;
      delete process.env.BOTMUX_API_ONLY_BOT;
      await import('../src/index-core-only.js');
      await vi.waitFor(() => expect(envAtStart).toBeDefined(), { timeout: 30_000 });
      expect(envAtStart!.BOTMUX_CORE_ONLY).toBe('1');
      expect(envAtStart!.BOTS_CONFIG).toBeUndefined();
      expect(envAtStart!.SESSION_DATA_DIR).toBe(join(home, '.botmux', 'core-only', 'local_riff', 'data'));
      expect(envAtStart!.BOTMUX_WORKER_HTTP_HOST).toBe('127.0.0.1');
      expect(envAtStart!.BOTMUX_WORKER_HOST).toBeUndefined();
      expect(exit).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('../src/daemon.js');
      for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k];
      Object.assign(process.env, before);
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('source-structure guards (no injectable seam)', () => {
  // 源码结构护栏(K2)：core-only 的 IPC 鉴权与监听地址在 startDaemon 巨型闭包里组装，没有 seam。
  // 不变量：core-only 仍保持 trusted-host HMAC（只额外放行 routeIsCoreOnlyPublic 白名单），终端代理强制 loopback。
  // 白名单 / 就绪闸门的行为由 dashboard-ipc.test.ts 覆盖。来历：#668 codex P1-1（authRequired:false 曾放开全部 IPC 路由）、P1-4。
  it('core-only daemon keeps trusted-host HMAC on and binds the terminal proxy to loopback', () => {
    const ipcCall = region(daemonSource, 'await startIpcServer({', '});');
    expect(ipcCall).toMatch(/\bauthRequired:\s*true\b/);
    expect(ipcCall).toMatch(/\bcoreOnlyPublicRoutes:\s*coreOnly\b/);
    expect(daemonSource).toMatch(/const terminalProxyHost\s*=\s*coreOnly\s*\?\s*'127\.0\.0\.1'/);
    expect(region(daemonSource, 'await startTerminalProxy({', 'resolvePort')).toMatch(/\bhost:\s*terminalProxyHost\b/);
  });

  // 源码结构护栏(K3)：core-only 与 fleet 可能共用同一 HOME；下列动作都在 daemon 闭包 / writePidFile 里，没有 seam。
  // 不变量：core-only 不跑宿主级维护（全局 update + detached restart 会拆掉整个 fleet）、不跑会改写 fleet bots.json
  // 的沙箱迁移、不改写共享 HOME 的 ~/.botmux/.data-dir；就绪闸门在 bind 前布防、session 恢复后才放行，
  // ready 行（riff 解析的契约）只在放行后打印——否则 trigger 会撞上未完成的持久恢复而重发。来历：#668 codex P1 第 2/3 轮、P1-3。
  it('core-only daemon never touches fleet-wide host state and holds triggers until restore completes', () => {
    expect(daemonSource).toMatch(/if \(process\.env\.BOTMUX_CORE_ONLY !== '1'\) \{\s*await migrateSandboxConfigAtStartup\(\);/);
    const maintenance = braceBlock(daemonSource, 'if (idx === 0 && !coreOnly) {');
    for (const call of ['startMaintenance(', 'startCliRuntimeUpdateMonitor(', 'sendRestartReportIfPending(']) {
      expect(maintenance, call).toContain(call);
    }
    const breadcrumbGuard = braceBlock(braceBlock(daemonSource, 'function writePidFile('), "BOTMUX_CORE_ONLY !== '1'");
    expect(breadcrumbGuard).toContain("'.data-dir'");

    const armAt = daemonSource.indexOf('armCoreOnlyReadinessGate()');
    const bindAt = daemonSource.indexOf('await startIpcServer(');
    const restoreAt = daemonSource.indexOf('await restoreSessionsAndScheduleStartupRecovery(');
    const readyAt = daemonSource.indexOf('setCoreOnlyReady()');
    const readyLineAt = daemonSource.indexOf('[core-only] listening on ');
    expect(armAt).toBeGreaterThan(0);
    expect(bindAt).toBeGreaterThan(armAt);
    expect(restoreAt).toBeGreaterThan(bindAt);
    expect(readyAt).toBeGreaterThan(restoreAt);
    expect(readyLineAt).toBeGreaterThan(readyAt);
  });

  // 源码结构护栏(K1)：wrapper bin 目录只能有一个解析口（resolveBotmuxWrapperBinDir，行为见 botmux-wrapper.test.ts）；
  // 消费方分散在 worker / worker-pool / 三个持久后端里，绕开解析口硬编码 ~/.botmux/bin 会让 core-only 会话的
  // `botmux` 命中 fleet 的 wrapper。来历：#668 codex P1 第 4 轮。
  it('every botmux wrapper PATH consumer resolves the bin dir through the single resolver', () => {
    const sharedBinJoin = /['"]\.botmux['"]\s*,\s*['"]bin['"]/;
    for (const file of ['src/worker.ts', 'src/core/worker-pool.ts', 'src/daemon.ts']) {
      const src = stripLineComments(read(file));
      expect(src, file).toContain('resolveBotmuxWrapperBinDir(');
      expect(src, file).not.toMatch(sharedBinJoin);
    }
    for (const file of [
      'src/adapters/backend/tmux-pipe-backend.ts',
      'src/adapters/backend/zellij-backend.ts',
      'src/adapters/backend/zmx-backend.ts',
    ]) {
      const src = read(file);
      expect(src, file).toMatch(/resolveBotmuxWrapperBinDir\(\s*opts\.env\s*\?\?\s*process\.env\s*\)/);
      expect(src, file).toContain('shellWrapperScript(');
    }
    const script = shellWrapperScript('/srv/core-only/data/bin');
    expect(script).toContain('/srv/core-only/data/bin');
    expect(script).not.toContain('.botmux/bin');
  });

  // 源码结构护栏(K2)：trusted caller 的 senderType 是消费方区分「真人」与「bot 自触发」的唯一依据（数据库账号映射、
  // 审批门、审计归属都靠它）；五个 IM 入口（三个 inline + queue + ask）加卡片点击入口，经 trustedCallerForInboundTurn
  // 包装、dispatch launch 仍走 trustedCallerForTurn，都在 daemon 闭包里没有 seam。不变量：inline IM 入口一律经
  // senderIsBotTriState（含 cross-ref 外部 bot 信号）推导，绝不用裸 sender_type 比较把 peer bot 写成 'user'；
  // queue/ask 只能转发同帧早先算好的三态局部量；dispatch launch 把直接触发者标成 bot，且 callerUnionId 证词绝不喂给
  // evaluateBotTalk。来历：#1145、#2039。
  it('every trusted caller stamps a tri-state sender type and never vouches for a bot as a person', () => {
    const inbound = callArgs(daemonSource, 'trustedCallerForInboundTurn');
    expect(inbound).toHaveLength(6);
    // The card-click entry has no platform sender_type. It must pass the
    // card-click predicate (peer cross-ref, identity-cache bot/app, and the
    // three union-id bot tables) rather than a literal false, which would
    // vouch a team bot as a person.
    const cardEntries = inbound.filter(args => /cardClickOperatorIsBotOrApp\(/.test(args[3] ?? ''));
    expect(cardEntries).toHaveLength(1);
    expect(cardEntries[0]![3]).not.toMatch(/\bfalse\b/);
    const cardPredicate = read('src/services/card-click-turn-bind.ts');
    const predicateStart = cardPredicate.indexOf('export function cardClickOperatorIsBotOrApp');
    const predicate = cardPredicate.slice(predicateStart, cardPredicate.indexOf('export function createCardClickTurnBinder', predicateStart));
    expect(predicate).toContain('isKnownPeerBot(');
    expect(predicate).toContain("type === 'bot'");
    expect(predicate).toContain("type === 'app'");
    expect(predicate).toContain('isTeamBot(');
    expect(predicate).toContain('isPlatformTeamBot(');
    expect(predicate).toContain('isTrustedSameOwnerSiblingBot(');
    const humanEntries = inbound.filter(args => !/cardClickOperatorIsBotOrApp\(/.test(args[3] ?? ''));
    expect(humanEntries).toHaveLength(5);
    // Three inline IM entries (new topic, principal-lane proposer, thread
    // reply) name parsed.senderType and the cross-ref foreign-bot leg at the
    // call site. The (?!false) lookahead rejects downgrading any single site
    // to a literal, which would vouch a peer bot as a person.
    const inlineEntries = humanEntries.filter(args => args.some(a => /\bparsed\.senderType\b/.test(a)));
    expect(inlineEntries).toHaveLength(3);
    for (const args of inlineEntries) {
      expect(args[3], args.join(', ')).toMatch(/^senderIsBotTriState\(\s*parsed\.senderType\s*,\s*(?!false\b)\w+/);
    }
    // The queue and ask sites forward a tri-state value computed earlier in
    // the same frame; pin the local names so a boolean literal goes red.
    const precomputedEntries = humanEntries.filter(args => !args.some(a => /\bparsed\.senderType\b/.test(a)));
    expect(precomputedEntries).toHaveLength(2);
    for (const args of precomputedEntries) {
      expect(args[3], args.join(', ')).toMatch(/^(?:senderIsBot|byType)$/);
    }
    for (const args of inbound) {
      expect(args[3] ?? '', args.join(', ')).not.toMatch(/isBotSenderType|senderType\s*===/);
    }
    const calls = callArgs(daemonSource, 'trustedCallerForTurn');
    for (const args of calls) {
      expect(args[3] ?? '', args.join(', ')).not.toMatch(/isBotSenderType|senderType\s*===/);
    }
    const dispatch = calls.filter(args => args.some(a => /callerUnionId/.test(a)));
    expect(dispatch).toHaveLength(1);
    expect(dispatch[0][3]).toBe('true');
    for (const args of callArgs(daemonSource, 'evaluateBotTalk')) {
      expect(args.join(', ')).not.toMatch(/callerUnionId/);
    }
  });

  // 源码结构护栏(K2)：worker 组装 no-transport 沙箱策略上下文的代码在 worker.ts 闭包里；fs-policy.test.ts 只测纯函数，
  // 手喂权威根，删掉 worker 侧的冻结仍全绿。不变量：buildFsPolicy 拿到配置根 + 冻结的默认 ~/.botmux（.dashboard-secret
  // 所在）+ daemon 冻结的实际 bots.json 路径；策略构建失败一律中止 spawn，绝不回落到无约束运行。来历：#668 codex P1/P2。
  it('worker builds the no-transport fs policy from host-frozen authority roots and aborts the spawn when it cannot', () => {
    const ctx = braceBlock(workerSource, 'const fsPolicyCtx = {');
    expect(ctx).toMatch(/\bbotmuxHome:[^,\n]*\bdataDir\b/);
    expect(ctx).toMatch(/\bdefaultBotmuxHome:[^,\n]*\bdefaultBotmuxHome\b/);
    expect(ctx).toMatch(/\bloadedBotsConfigPath:[^\n]*\bcfg\.loadedBotsConfigPath\b/);
    const policy = braceBlock(workerSource, 'const policy = (() => {');
    expect(policy).toContain('buildFsPolicy(fsPolicyCtx)');
    const onFailure = policy.slice(policy.indexOf('catch'));
    expect(onFailure).toMatch(/\bthrow\b/);
    expect(onFailure).not.toMatch(/\breturn\b/);
  });

  // 源码结构护栏(K2)：riff 后端的 env 合并在 worker.ts 闭包里，backendConfig.env 最后合并且不做净化。不变量：合并之后
  // 重新冻结 no-transport 键（删 BOTMUX_LARK_APP_SECRET、钉 BOTMUX_API_ONLY / BOTMUX_CHAT_ID），配置无法恢复发送能力。
  // 与 owner env 合并后冻结同一模式。来历：#668 codex 复审。
  it('riff env re-freezes the no-transport keys after the backend env merge', () => {
    const start = workerSource.indexOf('const mergedEnv');
    const merge = workerSource.slice(start, workerSource.indexOf('riffBackendConfig = Object.assign(', start));
    expect(start).toBeGreaterThan(-1);
    expect(merge).toMatch(/\.\.\.riffCfg\.env/);
    expect(merge).toContain('delete mergedEnv.BOTMUX_LARK_APP_SECRET');
    expect(merge).toMatch(/mergedEnv\.BOTMUX_API_ONLY\s*=\s*'1'/);
    expect(merge).toMatch(/mergedEnv\.BOTMUX_CHAT_ID\s*=\s*cfg\.chatId/);
  });

  // 源码结构护栏(K2/K3)：持久 pane 的复用判定与有序副作用已抽成纯函数（read-isolation.test.ts 行为覆盖），但「worker
  // 真的走这两个函数、守卫覆盖残留证明、晚到 pane 按精确目标拆除」的接线在 worker.ts 闭包里。不变量：残留 marker /
  // tombstone 也进入守卫（否则重开沙箱会把未隔离的新 pane 当成已隔离复用）；policy-ON 的 PENDING 证明写失败在 spawn
  // 前抛错；拆除走 persistentTeardownKillKind（herdr 共享宿主会话按名字杀会拆掉所有 bot 的 agent）。来历：#899。
  it('persistent-pane reuse is decided and torn down through the behaviour-tested read-isolation helpers', () => {
    expect(workerSource).toContain('evaluatePersistentPaneMigration({');
    expect(workerSource).toMatch(/executePersistentPaneMigration\(\s*migration\s*,/);
    const guard = workerSource.slice(workerSource.indexOf('const persistentPaneGuardApplies'));
    const guardExpr = guard.slice(0, guard.indexOf(';'));
    expect(guardExpr).toContain('stalePaneMarkerPresent');
    expect(guardExpr).toContain('policyOffTombstonePresent');
    const pendingWrite = region(workerSource,
      'if (appliedIsolationCapabilities.length > 0 && persistentSessionName && !willReattachPersistent) {',
      '} else if (');
    expect(pendingWrite).toMatch(/catch\s*\(\w*\)\s*\{\s*throw\b/);
    const commit = braceBlock(workerSource, 'if (pendingProvenanceCommit) {');
    expect(commit).toContain('persistentTeardownKillKind(');
    expect(commit).toMatch(/if \(actuallyReattachedPersistent\)/);
  });
});

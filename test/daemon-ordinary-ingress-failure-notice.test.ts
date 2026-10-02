/**
 * 普通消息处理链终态失败的可行动提示（ingress failure notice）。
 *
 * transport 已 ACK（用户看到消息发出去了）之后，异常把 handleThreadReply /
 * handleNewTopic 整条投递链掀翻时，此前只剩 event-dispatcher 的 log-only
 * catch——用户视角就是机器人吞消息。本文件驱动真实路由入口断言：
 *   - 投递链异常 → 话题里收到一条可行动提示，且原错误原样重抛（dispatcher
 *     既有日志语义不变）；
 *   - 提示本身发送失败 → 只降级为 warn，原错误仍然重抛，不被通知错误顶掉；
 *   - 正常投递 → 不发提示（无误报）。
 *
 * 提示文案按接纳阶段区分（PR #846 review）：本轮 inbound 已被真正接纳后
 *（durable tail、pendingRepo staging、live worker 收下、fork 成功——注意
 * messageQueue append 不算接纳，queues/*.jsonl 仅供 dashboard 预览），失败
 * 只可能出在接纳之后的状态回复支路——此时绝不能提示「请重发」（重发会让同一
 * 任务再次入队、CLI 重复执行），改回「已接收勿重发」的澄清，且失败处理本身
 * 不得产生第二个队列项。反向约束同样被钉住：refork 抛错、/vc-auth 纯拒绝等
 * 未接纳失败必须保持「请重发」。
 *
 * Run:  pnpm vitest run test/daemon-ordinary-ingress-failure-notice.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

const mocks = vi.hoisted(() => {
  const dataDir = `${process.env.TMPDIR ?? '/tmp'}/botmux-ingress-notice-${process.pid}`;
  process.env.SESSION_DATA_DIR = dataDir;
  process.env.BOTS_CONFIG = `${dataDir}/bots.json`;
  delete process.env.BOTMUX_SESSION_ID;
  delete process.env.BOTMUX_LARK_APP_ID;
  let seq = 0;
  const sessions = new Map<string, any>();
  return {
    dataDir,
    replyMessage: vi.fn(async () => 'om_reply'),
    sendMessage: vi.fn(async () => 'om_top'),
    addReaction: vi.fn(async () => 'reaction_received'),
    getChatMode: vi.fn(async () => 'group' as 'group' | 'topic' | 'p2p'),
    getChatNameAndMode: vi.fn(async () => ({ name: null, mode: 'group' as const })),
    resolveTargetAppOpenId: vi.fn(async (_appId: string, unionId: string) => ({
      status: 'resolved' as const,
      openId: `ou_target_${unionId.slice(3)}`,
    })),
    resolveSender: vi.fn(async (_appId: string, openId: string | undefined, senderType: string | undefined) => (
      openId
        ? { openId, type: senderType === 'app' || senderType === 'bot' ? 'bot' as const : 'user' as const }
        : undefined
    )),
    sessions,
    createSession: vi.fn((chatId: string, rootMessageId: string, title: string, chatType?: 'group' | 'p2p') => {
      const session = {
        sessionId: `sess-fake-${++seq}`,
        chatId,
        rootMessageId,
        title,
        status: 'active' as const,
        createdAt: new Date().toISOString(),
        chatType,
      };
      sessions.set(session.sessionId, session);
      return session;
    }),
    createSessionWithOwnedMutation: vi.fn((input: any, mutate: (fresh: Map<string, any>, draft: any) => unknown) => {
      const draft = {
        sessionId: `sess-fake-${++seq}`,
        chatId: input.chatId,
        rootMessageId: input.rootMessageId,
        title: input.title,
        status: 'active' as const,
        createdAt: new Date().toISOString(),
        chatType: input.chatType,
      };
      const rows = new Map(input.ownedSessionIds.map((id: string) => [id, structuredClone(sessions.get(id))]));
      const result = mutate(rows, draft);
      for (const [id, session] of rows) sessions.set(id, session);
      sessions.set(draft.sessionId, draft);
      return { session: draft, result, rows };
    }),
    updateSession: vi.fn((session: any) => { sessions.set(session.sessionId, session); }),
    getSession: vi.fn((sessionId: string) => sessions.get(sessionId)),
    listSessionsStrict: vi.fn(() => [...sessions.values()]),
    mutateOwnedSessionsAtomically: vi.fn((ids: string[], mutate: (fresh: Map<string, any>) => unknown) => {
      const fresh = new Map(ids.map(id => [id, structuredClone(sessions.get(id))]));
      const result = mutate(fresh);
      for (const [id, session] of fresh) sessions.set(id, session);
      return { result, rows: fresh };
    }),
    closeSession: vi.fn((sessionId: string) => {
      const session = sessions.get(sessionId);
      if (session) session.status = 'closed';
    }),
    forkWorker: vi.fn((ds: any) => {
      ds.worker = { killed: false, send: vi.fn() };
    }),
    scanMultipleProjects: vi.fn(() => [] as any[]),
    getAvailableBots: vi.fn(async () => [] as any[]),
    downloadResources: vi.fn(async () => ({ attachments: [], needLogin: false })),
  };
});

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}));

vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/client.js');
  return {
    ...actual,
    replyMessage: mocks.replyMessage,
    sendMessage: mocks.sendMessage,
    addReaction: mocks.addReaction,
    getChatMode: mocks.getChatMode,
    getChatNameAndMode: mocks.getChatNameAndMode,
    resolveTargetAppOpenId: mocks.resolveTargetAppOpenId,
  };
});

vi.mock('../src/services/session-store.js', async () => {
  const actual = await vi.importActual<any>('../src/services/session-store.js');
  return {
    ...actual,
    createSession: mocks.createSession,
    createSessionWithOwnedMutation: mocks.createSessionWithOwnedMutation,
    updateSession: mocks.updateSession,
    getSession: mocks.getSession,
    getOwnedSession: mocks.getSession,
    listSessionsStrict: mocks.listSessionsStrict,
    mutateOwnedSessionsAtomically: mocks.mutateOwnedSessionsAtomically,
    closeSession: mocks.closeSession,
  };
});

vi.mock('../src/core/worker-pool.js', async () => {
  const actual = await vi.importActual<any>('../src/core/worker-pool.js');
  return { ...actual, forkWorker: mocks.forkWorker };
});

vi.mock('../src/core/session-manager.js', async () => {
  const actual = await vi.importActual<any>('../src/core/session-manager.js');
  return {
    ...actual,
    getAvailableBots: mocks.getAvailableBots,
    downloadResources: mocks.downloadResources,
  };
});

vi.mock('../src/services/project-scanner.js', async () => {
  const actual = await vi.importActual<any>('../src/services/project-scanner.js');
  return { ...actual, scanMultipleProjects: mocks.scanMultipleProjects };
});

vi.mock('../src/im/lark/identity-cache.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/identity-cache.js');
  return { ...actual, resolveSender: (...args: any[]) => mocks.resolveSender(...args) };
});

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { getBot, registerBot } from '../src/bot-registry.js';
import { sessionKey } from '../src/core/types.js';
import * as messageQueue from '../src/services/message-queue.js';
import {
  __testOnly_activeSessions as activeSessions,
  __testOnly_completedTurnHasCrossPrincipalFollower as completedTurnHasCrossPrincipalFollower,
  __testOnly_handleNewTopic as handleNewTopic,
  __testOnly_handleThreadReply as handleThreadReply,
  __testOnly_driveCrossPrincipalInterruptions as driveCrossPrincipalInterruptions,
  __testOnly_forkReservedInitialSession as forkReservedInitialSession,
  __testOnly_notifyCrossPrincipalTerminal as notifyCrossPrincipalTerminal,
  __testOnly_notifyOrdinaryIngressFailure as notifyOrdinaryIngressFailure,
  __testOnly_recoverProjectTaskControlSeed as recoverProjectTaskControlSeed,
  __testOnly_resolveXpiHumanOpenId as resolveXpiHumanOpenId,
  __testOnly_restoreSessionsAndScheduleStartupRecovery as restoreSessionsAndScheduleStartupRecovery,
  __testOnly_terminalizeProjectTaskControlTurnAdmission as terminalizeProjectTaskControlTurnAdmission,
  awaitProjectTaskControlInboundAdmission,
  awaitProjectTaskControlPhaseAInstruction,
  deliverProjectTaskControlPhaseAInstruction,
  deliverProjectTaskControlKickoff,
} from '../src/daemon.js';
import {
  beginTaskControlSeedOperationSync,
  readTaskControlSeedOperation,
} from '../src/core/dispatch-registry.js';
import { XpiSharedCwdQueueFullError } from '../src/core/xpi-shared-cwd-admission.js';
import {
  findPendingAskByAnchor,
  setCardDispatcher,
  setCanTalkChecker,
  tryResolveAsk,
} from '../src/core/ask-broker.js';
import { createLarkAskCardDispatcher } from '../src/im/lark/ask-card.js';
import { t as tr, localeForBot } from '../src/i18n/index.js';
import type { DaemonSession } from '../src/core/types.js';
import {
  projectTaskControlCanaryAbandonedRecord,
  projectTaskControlCanaryFenceFingerprint,
  projectTaskControlCanaryFenceRecord,
} from '../src/services/project-group-store.js';

const APP = 'ingress_notice_app';
const CHAT = 'oc_ingress_notice_chat';
const OWNER = 'ou_owner';
const NOW = new Date().toISOString();

function makeEventData(messageId: string, text: string, rootId?: string): any {
  return {
    sender: { sender_id: { open_id: OWNER }, sender_type: 'user' },
    message: {
      message_id: messageId,
      root_id: rootId,
      chat_id: CHAT,
      message_type: 'text',
      content: JSON.stringify({ text }),
      create_time: String(Date.now()),
    },
  };
}

function makeBotEventData(messageId: string, text: string, rootId: string): any {
  return {
    sender: {
      sender_id: { open_id: 'ou_proposer_bot', union_id: 'on_proposer_bot' },
      sender_type: 'app',
    },
    message: {
      message_id: messageId,
      root_id: rootId,
      chat_id: CHAT,
      message_type: 'text',
      content: JSON.stringify({ text }),
      create_time: String(Date.now()),
    },
  };
}

function makeCtx(anchor: string, messageId: string): any {
  return {
    chatId: CHAT,
    messageId,
    chatType: 'group' as const,
    scope: 'thread' as const,
    anchor,
    larkAppId: APP,
  };
}

function seedThreadSession(anchor: string, title: string): DaemonSession {
  const ds = {
    scope: 'thread',
    chatId: CHAT,
    chatType: 'group',
    larkAppId: APP,
    worker: null,
    workerPort: null,
    workerToken: null,
    spawnedAt: Date.now(),
    cliVersion: '1.0.0',
    lastMessageAt: Date.now(),
    hasHistory: false,
    ownerOpenId: OWNER,
    session: {
      sessionId: 'sess-seeded-' + Math.random().toString(36).slice(2),
      chatId: CHAT,
      rootMessageId: anchor,
      title,
      status: 'active',
      createdAt: NOW,
      larkAppId: APP,
    },
  } as unknown as DaemonSession;
  activeSessions.set(sessionKey(anchor, APP), ds);
  return ds;
}

function writeAbandonedTaskControlFixture(options: { legacy?: boolean } = {}) {
  mkdirSync(mocks.dataDir, { recursive: true });
  const dispatchRoot = 'om_abandoned_canary_root';
  const operationId = 'c'.repeat(50);
  const taskGuid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const purpose = 'abandoned canary must stay isolated';
  const instructionTemplate = 'frozen abandoned Phase A instruction';
  const failedReportContent = 'frozen abandoned Phase A failure';
  const fence = {
    dispatchOperationId: operationId, taskGuid,
    coordinatorSessionId: 'session_controller', originTurnId: 'om_authorized_turn',
    authorizationRef: 'om_authorized_turn', authorizedByOpenId: 'ou_controller', planSha256: 'c'.repeat(64),
    controllerAppId: 'cli_controller', workerAppId: 'cli_worker', reviewerAppId: 'cli_reviewer',
    acceptorAppId: 'cli_acceptor', targetChatId: CHAT,
    targetAppIds: ['cli_worker', 'cli_reviewer'], writeScopes: [mocks.dataDir],
    title: 'abandoned canary', purpose, owners: ['Worker', 'Reviewer'],
    botOpenIds: ['ou_worker', 'ou_reviewer'], acceptanceRequested: true,
    seedText: 'frozen abandoned seed', taskControlMode: 'audit_only' as const,
    kickoff: {
      templateVersion: 'TaskControlKickoff.v1' as const, rootPlaceholder: '{{dispatchRoot}}' as const,
      brief: purpose, briefSha256: createHash('sha256').update(purpose).digest('hex'),
      bots: [
        { appId: 'cli_worker', openId: 'ou_worker', displayName: 'Worker', role: 'worker' as const },
        { appId: 'cli_reviewer', openId: 'ou_reviewer', displayName: 'Reviewer', role: 'reviewer' as const },
      ],
    },
    phaseA: {
      historicalDispatchRoot: 'om_abandoned_historical',
      historicalTaskGuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      mappedWorkerAppId: 'cli_historical_worker', failedReportContent,
      failedReportSha256: createHash('sha256').update(failedReportContent).digest('hex'),
      instructionTemplateVersion: 'TaskControlPhaseAInstruction.v1' as const,
      instructionTemplate,
      instructionTemplateSha256: createHash('sha256').update(instructionTemplate).digest('hex'),
    },
  };
  const tombstone = projectTaskControlCanaryAbandonedRecord(fence, {
    authorizationRef: 'om_abandon', authorizedByOpenId: 'ou_controller', abandonedAt: NOW,
    ...(options.legacy ? {} : { phaseBDispatchRoot: dispatchRoot }),
  } as any, NOW);
  writeFileSync(`${mocks.dataDir}/project-groups.json`, JSON.stringify({
    schemaVersion: 3,
    projects: {
      [CHAT]: {
        schemaVersion: 3, revision: 4, chatId: CHAT, larkAppId: fence.controllerAppId,
        coordinatorSessionId: fence.coordinatorSessionId, title: '项目', goal: '验证 abandoned 隔离',
        phase: '执行', focus: 'abandoned', status: 'active', blockers: [tombstone.summary],
        blockerRecords: [tombstone],
        workstreams: [{
          dispatchRoot, title: fence.title, purpose, owners: fence.owners,
          targetAppIds: fence.targetAppIds, workerAppIds: [fence.workerAppId],
          reviewerAppIds: [fence.reviewerAppId], access: { mode: 'write', scopes: fence.writeScopes },
          status: 'in_progress', progress: 40, createdAt: NOW, updatedAt: NOW,
          taskControl: {
            taskGuid, phaseId: `workstream:${taskGuid}`, mappingRef: `topic-message:${dispatchRoot}`,
            mappingStatus: 'registered', sourceKind: 'project_group', controllerAppId: fence.controllerAppId,
            workerAppId: fence.workerAppId, reviewerAppId: fence.reviewerAppId,
            acceptorAppId: fence.acceptorAppId, projectRevision: 3, reservationId: operationId,
            coordinatorSessionId: fence.coordinatorSessionId, originTurnId: fence.originTurnId,
            reservationCreatedAt: NOW, reservationExpiresAt: '2099-09-30T00:02:00.000Z', rootCreateTime: NOW,
            reservationProof: {
              schemaVersion: 'ProjectDispatchReservationProof.v1', larkAppId: fence.controllerAppId,
              issuedAt: NOW, keyId: 'tcpr1:abandoned', signature: 'c'.repeat(64),
            },
          },
        }],
        completionGates: [], dispatchReservations: [], milestones: [], createdAt: NOW, updatedAt: NOW,
      },
    },
  }));
  writeFileSync(`${mocks.dataDir}/orchestrate-dispatch.json`, JSON.stringify({
    [dispatchRoot]: {
      dispatchOperationId: operationId, targetAppIds: fence.targetAppIds,
      taskControl: { mode: 'audit_only', taskGuid },
    },
  }));
  return { dispatchRoot, operationId, fence };
}

/** All text replied through the mocked Lark client in this test, joined. */
function repliedText(): string {
  return [...mocks.replyMessage.mock.calls, ...mocks.sendMessage.mock.calls]
    .map(call => String(call[2] ?? ''))
    .join('\n');
}

function expectedNotice(): string {
  return tr('daemon.ordinary_ingress_failed', undefined, localeForBot(APP));
}

describe('TaskControl seed audit recovery', () => {
  const operationId = 'a'.repeat(50);
  const sourceAppId = 'cli_coordinator';
  const targetChatId = 'oc_project';
  const seedText = 'frozen seed';
  const payloadHash = createHash('sha256').update(seedText).digest('hex');

  function pendingSeed(registryPath: string) {
    return beginTaskControlSeedOperationSync(registryPath, {
      operationId,
      sourceAppId,
      targetChatId,
      messageType: 'text',
      payloadHash,
      attempt: {
        wallTime: '2026-09-30T00:00:00.000Z',
        bootId: 'boot-1',
        processStartIdentity: 'process-start-1',
        monotonicMs: 10_000,
      },
    });
  }

  beforeEach(() => {
    rmSync(mocks.dataDir, { recursive: true, force: true });
    mkdirSync(mocks.dataDir, { recursive: true });
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockResolvedValue('om_recovered_seed');
  });

  it('reuses the persisted provider UUID after provider acceptance but before journal completion', async () => {
    const registryPath = `${mocks.dataDir}/orchestrate-dispatch.json`;
    const pending = pendingSeed(registryPath);

    await expect(recoverProjectTaskControlSeed({
      registryPath, operationId, sourceAppId, targetChatId, seedText,
      attempt: {
        wallTime: '2026-09-30T00:53:59.999Z',
        bootId: 'boot-1',
        processStartIdentity: 'process-start-1',
        monotonicMs: 3_249_999,
      },
    })).resolves.toEqual({ state: 'delivered', dispatchRoot: 'om_recovered_seed' });

    expect(mocks.sendMessage).toHaveBeenCalledWith(
      sourceAppId, targetChatId, seedText, 'text', pending.providerUuid,
      undefined, expect.objectContaining({ timeoutMs: 5_000 }),
    );
    expect(readTaskControlSeedOperation(registryPath, operationId)).toMatchObject({
      state: 'delivered', dispatchRoot: 'om_recovered_seed', providerUuid: pending.providerUuid,
    });
  });

  it('marks restart recovery ambiguous without sending again', async () => {
    const registryPath = `${mocks.dataDir}/orchestrate-dispatch.json`;
    const pending = pendingSeed(registryPath);

    await expect(recoverProjectTaskControlSeed({
      registryPath, operationId, sourceAppId, targetChatId, seedText,
      attempt: {
        wallTime: '2026-09-30T00:00:01.000Z',
        bootId: 'boot-1',
        processStartIdentity: 'process-start-2',
        monotonicMs: 1,
      },
    })).resolves.toEqual({ state: 'ambiguous' });

    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(readTaskControlSeedOperation(registryPath, operationId)).toEqual({
      ...pending, state: 'ambiguous',
    });
  });

  it('treats the exact 54 minute boundary as ambiguous without sending again', async () => {
    const registryPath = `${mocks.dataDir}/orchestrate-dispatch.json`;
    pendingSeed(registryPath);

    await expect(recoverProjectTaskControlSeed({
      registryPath, operationId, sourceAppId, targetChatId, seedText,
      attempt: {
        wallTime: '2026-09-30T00:54:00.000Z',
        bootId: 'boot-1',
        processStartIdentity: 'process-start-1',
        monotonicMs: 3_250_000,
      },
    })).resolves.toEqual({ state: 'ambiguous' });

    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });
});

describe('completed-turn XPI progression', () => {
  it('uses the durable owner turn even after the active-turn mirror was revoked', () => {
    const ds = seedThreadSession('om_thread_xpi_terminal_progress', 'seeded') as any;
    ds.activeInteractiveTurn = undefined;
    ds.session.crossPrincipalInterruptions = [{
      version: 1,
      id: 'xpi_terminal_progress_123456',
      ownerTurnId: 'owner-turn',
      owner: { requestLarkAppId: APP, requestUserOpenId: OWNER, senderType: 'user' },
      proposer: { requestLarkAppId: APP, requestUserOpenId: 'ou_b', senderType: 'user' },
      phase: 'awaiting_owner',
      messages: [],
    }];

    expect(completedTurnHasCrossPrincipalFollower(ds, {
      turnId: 'owner-turn',
      status: 'completed',
    })).toBe(true);
    expect(completedTurnHasCrossPrincipalFollower(ds, {
      turnId: 'stale-turn',
      status: 'completed',
    })).toBe(false);
    ds.session.crossPrincipalInterruptions[0].phase = 'owner_approved';
    expect(completedTurnHasCrossPrincipalFollower(ds, {
      turnId: 'later-owner-turn',
      status: 'completed',
    })).toBe(true);
    expect(completedTurnHasCrossPrincipalFollower(ds, {
      turnId: 'owner-turn',
      status: 'failed',
    })).toBe(false);
  });
});

describe('ordinary ingress terminal failure → actionable notice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.replyMessage.mockResolvedValue('om_reply');
    mocks.sendMessage.mockResolvedValue('om_top');
    mocks.getChatMode.mockResolvedValue('group');
    mocks.getChatNameAndMode.mockResolvedValue({ name: null, mode: 'group' });
    mocks.resolveTargetAppOpenId.mockImplementation(async (_appId: string, unionId: string) => ({
      status: 'resolved' as const,
      openId: `ou_target_${unionId.slice(3)}`,
    }));
    mocks.sessions.clear();
    mocks.forkWorker.mockReset();
    mocks.forkWorker.mockImplementation((ds: any) => {
      ds.worker = { killed: false, send: vi.fn() };
    });
    mocks.scanMultipleProjects.mockReturnValue([]);
    mocks.getAvailableBots.mockResolvedValue([]);
    mocks.downloadResources.mockResolvedValue({ attachments: [], needLogin: false });
    activeSessions.clear();
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: [OWNER],
    });
    bot.resolvedAllowedUsers = [OWNER];
  });

  it('thread reply delivery failure replies with the notice and rethrows the original error', async () => {
    const anchor = 'om_thread_root';
    seedThreadSession(anchor, 'seeded');
    mocks.downloadResources.mockRejectedValue(new Error('boom: durable store offline'));

    await expect(
      handleThreadReply(makeEventData('om_msg_1', 'hello world', anchor), makeCtx(anchor, 'om_msg_1')),
    ).rejects.toThrow('boom: durable store offline');

    expect(repliedText()).toContain(expectedNotice());
  });

  it('a failing notice never masks the original delivery error', async () => {
    const anchor = 'om_thread_root_2';
    seedThreadSession(anchor, 'seeded');
    mocks.downloadResources.mockRejectedValue(new Error('boom: original failure'));
    mocks.replyMessage.mockRejectedValue(new Error('lark transport down'));
    mocks.sendMessage.mockRejectedValue(new Error('lark transport down'));

    await expect(
      handleThreadReply(makeEventData('om_msg_2', 'hello again', anchor), makeCtx(anchor, 'om_msg_2')),
    ).rejects.toThrow('boom: original failure');
  });

  it('new topic delivery failure replies with the notice and rethrows', async () => {
    mocks.downloadResources.mockRejectedValue(new Error('boom: new topic ingest'));

    await expect(
      handleNewTopic(makeEventData('om_msg_3', 'start a task'), makeCtx('om_msg_3', 'om_msg_3')),
    ).rejects.toThrow('boom: new topic ingest');

    expect(repliedText()).toContain(expectedNotice());
  });

  it('successful delivery sends no failure notice', async () => {
    const anchor = 'om_thread_root_3';
    const ds = seedThreadSession(anchor, 'seeded');
    (ds as any).worker = { killed: false, send: vi.fn() };

    await handleThreadReply(makeEventData('om_msg_4', 'all good'), makeCtx(anchor, 'om_msg_4'));

    expect(repliedText()).not.toContain(expectedNotice());
  });

  it('reports a full shared-cwd queue as not accepted without marking ingress admitted', async () => {
    const ctx = makeCtx('om_thread_queue_full', 'om_msg_queue_full');
    ctx.ingressAdmission = { admitted: false };
    const error = new XpiSharedCwdQueueFullError('sess-full');

    await expect(notifyOrdinaryIngressFailure(ctx, error)).rejects.toBe(error);

    expect(ctx.ingressAdmission.admitted).toBe(false);
    expect(repliedText()).toContain(tr('daemon.xpi_shared_cwd_queue_full', undefined, localeForBot(APP)));
  });

  it('terminalises historical XPI records without notifying when the switch is off', async () => {
    const previousXpi = process.env.BOTMUX_XPI_ENABLED;
    process.env.BOTMUX_XPI_ENABLED = 'false';
    const ds = seedThreadSession('om_thread_xpi_disabled', 'seeded') as any;
    ds.session.crossPrincipalInterruptions = [{
      version: 1,
      id: 'xpi_cccccccccccccccccccccccc',
      ownerTurnId: 'owner-turn',
      owner: { requestLarkAppId: APP, requestUserOpenId: OWNER, senderType: 'user' as const },
      proposer: { requestLarkAppId: APP, requestUserOpenId: 'ou_proposer', senderType: 'bot' as const },
      phase: 'awaiting_classification',
      messages: [{
        turnId: 'proposer-turn',
        text: 'historical input',
        userPrompt: 'historical input',
        createdAt: NOW,
      }],
    }];
    mocks.sessions.set(ds.session.sessionId, ds.session);

    try {
      await driveCrossPrincipalInterruptions(ds);
    } finally {
      if (previousXpi === undefined) delete process.env.BOTMUX_XPI_ENABLED;
      else process.env.BOTMUX_XPI_ENABLED = previousXpi;
    }

    expect(ds.session.crossPrincipalInterruptions).toBeUndefined();
    expect(ds.session.crossPrincipalInterruptionCancellations).toEqual([
      expect.objectContaining({
        id: 'xpi_cccccccccccccccccccccccc',
        reason: 'feature_disabled',
        messageTurnIds: ['proposer-turn'],
      }),
    ]);
    expect(repliedText()).toBe('');
  });

  it('cancels the pending XPI wait timer when the switch is disabled', async () => {
    const previousXpi = process.env.BOTMUX_XPI_ENABLED;
    process.env.BOTMUX_XPI_ENABLED = 'false';
    vi.useFakeTimers();
    const timerFired = vi.fn();
    const ds = seedThreadSession('om_thread_xpi_timer_disabled', 'seeded') as any;
    ds.session.crossPrincipalInterruptions = [{
      version: 1,
      id: 'xpi_dddddddddddddddddddddddd',
      ownerTurnId: 'owner-turn',
      owner: { requestLarkAppId: APP, requestUserOpenId: OWNER, senderType: 'user' as const },
      proposer: { requestLarkAppId: APP, requestUserOpenId: 'ou_proposer', senderType: 'bot' as const },
      phase: 'owner_waiting',
      messages: [{
        turnId: 'proposer-turn',
        text: 'historical input',
        userPrompt: 'historical input',
        createdAt: NOW,
      }],
    }];
    ds.crossPrincipalWaitTimer = setTimeout(timerFired, 1_000);
    mocks.sessions.set(ds.session.sessionId, ds.session);

    try {
      await driveCrossPrincipalInterruptions(ds);
      expect(ds.crossPrincipalWaitTimer).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(timerFired).not.toHaveBeenCalled();
      expect(repliedText()).toBe('');
    } finally {
      if (ds.crossPrincipalWaitTimer) clearTimeout(ds.crossPrincipalWaitTimer);
      vi.useRealTimers();
      if (previousXpi === undefined) delete process.env.BOTMUX_XPI_ENABLED;
      else process.env.BOTMUX_XPI_ENABLED = previousXpi;
    }
  });

  it('terminalises an unclassified legacy bot message without publishing a control marker', async () => {
    const previousXpi = process.env.BOTMUX_XPI_ENABLED;
    process.env.BOTMUX_XPI_ENABLED = 'true';
    const ds = seedThreadSession('om_thread_xpi_legacy_bot', 'seeded') as any;
    ds.session.crossPrincipalInterruptions = [{
      version: 1,
      id: 'xpi_eeeeeeeeeeeeeeeeeeeeeeee',
      ownerTurnId: 'owner-turn',
      owner: { requestLarkAppId: APP, requestUserOpenId: OWNER, senderType: 'user' as const },
      proposer: { requestLarkAppId: APP, requestUserOpenId: 'ou_proposer_bot', senderType: 'bot' as const },
      phase: 'awaiting_classification',
      messages: [{
        turnId: 'proposer-turn',
        text: 'bot input',
        userPrompt: 'bot input',
        createdAt: NOW,
      }],
    }];
    mocks.sessions.set(ds.session.sessionId, ds.session);

    try {
      await driveCrossPrincipalInterruptions(ds);
    } finally {
      if (previousXpi === undefined) delete process.env.BOTMUX_XPI_ENABLED;
      else process.env.BOTMUX_XPI_ENABLED = previousXpi;
    }

    expect(ds.session.crossPrincipalInterruptions).toBeUndefined();
    expect(repliedText()).toBe('');
    expect(repliedText()).not.toContain('[botmux-xpi-control:');
    expect(repliedText()).not.toContain('ou_proposer_bot');
  });

  it('terminalises an expired bot wait without publishing a wait marker', async () => {
    const previousXpi = process.env.BOTMUX_XPI_ENABLED;
    process.env.BOTMUX_XPI_ENABLED = 'true';
    const ds = seedThreadSession('om_thread_xpi_legacy_bot_wait', 'seeded') as any;
    ds.activeInteractiveTurn = {
      turnId: 'owner-turn',
      caller: { requestLarkAppId: APP, requestUserOpenId: OWNER, senderType: 'user' as const },
    };
    ds.session.crossPrincipalInterruptions = [{
      version: 1,
      id: 'xpi_ffffffffffffffffffffffff',
      ownerTurnId: 'owner-turn',
      owner: { requestLarkAppId: APP, requestUserOpenId: OWNER, senderType: 'user' as const },
      proposer: { requestLarkAppId: APP, requestUserOpenId: 'ou_proposer_bot', senderType: 'bot' as const },
      phase: 'awaiting_owner',
      ownerWaitDeadlineAt: Date.now() - 1,
      messages: [{
        turnId: 'proposer-turn',
        text: 'bot input',
        userPrompt: 'bot input',
        createdAt: NOW,
      }],
    }];
    mocks.sessions.set(ds.session.sessionId, ds.session);

    try {
      await driveCrossPrincipalInterruptions(ds);
    } finally {
      if (previousXpi === undefined) delete process.env.BOTMUX_XPI_ENABLED;
      else process.env.BOTMUX_XPI_ENABLED = previousXpi;
    }

    expect(ds.session.crossPrincipalInterruptions).toBeUndefined();
    expect(repliedText()).toBe('');
    expect(repliedText()).not.toContain('[botmux-xpi-control:');
    expect(repliedText()).not.toContain('ou_proposer_bot');
  });

  it('applies a visible upfront bot choice without publishing a classification prompt', async () => {
    const previousXpi = process.env.BOTMUX_XPI_ENABLED;
    process.env.BOTMUX_XPI_ENABLED = 'true';
    const anchor = 'om_thread_xpi_upfront_choice';
    const ds = seedThreadSession(anchor, 'seeded') as any;
    // Let this authenticated peer pass the ordinary talk/quota gate so the
    // integration case reaches the XPI diversion boundary.
    getBot(APP).resolvedAllowedUsers.push('ou_proposer_bot');
    ds.worker = { killed: false, send: vi.fn() };
    ds.activeInteractiveTurn = {
      turnId: 'owner-turn',
      caller: { requestLarkAppId: APP, requestUserOpenId: OWNER, senderType: 'user' as const },
      userPrompt: 'owner clean prompt',
    };
    ds.lastUserPrompt = '<quote_context>transport wrapper</quote_context>\nowner clean prompt';

    try {
      await handleThreadReply(
        makeBotEventData(
          'om_bot_choice',
          '请把这项工作留给当前任务\n[botmux-as:v1:suggestion]',
          anchor,
        ),
        makeCtx(anchor, 'om_bot_choice'),
      );
    } finally {
      if (ds.crossPrincipalWaitTimer) clearTimeout(ds.crossPrincipalWaitTimer);
      ds.crossPrincipalWaitTimer = undefined;
      if (previousXpi === undefined) delete process.env.BOTMUX_XPI_ENABLED;
      else process.env.BOTMUX_XPI_ENABLED = previousXpi;
    }

    expect(ds.session.crossPrincipalInterruptions).toEqual([
      expect.objectContaining({
        phase: 'awaiting_owner',
        ownerUserPrompt: 'owner clean prompt',
      }),
    ]);
    expect(ds.session.crossPrincipalInterruptions[0].messages[0].text)
      .toBe('请把这项工作留给当前任务');
    expect(repliedText()).not.toContain('[botmux-xpi-control:');
    expect(repliedText()).not.toContain('请选择');
  });

  it('creates an independent bot task without addressing the proposer bot in the child root', async () => {
    const previousXpi = process.env.BOTMUX_XPI_ENABLED;
    process.env.BOTMUX_XPI_ENABLED = 'true';
    const anchor = 'om_thread_xpi_bot_independent';
    const ds = seedThreadSession(anchor, 'seeded') as any;
    getBot(APP).resolvedAllowedUsers.push('ou_proposer_bot');
    ds.worker = { killed: false, send: vi.fn() };
    ds.workerGeneration = 1;
    ds.session.workerGeneration = 1;
    ds.workingDir = `${mocks.dataDir}/xpi-independent-non-git`;
    mkdirSync(ds.workingDir, { recursive: true });
    ds.activeInteractiveTurn = {
      turnId: 'owner-turn',
      caller: { requestLarkAppId: APP, requestUserOpenId: OWNER, senderType: 'user' as const },
    };
    mocks.sessions.set(ds.session.sessionId, ds.session);

    try {
      await handleThreadReply(
        makeBotEventData(
          'om_bot_independent_choice',
          '请另开任务处理\n[botmux-as:v1:independent]',
          anchor,
        ),
        makeCtx(anchor, 'om_bot_independent_choice'),
      );
    } finally {
      if (previousXpi === undefined) delete process.env.BOTMUX_XPI_ENABLED;
      else process.env.BOTMUX_XPI_ENABLED = previousXpi;
    }

    const childRootCall = mocks.sendMessage.mock.calls.find(call =>
      String(call[2] ?? '').includes('已为这条独立任务创建隔离话题'));
    expect(childRootCall).toBeDefined();
    expect(String(childRootCall?.[2] ?? '')).not.toContain('<at');
    expect(String(childRootCall?.[2] ?? '')).not.toContain('ou_proposer_bot');
  });

  it('resolves a cross-app human before creating an independent task and stores only the target-app open_id', async () => {
    const previousXpi = process.env.BOTMUX_XPI_ENABLED;
    process.env.BOTMUX_XPI_ENABLED = 'true';
    const ds = seedThreadSession('om_thread_xpi_human_independent', 'seeded') as any;
    ds.workingDir = `${mocks.dataDir}/xpi-human-independent-non-git`;
    mkdirSync(ds.workingDir, { recursive: true });
    ds.session.crossPrincipalInterruptions = [{
      version: 1,
      id: 'xpi_human_independent_1234',
      ownerTurnId: 'owner-turn',
      owner: { requestLarkAppId: APP, requestUserOpenId: OWNER, senderType: 'user' as const },
      proposer: {
        requestLarkAppId: 'foreign-app-observer',
        requestUserOpenId: 'ou_foreign_source_app',
        requestUserUnionId: 'on_proposer',
        senderType: 'user' as const,
      },
      phase: 'preparing_independent',
      messages: [{
        turnId: 'om_human_independent_choice',
        text: '请单独检查这项任务',
        userPrompt: '请单独检查这项任务',
        createdAt: NOW,
      }],
    }];
    mocks.sessions.set(ds.session.sessionId, ds.session);

    try {
      await driveCrossPrincipalInterruptions(ds);
    } finally {
      if (ds.crossPrincipalWaitTimer) clearTimeout(ds.crossPrincipalWaitTimer);
      ds.crossPrincipalWaitTimer = undefined;
      if (previousXpi === undefined) delete process.env.BOTMUX_XPI_ENABLED;
      else process.env.BOTMUX_XPI_ENABLED = previousXpi;
    }

    const childRootCall = mocks.sendMessage.mock.calls.find(call =>
      String(call[2] ?? '').includes('已为这条独立任务创建隔离话题'));
    expect(String(childRootCall?.[2] ?? '')).toContain('<at id=ou_target_proposer></at>');
    expect(String(childRootCall?.[2] ?? '')).not.toContain('ou_foreign_source_app');
    const child = [...mocks.sessions.values()].find((session: any) =>
      session.sessionId !== ds.session.sessionId && session.rootMessageId === 'om_top');
    expect(child).toMatchObject({
      ownerOpenId: 'ou_target_proposer',
      ownerUnionId: 'on_proposer',
      creatorOpenId: 'ou_target_proposer',
      lastCallerOpenId: 'ou_target_proposer',
    });
    expect(child.ownerOpenId).not.toBe('ou_foreign_source_app');
    expect(child.creatorOpenId).not.toBe('ou_foreign_source_app');
    expect(child.lastCallerOpenId).not.toBe('ou_foreign_source_app');
  });

  it('fails a live legacy bot send closed without addressing protocol traffic back to bots', async () => {
    const previousXpi = process.env.BOTMUX_XPI_ENABLED;
    process.env.BOTMUX_XPI_ENABLED = 'true';
    const anchor = 'om_thread_xpi_live_legacy_bot';
    const ds = seedThreadSession(anchor, 'seeded') as any;
    getBot(APP).resolvedAllowedUsers.push('ou_proposer_bot');
    ds.worker = { killed: false, send: vi.fn() };
    ds.activeInteractiveTurn = {
      turnId: 'owner-turn',
      caller: { requestLarkAppId: APP, requestUserOpenId: OWNER, senderType: 'user' as const },
    };

    try {
      await handleThreadReply(
        makeBotEventData('om_legacy_bot_send', '旧版本未声明处理方式', anchor),
        makeCtx(anchor, 'om_legacy_bot_send'),
      );
    } finally {
      if (previousXpi === undefined) delete process.env.BOTMUX_XPI_ENABLED;
      else process.env.BOTMUX_XPI_ENABLED = previousXpi;
    }

    expect(ds.session.crossPrincipalInterruptions).toBeUndefined();
    expect(repliedText()).toBe('');
    expect(repliedText()).not.toContain('[botmux-xpi-control:');
    expect(repliedText()).not.toContain('ou_proposer_bot');
    expect(ds.worker.send).not.toHaveBeenCalled();
  });

  it('consumes a legacy control marker before it can auto-create a third-party session', async () => {
    const marker = '[botmux-xpi-control:v1:terminal:xpi_0123456789abcdef01234567]\n未执行';
    // Make the foreign bot otherwise eligible for ordinary ingress. Without
    // this, the permission gate would reject the mutated control message too,
    // and the test could pass without exercising the early consume branch.
    getBot(APP).resolvedAllowedUsers.push('ou_proposer_bot');

    await handleThreadReply(
      makeBotEventData('om_legacy_control', marker, 'om_unowned_control_root'),
      makeCtx('om_unowned_control_root', 'om_legacy_control'),
    );

    expect(activeSessions.size).toBe(0);
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(repliedText()).toBe('');
  });

  it('keeps an approved cross-principal record until the queue-full notice is delivered', async () => {
    const previousXpi = process.env.BOTMUX_XPI_ENABLED;
    process.env.BOTMUX_XPI_ENABLED = 'true';
    const ds = seedThreadSession('om_thread_owner_queue_full', 'seeded') as any;
    const caller = {
      requestLarkAppId: APP,
      requestUserOpenId: OWNER,
      requestUserUnionId: 'on_owner',
      senderType: 'user' as const,
    };
    ds.session.xpiSharedCwdAdmissionGroupId = 'xpi-admission:owner-queue-full';
    ds.session.xpiSharedCwdAdmissionCoordinatorSessionId = 'missing-coordinator';
    ds.session.xpiSharedCwdQueuedTurns = Array.from({ length: 32 }, (_, index) => ({
      version: 1,
      id: `queued-${index}`,
      turnId: `queued-turn-${index}`,
      caller,
      userPrompt: `queued ${index}`,
      cliInput: { content: `queued ${index}` },
      resume: true,
      createdAt: new Date(index).toISOString(),
      dispatchState: 'queued',
    }));
    ds.session.crossPrincipalInterruptions = [{
      version: 1,
      id: 'xpi_aaaaaaaaaaaaaaaaaaaaaaaa',
      ownerTurnId: 'owner-turn',
      owner: caller,
      proposer: {
        ...caller,
        requestUserOpenId: 'ou_foreign_proposer',
        requestUserUnionId: 'on_proposer',
        requestLarkAppId: 'foreign-app-observer',
      },
      phase: 'owner_approved',
      ownerUserPrompt: 'original owner task',
      messages: [{
        turnId: 'proposer-turn',
        text: 'approved advice',
        userPrompt: 'approved advice',
        createdAt: NOW,
      }],
    }];
    mocks.sessions.set(ds.session.sessionId, ds.session);
    const beforeQueue = structuredClone(ds.session.xpiSharedCwdQueuedTurns);

    try {
      await driveCrossPrincipalInterruptions(ds);
    } finally {
      if (previousXpi === undefined) delete process.env.BOTMUX_XPI_ENABLED;
      else process.env.BOTMUX_XPI_ENABLED = previousXpi;
    }

    expect(repliedText()).toContain('本次未接收也不会执行');
    expect(ds.session.crossPrincipalInterruptions).toBeUndefined();
    expect(ds.session.xpiSharedCwdQueuedTurns).toEqual(beforeQueue);
  });

  it('retains an approved cross-principal record when its queue-full notice fails', async () => {
    const previousXpi = process.env.BOTMUX_XPI_ENABLED;
    process.env.BOTMUX_XPI_ENABLED = 'true';
    const ds = seedThreadSession('om_thread_owner_notice_retry', 'seeded') as any;
    const caller = {
      requestLarkAppId: APP,
      requestUserOpenId: OWNER,
      requestUserUnionId: 'on_owner',
      senderType: 'user' as const,
    };
    ds.session.xpiSharedCwdAdmissionGroupId = 'xpi-admission:owner-notice-retry';
    ds.session.xpiSharedCwdAdmissionCoordinatorSessionId = 'missing-coordinator';
    ds.session.xpiSharedCwdQueuedTurns = Array.from({ length: 32 }, (_, index) => ({
      version: 1,
      id: `retry-queued-${index}`,
      turnId: `retry-queued-turn-${index}`,
      caller,
      userPrompt: `queued ${index}`,
      cliInput: { content: `queued ${index}` },
      resume: true,
      createdAt: new Date(index).toISOString(),
      dispatchState: 'queued',
    }));
    ds.session.crossPrincipalInterruptions = [{
      version: 1,
      id: 'xpi_bbbbbbbbbbbbbbbbbbbbbbbb',
      ownerTurnId: 'owner-turn',
      owner: caller,
      proposer: {
        ...caller,
        requestUserOpenId: 'ou_foreign_proposer',
        requestUserUnionId: 'on_proposer',
        requestLarkAppId: 'foreign-app-observer',
      },
      phase: 'owner_approved',
      ownerUserPrompt: 'original owner task',
      messages: [{
        turnId: 'proposer-turn',
        text: 'approved advice',
        userPrompt: 'approved advice',
        createdAt: NOW,
      }],
    }];
    mocks.sessions.set(ds.session.sessionId, ds.session);
    mocks.replyMessage.mockRejectedValue(new Error('notice transport unavailable'));
    mocks.sendMessage.mockRejectedValue(new Error('notice transport unavailable'));

    try {
      await driveCrossPrincipalInterruptions(ds);
      expect(ds.session.crossPrincipalInterruptions).toEqual([
        expect.objectContaining({
          id: 'xpi_bbbbbbbbbbbbbbbbbbbbbbbb',
          phase: 'terminal_notice_pending',
          terminalNoticeAttempts: 1,
        }),
      ]);
      expect(ds.crossPrincipalWaitTimer).toBeDefined();

      clearTimeout(ds.crossPrincipalWaitTimer);
      ds.crossPrincipalWaitTimer = undefined;
      mocks.replyMessage.mockResolvedValue('om_terminal_recovered');
      mocks.sendMessage.mockResolvedValue('om_terminal_recovered');
      await driveCrossPrincipalInterruptions(ds);
      expect(ds.session.crossPrincipalInterruptions).toBeUndefined();
      expect(ds.session.xpiSharedCwdQueuedTurns).toHaveLength(32);
    } finally {
      if (ds.crossPrincipalWaitTimer) clearTimeout(ds.crossPrincipalWaitTimer);
      ds.crossPrincipalWaitTimer = undefined;
      if (previousXpi === undefined) delete process.env.BOTMUX_XPI_ENABLED;
      else process.env.BOTMUX_XPI_ENABLED = previousXpi;
    }
  });

  it('retries a persisted terminal notice after daemon restart without replaying the business action', async () => {
    const previousXpi = process.env.BOTMUX_XPI_ENABLED;
    process.env.BOTMUX_XPI_ENABLED = 'true';
    const anchor = 'om_thread_terminal_notice_restart';
    const ds = seedThreadSession(anchor, 'seeded') as any;
    const caller = {
      requestLarkAppId: APP,
      requestUserOpenId: OWNER,
      requestUserUnionId: 'on_owner',
      senderType: 'user' as const,
    };
    ds.session.xpiSharedCwdAdmissionGroupId = 'xpi-admission:terminal-notice-restart';
    ds.session.xpiSharedCwdAdmissionCoordinatorSessionId = 'missing-coordinator';
    ds.session.xpiSharedCwdQueuedTurns = Array.from({ length: 32 }, (_, index) => ({
      version: 1,
      id: `restart-queued-${index}`,
      turnId: `restart-queued-turn-${index}`,
      caller,
      userPrompt: `queued ${index}`,
      cliInput: { content: `queued ${index}` },
      resume: true,
      createdAt: new Date(index).toISOString(),
      dispatchState: 'queued',
    }));
    ds.session.crossPrincipalInterruptions = [{
      version: 1,
      id: 'xpi_terminal_restart_123456',
      ownerTurnId: 'owner-turn',
      owner: caller,
      proposer: {
        ...caller,
        requestUserOpenId: 'ou_foreign_proposer',
        requestUserUnionId: 'on_proposer',
        requestLarkAppId: 'foreign-app-observer',
      },
      phase: 'owner_approved',
      ownerUserPrompt: 'original owner task',
      messages: [{
        turnId: 'proposer-turn',
        text: 'approved advice',
        userPrompt: 'approved advice',
        createdAt: NOW,
      }],
    }];
    mocks.sessions.set(ds.session.sessionId, ds.session);
    mocks.replyMessage.mockRejectedValue(new Error('notice transport unavailable'));
    mocks.sendMessage.mockRejectedValue(new Error('notice transport unavailable'));

    try {
      await driveCrossPrincipalInterruptions(ds);
      expect(ds.session.crossPrincipalInterruptions?.[0]).toMatchObject({
        id: 'xpi_terminal_restart_123456',
        phase: 'terminal_notice_pending',
        terminalNoticeAttempts: 1,
      });
      expect(ds.session.xpiSharedCwdQueuedTurns).toHaveLength(32);
      const persisted = structuredClone(ds.session);

      clearTimeout(ds.crossPrincipalWaitTimer);
      ds.crossPrincipalWaitTimer = undefined;
      activeSessions.clear();
      vi.clearAllMocks();
      mocks.replyMessage.mockResolvedValue('om_terminal_recovered_after_restart');
      mocks.sendMessage.mockResolvedValue('om_terminal_recovered_after_restart');
      const workerSend = vi.fn();
      const restartedDs = {
        ...ds,
        worker: { killed: false, send: workerSend },
        session: persisted,
        crossPrincipalInterruptionDriving: false,
        crossPrincipalWaitTimer: undefined,
      } as any;

      await restoreSessionsAndScheduleStartupRecovery({
        larkAppId: APP,
        restoreSessions: async () => {
          activeSessions.set(sessionKey(anchor, APP), restartedDs);
          return [];
        },
        markSessionsRestored: () => {},
        driveRestoredXpiGroup: () => {},
      });

      await vi.waitFor(() => {
        expect(restartedDs.session.crossPrincipalInterruptions).toBeUndefined();
      });
      expect(restartedDs.session.xpiSharedCwdQueuedTurns).toHaveLength(32);
      expect(workerSend).not.toHaveBeenCalled();
      expect(repliedText()).toContain('建议已确认，但共享目录等待队列已满');
    } finally {
      activeSessions.clear();
      if (previousXpi === undefined) delete process.env.BOTMUX_XPI_ENABLED;
      else process.env.BOTMUX_XPI_ENABLED = previousXpi;
    }
  });

  it('replays the original owner task with the approved suggestion under the owner identity', async () => {
    const previousXpi = process.env.BOTMUX_XPI_ENABLED;
    process.env.BOTMUX_XPI_ENABLED = 'true';
    const ds = seedThreadSession('om_thread_owner_replay', 'seeded') as any;
    const workerSend = vi.fn();
    ds.worker = { killed: false, send: workerSend };
    const owner = {
      requestLarkAppId: APP,
      requestUserOpenId: OWNER,
      requestUserUnionId: 'on_owner',
      senderType: 'user' as const,
    };
    ds.session.crossPrincipalInterruptions = [{
      version: 1,
      id: 'xpi_replayaaaaaaaaaaaaaaaaaa',
      ownerTurnId: 'owner-turn',
      owner,
      ownerUserPrompt: '生成发布说明并校验链接',
      proposer: {
        requestLarkAppId: 'foreign-app-observer',
        requestUserOpenId: 'ou_foreign_proposer',
        requestUserUnionId: 'on_proposer',
        senderType: 'user' as const,
      },
      phase: 'owner_approved',
      messages: [{
        turnId: 'proposer-turn',
        text: '补充回滚步骤',
        userPrompt: '补充回滚步骤',
        createdAt: NOW,
      }],
    }];
    mocks.sessions.set(ds.session.sessionId, ds.session);

    try {
      await driveCrossPrincipalInterruptions(ds);
    } finally {
      if (previousXpi === undefined) delete process.env.BOTMUX_XPI_ENABLED;
      else process.env.BOTMUX_XPI_ENABLED = previousXpi;
    }

    expect(workerSend).toHaveBeenCalledTimes(1);
    const sent = workerSend.mock.calls[0]?.[0];
    expect(sent).toMatchObject({
      type: 'message',
      turnId: 'xpi_replayaaaaaaaaaaaaaaaaaa:approved',
      atMostOnce: true,
      trustedCaller: owner,
    });
    expect(sent.content).toContain('生成发布说明并校验链接');
    expect(sent.content).toContain('补充回滚步骤');
    expect(sent.content).toContain('请重新执行原任务');
    expect(sent.content).not.toContain('ou_foreign_proposer');
    expect(ds.lastUserPrompt).toContain('生成发布说明并校验链接');
    expect(ds.lastUserPrompt).toContain('补充回滚步骤');
    expect(ds.activeInteractiveTurn).toMatchObject({
      turnId: 'xpi_replayaaaaaaaaaaaaaaaaaa:approved',
      caller: owner,
    });
    expect(ds.session.crossPrincipalInterruptions).toBeUndefined();
    expect(repliedText()).toContain('正在以你的身份重新执行原任务');
    expect(repliedText()).toContain('你的建议已获确认');
  });

  it('wakes an approved T1 suggestion when later owner turn T2 completes', async () => {
    const previousXpi = process.env.BOTMUX_XPI_ENABLED;
    process.env.BOTMUX_XPI_ENABLED = 'true';
    const ds = seedThreadSession('om_thread_owner_replay_after_t2', 'seeded') as any;
    const workerSend = vi.fn();
    ds.worker = { killed: false, send: workerSend };
    const owner = {
      requestLarkAppId: APP,
      requestUserOpenId: OWNER,
      requestUserUnionId: 'on_owner',
      senderType: 'user' as const,
    };
    ds.activeInteractiveTurn = {
      turnId: 'owner-turn-t2',
      caller: owner,
      userPrompt: 'T2 task',
    };
    ds.session.crossPrincipalInterruptions = [{
      version: 1,
      id: 'xpi_replay_after_t2aaaaaaaaa',
      ownerTurnId: 'owner-turn-t1',
      owner,
      ownerUserPrompt: 'T1 task',
      proposer: {
        requestLarkAppId: 'foreign-app-observer',
        requestUserOpenId: 'ou_foreign_proposer',
        requestUserUnionId: 'on_proposer',
        senderType: 'user' as const,
      },
      phase: 'owner_approved',
      messages: [{
        turnId: 'proposer-turn',
        text: 'approved advice',
        userPrompt: 'approved advice',
        createdAt: NOW,
      }],
    }];
    mocks.sessions.set(ds.session.sessionId, ds.session);

    try {
      await driveCrossPrincipalInterruptions(ds);
      expect(workerSend).not.toHaveBeenCalled();
      expect(ds.session.crossPrincipalInterruptions).toHaveLength(1);
      expect(completedTurnHasCrossPrincipalFollower(ds, {
        turnId: 'owner-turn-t2',
        status: 'completed',
      })).toBe(true);

      ds.activeInteractiveTurn = undefined;
      await driveCrossPrincipalInterruptions(ds);
    } finally {
      if (previousXpi === undefined) delete process.env.BOTMUX_XPI_ENABLED;
      else process.env.BOTMUX_XPI_ENABLED = previousXpi;
    }

    expect(workerSend).toHaveBeenCalledTimes(1);
    expect(workerSend.mock.calls[0]?.[0]).toMatchObject({
      type: 'message',
      turnId: 'xpi_replay_after_t2aaaaaaaaa:approved',
      trustedCaller: owner,
    });
    expect(ds.session.crossPrincipalInterruptions).toBeUndefined();
  });

  it('fails closed when an approved legacy record lacks the original owner prompt', async () => {
    const previousXpi = process.env.BOTMUX_XPI_ENABLED;
    process.env.BOTMUX_XPI_ENABLED = 'true';
    const ds = seedThreadSession('om_thread_owner_replay_missing', 'seeded') as any;
    const workerSend = vi.fn();
    ds.worker = { killed: false, send: workerSend };
    ds.session.crossPrincipalInterruptions = [{
      version: 1,
      id: 'xpi_missingaaaaaaaaaaaaaaaa',
      ownerTurnId: 'owner-turn',
      owner: {
        requestLarkAppId: APP,
        requestUserOpenId: OWNER,
        requestUserUnionId: 'on_owner',
        senderType: 'user' as const,
      },
      proposer: {
        requestLarkAppId: 'foreign-app-observer',
        requestUserOpenId: 'ou_foreign_proposer',
        requestUserUnionId: 'on_proposer',
        senderType: 'user' as const,
      },
      phase: 'owner_approved',
      messages: [{
        turnId: 'proposer-turn',
        text: 'approved advice',
        userPrompt: 'approved advice',
        createdAt: NOW,
      }],
    }];
    mocks.sessions.set(ds.session.sessionId, ds.session);

    try {
      await driveCrossPrincipalInterruptions(ds);
    } finally {
      if (previousXpi === undefined) delete process.env.BOTMUX_XPI_ENABLED;
      else process.env.BOTMUX_XPI_ENABLED = previousXpi;
    }

    expect(workerSend).not.toHaveBeenCalled();
    expect(ds.session.crossPrincipalInterruptions).toBeUndefined();
    expect(repliedText()).toContain('无法恢复原任务内容');
  });

  it('retains and schedules an approved replay when worker delivery is temporarily unavailable', async () => {
    const previousXpi = process.env.BOTMUX_XPI_ENABLED;
    process.env.BOTMUX_XPI_ENABLED = 'true';
    const ds = seedThreadSession('om_thread_owner_replay_retry', 'seeded') as any;
    ds.worker = { killed: false, send: vi.fn(() => { throw new Error('ipc unavailable'); }) };
    ds.session.crossPrincipalInterruptions = [{
      version: 1,
      id: 'xpi_retryaaaaaaaaaaaaaaaaaa',
      ownerTurnId: 'owner-turn',
      owner: {
        requestLarkAppId: APP,
        requestUserOpenId: OWNER,
        requestUserUnionId: 'on_owner',
        senderType: 'user' as const,
      },
      ownerUserPrompt: 'original owner task',
      proposer: {
        requestLarkAppId: 'foreign-app-observer',
        requestUserOpenId: 'ou_foreign_proposer',
        requestUserUnionId: 'on_proposer',
        senderType: 'user' as const,
      },
      phase: 'owner_approved',
      messages: [{
        turnId: 'proposer-turn',
        text: 'approved advice',
        userPrompt: 'approved advice',
        createdAt: NOW,
      }],
    }];
    mocks.sessions.set(ds.session.sessionId, ds.session);

    try {
      await driveCrossPrincipalInterruptions(ds);
      expect(ds.session.crossPrincipalInterruptions).toEqual([
        expect.objectContaining({ id: 'xpi_retryaaaaaaaaaaaaaaaaaa', phase: 'owner_approved' }),
      ]);
      expect(ds.crossPrincipalWaitTimer).toBeDefined();
      expect(repliedText()).toContain('暂未成功启动');
      expect(ds.activeInteractiveTurn).toBeUndefined();
    } finally {
      if (ds.crossPrincipalWaitTimer) clearTimeout(ds.crossPrincipalWaitTimer);
      ds.crossPrincipalWaitTimer = undefined;
      if (previousXpi === undefined) delete process.env.BOTMUX_XPI_ENABLED;
      else process.env.BOTMUX_XPI_ENABLED = previousXpi;
    }
  });

  it('enqueues an approved grouped replay once when its cold fork is marginally deferred', async () => {
    const previousXpi = process.env.BOTMUX_XPI_ENABLED;
    process.env.BOTMUX_XPI_ENABLED = 'true';
    const ds = seedThreadSession('om_thread_owner_replay_marginal', 'seeded') as any;
    // Active, lease-free coordinator row so the cold-fork busy precheck passes
    // and dispatch reaches the fork boundary.
    const coordinator = {
      sessionId: 'sess-xpi-coord-marginal',
      chatId: 'oc_coord_marginal',
      rootMessageId: 'om_coord_marginal',
      title: 'coordinator',
      status: 'active' as const,
      createdAt: NOW,
      chatType: 'group' as const,
      larkAppId: APP,
      xpiSharedCwdAdmissionGroupId: 'xpi:marginal-replay',
      xpiSharedCwdAdmissionCoordinatorSessionId: 'sess-xpi-coord-marginal',
    };
    mocks.sessions.set(coordinator.sessionId, coordinator);
    Object.assign(ds.session, {
      larkAppId: APP,
      xpiSharedCwdAdmissionGroupId: 'xpi:marginal-replay',
      xpiSharedCwdAdmissionCoordinatorSessionId: coordinator.sessionId,
    });
    mocks.sessions.set(ds.session.sessionId, ds.session);
    const owner = {
      requestLarkAppId: APP,
      requestUserOpenId: OWNER,
      requestUserUnionId: 'on_owner',
      senderType: 'user' as const,
    };
    ds.session.crossPrincipalInterruptions = [{
      version: 1,
      id: 'xpi_marginalaaaaaaaaaaaaaa',
      ownerTurnId: 'owner-turn',
      owner,
      ownerUserPrompt: 'original owner task',
      proposer: {
        requestLarkAppId: 'foreign-app-observer',
        requestUserOpenId: 'ou_foreign_proposer',
        requestUserUnionId: 'on_proposer',
        senderType: 'user' as const,
      },
      phase: 'owner_approved',
      messages: [{
        turnId: 'proposer-turn',
        text: 'approved advice',
        userPrompt: 'approved advice',
        createdAt: NOW,
      }],
    }];
    // Marginal admission: the fork is accepted synchronously, but the group
    // slot closure never fires (it only runs on the asynchronous re-entry).
    mocks.forkWorker.mockImplementationOnce((_ds: any, _input: any, _turn: any, forkOpts: any) => {
      forkOpts.marginalReclaimScheduled = true;
      return true;
    });

    await driveCrossPrincipalInterruptions(ds);

    // Asserted immediately after the synchronous dispatch leg: the turn must be
    // durably queued and the record removed without waiting for any owner-wait
    // timer (asserting only after a timer advance would also pass on the old
    // retry-and-redrive behaviour).
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    expect(ds.session.crossPrincipalInterruptions).toBeUndefined();
    expect(ds.session.xpiSharedCwdQueuedTurns).toEqual([
      expect.objectContaining({
        turnId: 'xpi_marginalaaaaaaaaaaaaaa:approved',
        dispatchState: 'queued',
      }),
    ]);
    expect(ds.activeInteractiveTurn).toBeUndefined();
    if (previousXpi === undefined) delete process.env.BOTMUX_XPI_ENABLED;
    else process.env.BOTMUX_XPI_ENABLED = previousXpi;
  });

  it('keeps the owner-wait retry when a grouped cold fork is hard-blocked rather than marginal', async () => {
    const previousXpi = process.env.BOTMUX_XPI_ENABLED;
    process.env.BOTMUX_XPI_ENABLED = 'true';
    vi.useFakeTimers();
    const ds = seedThreadSession('om_thread_owner_replay_hard', 'seeded') as any;
    const coordinator = {
      sessionId: 'sess-xpi-coord-hard',
      chatId: 'oc_coord_hard',
      rootMessageId: 'om_coord_hard',
      title: 'coordinator',
      status: 'active' as const,
      createdAt: NOW,
      chatType: 'group' as const,
      larkAppId: APP,
      xpiSharedCwdAdmissionGroupId: 'xpi:hard-replay',
      xpiSharedCwdAdmissionCoordinatorSessionId: 'sess-xpi-coord-hard',
    };
    mocks.sessions.set(coordinator.sessionId, coordinator);
    Object.assign(ds.session, {
      larkAppId: APP,
      xpiSharedCwdAdmissionGroupId: 'xpi:hard-replay',
      xpiSharedCwdAdmissionCoordinatorSessionId: coordinator.sessionId,
    });
    mocks.sessions.set(ds.session.sessionId, ds.session);
    const owner = {
      requestLarkAppId: APP,
      requestUserOpenId: OWNER,
      requestUserUnionId: 'on_owner',
      senderType: 'user' as const,
    };
    ds.session.crossPrincipalInterruptions = [{
      version: 1,
      id: 'xpi_hardblockaaaaaaaaaaa',
      ownerTurnId: 'owner-turn',
      owner,
      ownerUserPrompt: 'original owner task',
      proposer: {
        requestLarkAppId: 'foreign-app-observer',
        requestUserOpenId: 'ou_foreign_proposer',
        requestUserUnionId: 'on_proposer',
        senderType: 'user' as const,
      },
      phase: 'owner_approved',
      messages: [{
        turnId: 'proposer-turn',
        text: 'approved advice',
        userPrompt: 'approved advice',
        createdAt: NOW,
      }],
    }];
    // Synchronous refusal with the same boolean shape as marginal (hard memory
    // block / retirement fence): accepted=true, closure unfired, but NO
    // marginalReclaimScheduled out-flag. No re-entry is coming.
    mocks.forkWorker
      .mockImplementationOnce(() => true)
      .mockImplementation(() => true);

    try {
      await driveCrossPrincipalInterruptions(ds);

      // The record is retained and nothing is parked in the lease journal; the
      // owner-wait timer owns the retry.
      expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
      expect(ds.session.crossPrincipalInterruptions?.map((r: any) => r.id))
        .toEqual(['xpi_hardblockaaaaaaaaaaa']);
      expect(ds.session.xpiSharedCwdQueuedTurns ?? []).toEqual([]);
      expect(ds.crossPrincipalWaitTimer).toBeTruthy();

      await vi.advanceTimersByTimeAsync(5_000);

      // The retained record re-drove and forked a second time, still without
      // journaling the turn (a third owner-wait is now pending).
      expect(mocks.forkWorker).toHaveBeenCalledTimes(2);
      expect(ds.session.crossPrincipalInterruptions?.map((r: any) => r.id))
        .toEqual(['xpi_hardblockaaaaaaaaaaa']);
      expect(ds.session.xpiSharedCwdQueuedTurns ?? []).toEqual([]);
    } finally {
      if (ds.crossPrincipalWaitTimer) clearTimeout(ds.crossPrincipalWaitTimer);
      ds.crossPrincipalWaitTimer = undefined;
      vi.useRealTimers();
      if (previousXpi === undefined) delete process.env.BOTMUX_XPI_ENABLED;
      else process.env.BOTMUX_XPI_ENABLED = previousXpi;
    }
  });

  it('persists a grouped opening into the leased queue when its cold fork is marginally deferred', async () => {
    const ds = seedThreadSession('om_thread_group_opening_marginal', 'seeded') as any;
    const coordinator = {
      sessionId: 'sess-xpi-coord-opening',
      chatId: 'oc_coord_opening',
      rootMessageId: 'om_coord_opening',
      title: 'coordinator',
      status: 'active' as const,
      createdAt: NOW,
      chatType: 'group' as const,
      larkAppId: APP,
      xpiSharedCwdAdmissionGroupId: 'xpi:marginal-opening',
      xpiSharedCwdAdmissionCoordinatorSessionId: 'sess-xpi-coord-opening',
    };
    mocks.sessions.set(coordinator.sessionId, coordinator);
    Object.assign(ds.session, {
      larkAppId: APP,
      xpiSharedCwdAdmissionGroupId: 'xpi:marginal-opening',
      xpiSharedCwdAdmissionCoordinatorSessionId: coordinator.sessionId,
    });
    mocks.sessions.set(ds.session.sessionId, ds.session);
    ds.pendingPrompt = 'grouped opening task';
    ds.pendingTurnId = 'om_group_opening';
    const trustedCaller = {
      requestLarkAppId: APP,
      requestUserOpenId: OWNER,
      senderType: 'user' as const,
    };
    // Marginal admission: synchronous fork accepted without firing the group
    // slot closure.
    mocks.forkWorker.mockImplementationOnce((_ds: any, _input: any, _turn: any, forkOpts: any) => {
      forkOpts.marginalReclaimScheduled = true;
      return true;
    });

    const started = forkReservedInitialSession(ds, [], trustedCaller);

    expect(started).toBe(false);
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    expect(ds.session.xpiSharedCwdQueuedTurns).toEqual([
      expect.objectContaining({ turnId: 'om_group_opening', dispatchState: 'queued' }),
    ]);
    expect(ds.pendingTurnId).toBeUndefined();
    expect(ds.initialStartPending).toBe(false);
  });

  it('keeps the exact human prompt on an accepted cold opening turn', () => {
    const ds = seedThreadSession('om_thread_cold_authorization', 'seeded') as any;
    ds.pendingPrompt = 'exact authorization statement';
    ds.pendingTurnId = 'om_cold_authorization';
    const trustedCaller = {
      requestLarkAppId: APP,
      requestUserOpenId: OWNER,
      senderType: 'user' as const,
    };
    mocks.forkWorker.mockReturnValueOnce(true);

    expect(forkReservedInitialSession(ds, [], trustedCaller)).toBe(true);
    expect(ds.activeInteractiveTurn).toMatchObject({
      turnId: 'om_cold_authorization',
      caller: trustedCaller,
      userPrompt: 'exact authorization statement',
    });
  });

  it('persists the mapped TaskControl admission claim as active at the final cold-fork boundary', () => {
    mkdirSync(mocks.dataDir, { recursive: true });
    const projectPath = `${mocks.dataDir}/project-groups.json`;
    const registryPath = `${mocks.dataDir}/orchestrate-dispatch.json`;
    const dispatchRoot = 'om_task_control_pre_fork';
    const messageId = 'om_task_control_kickoff';
    const taskGuid = '11111111-1111-4111-8111-111111111111';
    writeFileSync(projectPath, JSON.stringify({
      schemaVersion: 3,
      projects: {
        [CHAT]: {
          schemaVersion: 3, revision: 2, chatId: CHAT, larkAppId: 'cli_controller',
          coordinatorSessionId: 'session_controller', title: '项目', goal: '验证 pre-fork claim',
          phase: '执行', focus: '冷启动', status: 'active', blockers: [], blockerRecords: [],
          workstreams: [{
            dispatchRoot, title: '受控任务', purpose: '验证入站', owners: [], targetAppIds: [APP, 'cli_reviewer'],
            workerAppIds: [APP], reviewerAppIds: ['cli_reviewer'], access: { mode: 'write', scopes: [mocks.dataDir] },
            status: 'pending', progress: 0, createdAt: NOW, updatedAt: NOW,
            taskControl: {
              taskGuid, phaseId: `workstream:${taskGuid}`, mappingRef: `topic-message:${dispatchRoot}`,
              mappingStatus: 'registered', sourceKind: 'project_group', controllerAppId: 'cli_controller',
              workerAppId: APP, reviewerAppId: 'cli_reviewer', acceptorAppId: 'cli_acceptor', projectRevision: 2,
              reservationId: '4'.repeat(50), coordinatorSessionId: 'session_controller',
              originTurnId: 'om_authorized_turn', reservationCreatedAt: NOW,
              reservationExpiresAt: '2099-09-29T00:02:00.000Z', rootCreateTime: NOW,
              reservationProof: {
                schemaVersion: 'ProjectDispatchReservationProof.v1', larkAppId: 'cli_controller',
                issuedAt: NOW, keyId: 'tcpr1:test', signature: 'd'.repeat(64),
              },
            },
          }],
          completionGates: [], dispatchReservations: [], milestones: [], createdAt: NOW, updatedAt: NOW,
        },
      },
    }));
    writeFileSync(registryPath, JSON.stringify({
      [dispatchRoot]: { dispatchOperationId: '4'.repeat(50), taskControl: { mode: 'audit_only' } },
    }));
    const ds = seedThreadSession(dispatchRoot, 'task-control') as any;
    ds.pendingPrompt = '执行冻结 canary';
    ds.pendingTurnId = messageId;
    const trustedCaller = {
      requestLarkAppId: 'cli_controller', requestUserOpenId: 'ou_controller', senderType: 'bot' as const,
    };
    mocks.forkWorker.mockReturnValueOnce(false);
    mocks.forkWorker.mockImplementationOnce((workerDs: any, _input: any, turn: any) => {
      turn?.onWorkerGenerationReserved?.(7);
      workerDs.worker = { killed: false, send: vi.fn() };
      return true;
    });

    try {
      expect(forkReservedInitialSession(ds, [], trustedCaller)).toBe(false);
      expect(JSON.parse(readFileSync(registryPath, 'utf8'))
        .__taskControlTurnAdmissionsV1.claims[messageId]).toMatchObject({
        messageId, dispatchRoot, targetAppId: APP, sessionId: ds.session.sessionId,
        state: 'pending',
      });
      expect(forkReservedInitialSession(ds, [], trustedCaller)).toBe(true);
      const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as any;
      expect(registry.__taskControlTurnAdmissionsV1?.claims?.[messageId]).toMatchObject({
        messageId, dispatchRoot, targetAppId: APP, sessionId: ds.session.sessionId,
        workerGeneration: 7, state: 'active',
      });
      const callsAfterFirstFork = mocks.forkWorker.mock.calls.length;
      ds.worker = null;
      ds.pendingPrompt = '重复投递同一条 canary';
      ds.pendingTurnId = messageId;
      mocks.forkWorker.mockReturnValueOnce(true);
      expect(forkReservedInitialSession(ds, [], trustedCaller)).toBe(false);
      expect(mocks.forkWorker).toHaveBeenCalledTimes(callsAfterFirstFork);
      const terminalAt = new Date().toISOString();
      expect(terminalizeProjectTaskControlTurnAdmission(ds, messageId, 7, terminalAt)).toBe(true);
      expect(JSON.parse(readFileSync(registryPath, 'utf8'))
        .__taskControlTurnAdmissionsV1.claims[messageId]).toMatchObject({
        messageId, dispatchRoot, targetAppId: APP, sessionId: ds.session.sessionId,
        workerGeneration: 7, state: 'terminal', terminalAt,
      });
      ds.pendingPrompt = '终态后再次投递同一条 canary';
      ds.pendingTurnId = messageId;
      expect(forkReservedInitialSession(ds, [], trustedCaller)).toBe(false);
      expect(mocks.forkWorker).toHaveBeenCalledTimes(callsAfterFirstFork);

      const fullClaims = Object.fromEntries(Array.from({ length: 32 }, (_, index) => {
        const id = `om_capacity_${index}`;
        return [id, {
          messageId: id, chatId: CHAT, dispatchRoot, targetAppId: APP,
          sessionId: `session_capacity_${index}`, state: 'pending',
          createdAt: NOW, updatedAt: NOW,
        }];
      }));
      writeFileSync(registryPath, JSON.stringify({
        [dispatchRoot]: { dispatchOperationId: '4'.repeat(50), taskControl: { mode: 'audit_only' } },
        __taskControlTurnAdmissionsV1: { claims: fullClaims },
      }));
      ds.pendingPrompt = '超过单 root admission 上限';
      ds.pendingTurnId = 'om_capacity_overflow';
      expect(() => forkReservedInitialSession(ds, [], trustedCaller))
        .toThrow('project_task_control_turn_claim_per_root_capacity');
      expect(mocks.forkWorker).toHaveBeenCalledTimes(callsAfterFirstFork);
      const overflowRegistry = JSON.parse(readFileSync(registryPath, 'utf8'));
      expect(Object.keys(overflowRegistry.__taskControlTurnAdmissionsV1.claims)).toHaveLength(32);
      expect(Object.keys(overflowRegistry.__taskControlTurnAdmissionsV1.overflowMarkers)).toEqual(['perRoot']);
    } finally {
      rmSync(projectPath, { force: true });
      rmSync(registryPath, { force: true });
    }
  });

  it('admits only the delivered Phase A instruction message through the historical-root fence', async () => {
    mkdirSync(mocks.dataDir, { recursive: true });
    const workerAppId = 'cli_phase_a_worker';
    registerBot({
      larkAppId: workerAppId, larkAppSecret: 's', cliId: 'claude-code', allowedUsers: [OWNER],
    }).resolvedAllowedUsers = [OWNER];
    const projectPath = `${mocks.dataDir}/project-groups.json`;
    const registryPath = `${mocks.dataDir}/orchestrate-dispatch.json`;
    const dispatchRoot = 'om_phase_a_historical';
    const messageId = 'om_phase_a_instruction';
    const taskGuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const instructionTemplate = 'Submit only the frozen Phase A failed report';
    const failedReportContent = 'Phase A failed as frozen';
    const fence = {
      dispatchOperationId: 'a'.repeat(50), taskGuid: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      coordinatorSessionId: 'session_controller', originTurnId: 'om_authorized_turn',
      authorizationRef: 'om_authorized_turn', authorizedByOpenId: 'ou_controller', planSha256: 'f'.repeat(64),
      controllerAppId: 'cli_controller', workerAppId: 'cli_canary_worker', reviewerAppId: 'cli_canary_reviewer',
      acceptorAppId: 'cli_canary_acceptor', targetChatId: CHAT,
      targetAppIds: ['cli_canary_worker', 'cli_canary_reviewer'], writeScopes: [mocks.dataDir],
      title: '无文件 canary', purpose: '验证 Phase A 单次入站', owners: ['Worker', 'Reviewer'],
      botOpenIds: ['ou_worker', 'ou_reviewer'], acceptanceRequested: true,
      seedText: '冻结 seed', taskControlMode: 'audit_only' as const,
      phaseA: {
        historicalDispatchRoot: dispatchRoot, historicalTaskGuid: taskGuid, mappedWorkerAppId: workerAppId,
        failedReportContent,
        failedReportSha256: createHash('sha256').update(failedReportContent).digest('hex'),
        instructionTemplateVersion: 'TaskControlPhaseAInstruction.v1' as const,
        instructionTemplate,
        instructionTemplateSha256: createHash('sha256').update(instructionTemplate).digest('hex'),
      },
    };
    const fenceFingerprint = projectTaskControlCanaryFenceFingerprint(fence);
    const fenceRecord = projectTaskControlCanaryFenceRecord(fence, NOW);
    writeFileSync(projectPath, JSON.stringify({
      schemaVersion: 3,
      projects: {
        [CHAT]: {
          schemaVersion: 3, revision: 2, chatId: CHAT, larkAppId: 'cli_controller',
          coordinatorSessionId: 'session_controller', title: '项目', goal: '验证 Phase A 入站',
          phase: '执行', focus: 'Phase A', status: 'active', blockers: [fenceRecord.summary],
          blockerRecords: [fenceRecord],
          workstreams: [{
            dispatchRoot, title: '历史任务', purpose: '验证 Phase A', owners: [], targetAppIds: [workerAppId, 'cli_reviewer'],
            workerAppIds: [workerAppId], reviewerAppIds: ['cli_reviewer'], access: { mode: 'write', scopes: [mocks.dataDir] },
            status: 'in_progress', progress: 50, createdAt: NOW, updatedAt: NOW,
            taskControl: {
              taskGuid, phaseId: `workstream:${taskGuid}`, mappingRef: `topic-message:${dispatchRoot}`,
              mappingStatus: 'registered', sourceKind: 'project_group', controllerAppId: 'cli_controller',
              workerAppId: workerAppId, reviewerAppId: 'cli_reviewer', acceptorAppId: 'cli_acceptor', projectRevision: 2,
              reservationId: '4'.repeat(50), coordinatorSessionId: 'session_controller',
              originTurnId: 'om_historical_origin', reservationCreatedAt: NOW,
              reservationExpiresAt: '2099-09-29T00:02:00.000Z', rootCreateTime: NOW,
              reservationProof: {
                schemaVersion: 'ProjectDispatchReservationProof.v1', larkAppId: 'cli_controller',
                issuedAt: NOW, keyId: 'tcpr1:phase-a', signature: 'd'.repeat(64),
              },
            },
          }],
          completionGates: [], dispatchReservations: [], milestones: [], createdAt: NOW, updatedAt: NOW,
        },
      },
    }));
    writeFileSync(registryPath, JSON.stringify({
      [dispatchRoot]: { dispatchOperationId: '4'.repeat(50), taskControl: { mode: 'audit_only' } },
    }));
    mocks.replyMessage
      .mockRejectedValueOnce(new Error('provider response lost'))
      .mockResolvedValueOnce(messageId);
    const input = {
      context: {
        dataDir: mocks.dataDir, chatId: CHAT, larkAppId: 'cli_controller',
        coordinatorSessionId: 'session_controller',
      },
      fenceFingerprint, instructionTemplateSha256: fence.phaseA.instructionTemplateSha256,
      attempt: { wallTime: NOW, bootId: 'boot-1', processStartedAt: NOW, monotonicMs: 1_000 },
    } as const;
    const responseLost = await deliverProjectTaskControlPhaseAInstruction(input);
    expect(responseLost).toMatchObject({ state: 'pending' });
    const inboundBeforeResponse = awaitProjectTaskControlPhaseAInstruction({
      dataDir: mocks.dataDir,
      chatId: CHAT,
      dispatchRoot,
      targetAppId: workerAppId,
      messageId,
    });
    const delivery = await deliverProjectTaskControlPhaseAInstruction({
      ...input,
      attempt: { ...input.attempt, monotonicMs: 2_000 },
    });
    expect(delivery).toMatchObject({ state: 'delivered', messageId });
    await expect(inboundBeforeResponse).resolves.toBe('allowed');
    expect(mocks.replyMessage).toHaveBeenCalledTimes(2);
    expect(mocks.replyMessage).toHaveBeenLastCalledWith(
      fence.controllerAppId, dispatchRoot, instructionTemplate, 'text', true,
      expect.stringMatching(/^[a-f0-9]{50}$/),
      undefined,
      { timeoutMs: 5_000, signal: expect.any(AbortSignal) },
    );
    expect(mocks.replyMessage.mock.calls[0]?.[7]?.signal).toBeInstanceOf(AbortSignal);
    expect(mocks.replyMessage.mock.calls[1]?.[7]?.signal).toBeInstanceOf(AbortSignal);
    expect(mocks.replyMessage.mock.calls[0]?.[7]?.signal)
      .not.toBe(mocks.replyMessage.mock.calls[1]?.[7]?.signal);
    expect(mocks.replyMessage.mock.calls[0]?.[5]).toBe(mocks.replyMessage.mock.calls[1]?.[5]);
    const ds = seedThreadSession(dispatchRoot, 'phase-a') as any;
    activeSessions.delete(sessionKey(dispatchRoot, APP));
    ds.larkAppId = workerAppId;
    ds.session.larkAppId = workerAppId;
    activeSessions.set(sessionKey(dispatchRoot, workerAppId), ds);
    ds.pendingPrompt = instructionTemplate;
    ds.pendingTurnId = messageId;
    const trustedCaller = {
      requestLarkAppId: 'cli_controller', requestUserOpenId: 'ou_controller', senderType: 'bot' as const,
    };
    mocks.forkWorker.mockImplementationOnce((workerDs: any, _input: any, turn: any) => {
      turn?.onWorkerGenerationReserved?.(9);
      workerDs.worker = { killed: false, send: vi.fn() };
      return true;
    });

    try {
      ds.pendingTurnId = 'om_phase_a_wrong_message';
      expect(() => forkReservedInitialSession(ds, [], trustedCaller))
        .toThrow('project_task_control_canary_fence_rejects_turn');
      expect(mocks.forkWorker).not.toHaveBeenCalled();
      expect(JSON.parse(readFileSync(registryPath, 'utf8'))
        .__taskControlTurnAdmissionsV1).toBeUndefined();

      ds.pendingTurnId = messageId;
      expect(forkReservedInitialSession(ds, [], trustedCaller)).toBe(true);
      expect(JSON.parse(readFileSync(registryPath, 'utf8'))
        .__taskControlTurnAdmissionsV1.claims[messageId]).toMatchObject({
        messageId, dispatchRoot, targetAppId: workerAppId, state: 'active', workerGeneration: 9,
      });
    } finally {
      rmSync(projectPath, { force: true });
      rmSync(registryPath, { force: true });
    }
  });

  it('builds and journals the exact fenced kickoff in the daemon before provider delivery', async () => {
    mkdirSync(mocks.dataDir, { recursive: true });
    const projectPath = `${mocks.dataDir}/project-groups.json`;
    const registryPath = `${mocks.dataDir}/orchestrate-dispatch.json`;
    const dispatchRoot = 'om_task_control_kickoff_root';
    const foreignMappedRoot = 'om_task_control_foreign_mapped_root';
    const operationId = 'b'.repeat(50);
    const taskGuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const purpose = '只执行冻结的 canary，并按原 root 回报';
    const failedReportContent = 'Phase A failed as frozen';
    const instructionTemplate = 'Submit only the frozen Phase A failed report';
    const fence = {
      dispatchOperationId: operationId, taskGuid,
      coordinatorSessionId: 'session_controller', originTurnId: 'om_authorized_turn',
      authorizationRef: 'om_authorized_turn', authorizedByOpenId: 'ou_controller', planSha256: 'f'.repeat(64),
      controllerAppId: 'cli_controller', workerAppId: 'cli_worker', reviewerAppId: 'cli_reviewer',
      acceptorAppId: 'cli_acceptor', targetChatId: CHAT,
      targetAppIds: ['cli_worker', 'cli_reviewer'], writeScopes: [mocks.dataDir],
      title: '无文件 canary', purpose, owners: ['Worker', 'Reviewer'],
      botOpenIds: ['ou_worker', 'ou_reviewer'], acceptanceRequested: true,
      seedText: '冻结 seed', taskControlMode: 'audit_only' as const,
      kickoff: {
        templateVersion: 'TaskControlKickoff.v1' as const,
        rootPlaceholder: '{{dispatchRoot}}' as const,
        brief: purpose,
        briefSha256: createHash('sha256').update(purpose).digest('hex'),
        bots: [
          { appId: 'cli_worker', openId: 'ou_worker', displayName: 'Worker', role: 'worker' as const },
          { appId: 'cli_reviewer', openId: 'ou_reviewer', displayName: 'Reviewer', role: 'reviewer' as const },
        ],
      },
      phaseA: {
        historicalDispatchRoot: 'om_phase_a_historical',
        historicalTaskGuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        mappedWorkerAppId: 'cli_phase_a_worker', failedReportContent,
        failedReportSha256: createHash('sha256').update(failedReportContent).digest('hex'),
        instructionTemplateVersion: 'TaskControlPhaseAInstruction.v1' as const,
        instructionTemplate,
        instructionTemplateSha256: createHash('sha256').update(instructionTemplate).digest('hex'),
      },
    };
    const fenceRecord = projectTaskControlCanaryFenceRecord(fence, NOW);
    writeFileSync(projectPath, JSON.stringify({
      schemaVersion: 3,
      projects: {
        [CHAT]: {
          schemaVersion: 3, revision: 3, chatId: CHAT, larkAppId: fence.controllerAppId,
          coordinatorSessionId: fence.coordinatorSessionId, title: '项目', goal: '验证 kickoff',
          phase: '执行', focus: 'kickoff', status: 'active', blockers: [fenceRecord.summary],
          blockerRecords: [fenceRecord],
          workstreams: [{
            dispatchRoot, title: fence.title, purpose, owners: fence.owners,
            targetAppIds: fence.targetAppIds, workerAppIds: [fence.workerAppId],
            reviewerAppIds: [fence.reviewerAppId], access: { mode: 'write', scopes: fence.writeScopes },
            status: 'pending', progress: 0, createdAt: NOW, updatedAt: NOW,
            taskControl: {
              taskGuid, phaseId: `workstream:${taskGuid}`, mappingRef: `topic-message:${dispatchRoot}`,
              mappingStatus: 'registered', sourceKind: 'project_group', controllerAppId: fence.controllerAppId,
              workerAppId: fence.workerAppId, reviewerAppId: fence.reviewerAppId,
              acceptorAppId: fence.acceptorAppId, projectRevision: 3, reservationId: operationId,
              coordinatorSessionId: fence.coordinatorSessionId, originTurnId: fence.originTurnId,
              reservationCreatedAt: NOW, reservationExpiresAt: '2099-09-30T00:02:00.000Z', rootCreateTime: NOW,
              reservationProof: {
                schemaVersion: 'ProjectDispatchReservationProof.v1', larkAppId: fence.controllerAppId,
                issuedAt: NOW, keyId: 'tcpr1:kickoff', signature: 'd'.repeat(64),
              },
            },
          }, {
            dispatchRoot: foreignMappedRoot, title: '其他已注册任务', purpose: '不得穿过当前 live fence', owners: [],
            targetAppIds: [fence.workerAppId], workerAppIds: [fence.workerAppId], reviewerAppIds: [],
            access: { mode: 'write', scopes: fence.writeScopes }, status: 'in_progress', progress: 10,
            createdAt: NOW, updatedAt: NOW,
            taskControl: {
              taskGuid: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
              phaseId: 'workstream:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
              mappingRef: `topic-message:${foreignMappedRoot}`,
              mappingStatus: 'registered', sourceKind: 'project_group', controllerAppId: fence.controllerAppId,
              workerAppId: fence.workerAppId, reviewerAppId: fence.reviewerAppId,
              acceptorAppId: fence.acceptorAppId, projectRevision: 3, reservationId: 'e'.repeat(50),
              coordinatorSessionId: fence.coordinatorSessionId, originTurnId: 'om_foreign_origin',
              reservationCreatedAt: NOW, reservationExpiresAt: '2099-09-30T00:02:00.000Z', rootCreateTime: NOW,
              reservationProof: {
                schemaVersion: 'ProjectDispatchReservationProof.v1', larkAppId: fence.controllerAppId,
                issuedAt: NOW, keyId: 'tcpr1:foreign', signature: 'e'.repeat(64),
              },
            },
          }],
          completionGates: [], dispatchReservations: [], milestones: [], createdAt: NOW, updatedAt: NOW,
        },
      },
    }));
    writeFileSync(registryPath, JSON.stringify({
      [dispatchRoot]: {
        dispatchOperationId: operationId, targetAppIds: fence.targetAppIds,
        taskControl: { mode: 'audit_only', taskGuid },
      },
    }));
    mocks.replyMessage
      .mockRejectedValueOnce(new Error('provider response lost'))
      .mockImplementationOnce(async () => {
        const project = JSON.parse(readFileSync(projectPath, 'utf8'));
        project.projects[CHAT].workstreams[0].taskControl.mappingRef = 'topic-message:om_changed_after_send';
        writeFileSync(projectPath, JSON.stringify(project));
        return 'om_exact_kickoff';
      })
      .mockResolvedValueOnce('om_exact_kickoff');

    try {
      const deliveryInput = {
        context: {
          dataDir: mocks.dataDir, chatId: CHAT, larkAppId: fence.controllerAppId,
          coordinatorSessionId: fence.coordinatorSessionId,
        },
        dispatchRoot,
        operationId,
        attempt: {
          wallTime: NOW, bootId: 'boot-1', processStartIdentity: 'process-start-1', monotonicMs: 10_000,
        },
      } as const;
      const responseLost = await deliverProjectTaskControlKickoff(deliveryInput);
      expect(responseLost).toMatchObject({ state: 'pending' });

      const stableProject = readFileSync(projectPath, 'utf8');
      const stableRegistry = readFileSync(registryPath, 'utf8');
      const settleFailed = await deliverProjectTaskControlKickoff({
        ...deliveryInput,
        attempt: { ...deliveryInput.attempt, monotonicMs: 10_500 },
      });
      expect(settleFailed).toEqual({ state: 'ambiguous' });
      expect(JSON.parse(readFileSync(projectPath, 'utf8')).projects[CHAT].blockerRecords)
        .toContainEqual(expect.objectContaining({ code: 'task_control_canary_quarantine' }));
      writeFileSync(projectPath, stableProject);
      writeFileSync(registryPath, stableRegistry);

      registerBot({
        larkAppId: fence.workerAppId, larkAppSecret: 's', cliId: 'claude-code', allowedUsers: [OWNER],
      }).resolvedAllowedUsers = [OWNER];
      await expect(awaitProjectTaskControlInboundAdmission({
        dataDir: mocks.dataDir, chatId: CHAT, dispatchRoot: foreignMappedRoot,
        targetAppId: fence.workerAppId, messageId: 'om_foreign_mapped_message',
      })).resolves.toBe('rejected');
      await expect(awaitProjectTaskControlInboundAdmission({
        dataDir: mocks.dataDir, chatId: CHAT, dispatchRoot: 'om_ordinary_unmapped_root',
        targetAppId: fence.workerAppId, messageId: 'om_ordinary_message',
      })).resolves.toBe('unfenced');
      const ds = seedThreadSession(dispatchRoot, 'task-control-kickoff') as any;
      activeSessions.delete(sessionKey(dispatchRoot, APP));
      ds.larkAppId = fence.workerAppId;
      ds.session.larkAppId = fence.workerAppId;
      activeSessions.set(sessionKey(dispatchRoot, fence.workerAppId), ds);
      ds.pendingPrompt = purpose;
      ds.pendingTurnId = 'om_exact_kickoff';
      const trustedCaller = {
        requestLarkAppId: fence.controllerAppId,
        requestUserOpenId: 'ou_controller',
        senderType: 'bot' as const,
      };
      expect(() => forkReservedInitialSession(ds, [], trustedCaller))
        .toThrow('project_task_control_canary_fence_rejects_turn');
      expect(JSON.parse(readFileSync(registryPath, 'utf8'))
        .__taskControlTurnAdmissionsV1).toBeUndefined();

      const result = await deliverProjectTaskControlKickoff({
        ...deliveryInput,
        attempt: { ...deliveryInput.attempt, monotonicMs: 11_000 },
      });
      expect(result).toMatchObject({ state: 'delivered', messageId: 'om_exact_kickoff' });
      expect(mocks.replyMessage).toHaveBeenCalledTimes(3);
      const call = mocks.replyMessage.mock.calls[2]!;
      expect(mocks.replyMessage.mock.calls[0]?.[5]).toBe(call[5]);
      expect(mocks.replyMessage.mock.calls[1]?.[5]).toBe(call[5]);
      expect(call.slice(0, 2)).toEqual([fence.controllerAppId, dispatchRoot]);
      expect(call[3]).toBe('post');
      expect(call[4]).toBe(true);
      expect(call[5]).toMatch(/^[a-f0-9]{50}$/);
      expect(call[6]).toBeUndefined();
      expect(call[7]).toEqual({ timeoutMs: 5_000, signal: expect.any(AbortSignal) });
      const content = String(call[2]);
      expect(content).toContain('ou_worker');
      expect(content).toContain('ou_reviewer');
      expect(content).toContain(purpose);
      expect(content).toContain(`botmux report --dispatch-root ${dispatchRoot}`);
      const operation = JSON.parse(readFileSync(registryPath, 'utf8'))
        .__taskControlKickoffOperationsV1.operations[operationId];
      expect(operation).toMatchObject({
        schemaVersion: 'TaskControlKickoffOperation.v1', operationId,
        chatId: CHAT, dispatchRoot, fenceFingerprint: projectTaskControlCanaryFenceFingerprint(fence),
        targetAppIds: ['cli_reviewer', 'cli_worker'], messageType: 'post',
        payloadHash: createHash('sha256').update(content).digest('hex'),
        providerUuid: call[5], state: 'delivered', messageId: 'om_exact_kickoff',
      });

      const foreignDs = seedThreadSession(foreignMappedRoot, 'foreign-mapped-task') as any;
      activeSessions.delete(sessionKey(foreignMappedRoot, APP));
      foreignDs.larkAppId = fence.workerAppId;
      foreignDs.session.larkAppId = fence.workerAppId;
      foreignDs.worker = { killed: false, send: vi.fn() };
      activeSessions.set(sessionKey(foreignMappedRoot, fence.workerAppId), foreignDs);
      await expect(handleThreadReply(
        makeEventData('om_foreign_mapped_message', 'must be rejected before the live session', foreignMappedRoot),
        { ...makeCtx(foreignMappedRoot, 'om_foreign_mapped_message'), larkAppId: fence.workerAppId },
      )).rejects.toThrow('project_task_control_canary_fence_rejects_turn');
      expect(foreignDs.worker.send).not.toHaveBeenCalled();
      activeSessions.delete(sessionKey(foreignMappedRoot, fence.workerAppId));

      for (const rejected of [
        { messageId: 'om_direct_human_reply', caller: { ...trustedCaller, senderType: 'user' as const } },
        { messageId: 'om_alternate_bot_mention', caller: { ...trustedCaller, requestLarkAppId: 'cli_foreign' } },
        { messageId: 'om_cross_turn_into', caller: trustedCaller },
      ]) {
        ds.pendingTurnId = rejected.messageId;
        expect(() => forkReservedInitialSession(ds, [], rejected.caller))
          .toThrow('project_task_control_canary_fence_rejects_turn');
      }
      expect(mocks.forkWorker).not.toHaveBeenCalled();

      ds.pendingTurnId = 'om_exact_kickoff';
      mocks.forkWorker.mockImplementationOnce((workerDs: any, _input: any, turn: any) => {
        turn?.onWorkerGenerationReserved?.(10);
        workerDs.worker = { killed: false, send: vi.fn() };
        return true;
      });
      expect(forkReservedInitialSession(ds, [], trustedCaller)).toBe(true);
      expect(JSON.parse(readFileSync(registryPath, 'utf8'))
        .__taskControlTurnAdmissionsV1.claims.om_exact_kickoff).toMatchObject({
        messageId: 'om_exact_kickoff', dispatchRoot, targetAppId: fence.workerAppId,
        sessionId: ds.session.sessionId, workerGeneration: 10, state: 'active',
      });

      const activeWorkerSend = ds.worker!.send as ReturnType<typeof vi.fn>;
      await expect(handleThreadReply(
        makeEventData('om_exact_kickoff', 'duplicate provider delivery', dispatchRoot),
        { ...makeCtx(dispatchRoot, 'om_exact_kickoff'), larkAppId: fence.workerAppId },
      )).rejects.toThrow('project_task_control_canary_fence_rejects_turn');
      await expect(handleThreadReply(
        makeEventData('om_later_human_reply', 'run another turn', dispatchRoot),
        { ...makeCtx(dispatchRoot, 'om_later_human_reply'), larkAppId: fence.workerAppId },
      )).rejects.toThrow('project_task_control_canary_fence_rejects_turn');
      expect(activeWorkerSend).not.toHaveBeenCalled();

      const callsAfterWorker = mocks.forkWorker.mock.calls.length;
      ds.worker = null;
      await expect(handleThreadReply(
        makeEventData('om_later_refork_reply', 'restart another turn', dispatchRoot),
        { ...makeCtx(dispatchRoot, 'om_later_refork_reply'), larkAppId: fence.workerAppId },
      )).rejects.toThrow('project_task_control_canary_fence_rejects_turn');
      expect(mocks.forkWorker).toHaveBeenCalledTimes(callsAfterWorker);
      ds.pendingTurnId = 'om_exact_kickoff';
      expect(forkReservedInitialSession(ds, [], trustedCaller)).toBe(false);
      expect(mocks.forkWorker).toHaveBeenCalledTimes(callsAfterWorker);

      registerBot({
        larkAppId: fence.reviewerAppId, larkAppSecret: 's', cliId: 'claude-code', allowedUsers: [OWNER],
      }).resolvedAllowedUsers = [OWNER];
      const reviewerDs = seedThreadSession(dispatchRoot, 'task-control-kickoff-reviewer') as any;
      activeSessions.delete(sessionKey(dispatchRoot, APP));
      reviewerDs.larkAppId = fence.reviewerAppId;
      reviewerDs.session.larkAppId = fence.reviewerAppId;
      activeSessions.set(sessionKey(dispatchRoot, fence.reviewerAppId), reviewerDs);
      reviewerDs.pendingPrompt = purpose;
      reviewerDs.pendingTurnId = 'om_exact_kickoff';
      mocks.forkWorker.mockImplementationOnce((reviewerSession: any, _input: any, turn: any) => {
        turn?.onWorkerGenerationReserved?.(11);
        reviewerSession.worker = { killed: false, send: vi.fn() };
        return true;
      });
      expect(forkReservedInitialSession(reviewerDs, [], trustedCaller)).toBe(true);
      expect(Object.values(JSON.parse(readFileSync(registryPath, 'utf8'))
        .__taskControlTurnAdmissionsV1.claims)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          messageId: 'om_exact_kickoff', dispatchRoot, targetAppId: fence.workerAppId,
          sessionId: ds.session.sessionId, workerGeneration: 10, state: 'active',
        }),
        expect.objectContaining({
          messageId: 'om_exact_kickoff', dispatchRoot, targetAppId: fence.reviewerAppId,
          sessionId: reviewerDs.session.sessionId, workerGeneration: 11, state: 'active',
        }),
      ]));
      expect(terminalizeProjectTaskControlTurnAdmission(
        ds, 'om_exact_kickoff', 10, '2026-09-30T00:04:00.000Z',
      )).toBe(true);
      expect(terminalizeProjectTaskControlTurnAdmission(
        reviewerDs, 'om_exact_kickoff', 11, '2026-09-30T00:04:01.000Z',
      )).toBe(true);
      expect(Object.values(JSON.parse(readFileSync(registryPath, 'utf8'))
        .__taskControlTurnAdmissionsV1.claims)).toEqual(expect.arrayContaining([
        expect.objectContaining({ targetAppId: fence.workerAppId, state: 'terminal' }),
        expect.objectContaining({ targetAppId: fence.reviewerAppId, state: 'terminal' }),
      ]));
    } finally {
      rmSync(projectPath, { force: true });
      rmSync(registryPath, { force: true });
    }
  });

  it('rejects the exact historical inbound after its fence becomes an abandonment tombstone', async () => {
    const { fence } = writeAbandonedTaskControlFixture();

    await expect(awaitProjectTaskControlPhaseAInstruction({
      dataDir: mocks.dataDir,
      chatId: CHAT,
      dispatchRoot: fence.phaseA.historicalDispatchRoot,
      targetAppId: fence.phaseA.mappedWorkerAppId,
      messageId: 'om_late_phase_a_instruction',
    })).resolves.toBe('rejected');
  });

  it('allows unrelated ordinary inbound when an abandonment tombstone exists in the same chat', async () => {
    const { fence } = writeAbandonedTaskControlFixture();

    await expect(awaitProjectTaskControlInboundAdmission({
      dataDir: mocks.dataDir,
      chatId: CHAT,
      dispatchRoot: 'om_unrelated_ordinary_root',
      targetAppId: fence.workerAppId,
      messageId: 'om_unrelated_ordinary_message',
    })).resolves.toBe('unfenced');
  });

  it('allows a differently identified mapped root when an abandonment tombstone exists in the same chat', async () => {
    const { fence } = writeAbandonedTaskControlFixture();
    const projectPath = `${mocks.dataDir}/project-groups.json`;
    const projectRegistry = JSON.parse(readFileSync(projectPath, 'utf8'));
    const boundWorkstream = projectRegistry.projects[CHAT].workstreams[0];
    const dispatchRoot = 'om_unrelated_mapped_root';
    const taskGuid = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    projectRegistry.projects[CHAT].workstreams.push({
      ...boundWorkstream,
      dispatchRoot,
      title: 'unrelated mapped task',
      taskControl: {
        ...boundWorkstream.taskControl,
        taskGuid,
        phaseId: `workstream:${taskGuid}`,
        mappingRef: `topic-message:${dispatchRoot}`,
        reservationId: 'd'.repeat(50),
        originTurnId: 'om_unrelated_mapped_origin',
        reservationProof: {
          ...boundWorkstream.taskControl.reservationProof,
          keyId: 'tcpr1:unrelated',
          signature: 'd'.repeat(64),
        },
      },
    });
    writeFileSync(projectPath, JSON.stringify(projectRegistry));

    await expect(awaitProjectTaskControlInboundAdmission({
      dataDir: mocks.dataDir,
      chatId: CHAT,
      dispatchRoot,
      targetAppId: fence.workerAppId,
      messageId: 'om_unrelated_mapped_message',
    })).resolves.toBe('unfenced');
  });

  it('rejects the exact abandoned canary workstream when its registry operation is missing', async () => {
    const { dispatchRoot, fence } = writeAbandonedTaskControlFixture();
    rmSync(`${mocks.dataDir}/orchestrate-dispatch.json`, { force: true });

    await expect(awaitProjectTaskControlInboundAdmission({
      dataDir: mocks.dataDir,
      chatId: CHAT,
      dispatchRoot,
      targetAppId: fence.workerAppId,
      messageId: 'om_missing_registry_bound_message',
    })).resolves.toBe('rejected');
  });

  it('keeps a truly unrelated root unfenced when the abandoned registry operation is missing', async () => {
    const { fence } = writeAbandonedTaskControlFixture();
    rmSync(`${mocks.dataDir}/orchestrate-dispatch.json`, { force: true });

    await expect(awaitProjectTaskControlInboundAdmission({
      dataDir: mocks.dataDir,
      chatId: CHAT,
      dispatchRoot: 'om_unrelated_without_registry',
      targetAppId: fence.workerAppId,
      messageId: 'om_unrelated_without_registry_message',
    })).resolves.toBe('unfenced');
  });

  it('rejects a same-root workstream operation conflict when the registry operation is missing', async () => {
    const { dispatchRoot, fence } = writeAbandonedTaskControlFixture();
    const projectPath = `${mocks.dataDir}/project-groups.json`;
    const projectRegistry = JSON.parse(readFileSync(projectPath, 'utf8'));
    const exactWorkstream = projectRegistry.projects[CHAT].workstreams[0];
    projectRegistry.projects[CHAT].workstreams.push({
      ...exactWorkstream,
      taskControl: {
        ...exactWorkstream.taskControl,
        reservationId: 'd'.repeat(50),
        phaseId: `workstream:${fence.taskGuid}`,
        reservationProof: {
          ...exactWorkstream.taskControl.reservationProof,
          keyId: 'tcpr1:same-root-conflict',
          signature: 'd'.repeat(64),
        },
      },
    });
    writeFileSync(projectPath, JSON.stringify(projectRegistry));
    rmSync(`${mocks.dataDir}/orchestrate-dispatch.json`, { force: true });

    await expect(awaitProjectTaskControlInboundAdmission({
      dataDir: mocks.dataDir,
      chatId: CHAT,
      dispatchRoot,
      targetAppId: fence.reviewerAppId,
      messageId: 'om_same_root_operation_conflict',
    })).resolves.toBe('rejected');
  });

  it('rejects every registry root in an abandoned operation conflict but not an unrelated root', async () => {
    const { dispatchRoot, operationId, fence } = writeAbandonedTaskControlFixture();
    const registryPath = `${mocks.dataDir}/orchestrate-dispatch.json`;
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    const conflictingRoot = 'om_abandoned_registry_conflict';
    registry[conflictingRoot] = {
      ...registry[dispatchRoot],
      dispatchOperationId: operationId,
    };
    writeFileSync(registryPath, JSON.stringify(registry));

    for (const candidateRoot of [dispatchRoot, conflictingRoot]) {
      await expect(awaitProjectTaskControlInboundAdmission({
        dataDir: mocks.dataDir,
        chatId: CHAT,
        dispatchRoot: candidateRoot,
        targetAppId: fence.workerAppId,
        messageId: `om_registry_conflict_${candidateRoot}`,
      })).resolves.toBe('rejected');
    }
    await expect(awaitProjectTaskControlInboundAdmission({
      dataDir: mocks.dataDir,
      chatId: CHAT,
      dispatchRoot: 'om_registry_conflict_unrelated',
      targetAppId: fence.workerAppId,
      messageId: 'om_registry_conflict_unrelated_message',
    })).resolves.toBe('unfenced');
  });

  it('rejects the abandoned canary root after its current workstream identity drifts', async () => {
    const { dispatchRoot, fence } = writeAbandonedTaskControlFixture();
    const projectPath = `${mocks.dataDir}/project-groups.json`;
    const projectRegistry = JSON.parse(readFileSync(projectPath, 'utf8'));
    const mapping = projectRegistry.projects[CHAT].workstreams[0].taskControl;
    const taskGuid = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    mapping.taskGuid = taskGuid;
    mapping.phaseId = `workstream:${taskGuid}`;
    mapping.reservationId = 'e'.repeat(50);
    writeFileSync(projectPath, JSON.stringify(projectRegistry));

    await expect(awaitProjectTaskControlInboundAdmission({
      dataDir: mocks.dataDir,
      chatId: CHAT,
      dispatchRoot,
      targetAppId: fence.workerAppId,
      messageId: 'om_drifted_bound_root_message',
    })).resolves.toBe('rejected');
  });

  it('rejects the persisted abandoned canary root across target and message variations', async () => {
    const { dispatchRoot, fence } = writeAbandonedTaskControlFixture();
    const projectPath = `${mocks.dataDir}/project-groups.json`;
    const projectRegistry = JSON.parse(readFileSync(projectPath, 'utf8'));
    const mapping = projectRegistry.projects[CHAT].workstreams[0].taskControl;
    mapping.taskGuid = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    mapping.reservationId = 'e'.repeat(50);
    writeFileSync(projectPath, JSON.stringify(projectRegistry));

    for (const [targetAppId, messageId] of [
      [fence.workerAppId, 'om_drifted_worker_message'],
      [fence.reviewerAppId, 'om_drifted_reviewer_message'],
      ['cli_unrelated_target', 'om_drifted_unrelated_target_message'],
    ]) {
      await expect(awaitProjectTaskControlInboundAdmission({
        dataDir: mocks.dataDir,
        chatId: CHAT,
        dispatchRoot,
        targetAppId,
        messageId,
      })).resolves.toBe('rejected');
    }
  });

  it('rejects the persisted abandoned canary root when its current workstream is missing', async () => {
    const { dispatchRoot } = writeAbandonedTaskControlFixture();
    const projectPath = `${mocks.dataDir}/project-groups.json`;
    const projectRegistry = JSON.parse(readFileSync(projectPath, 'utf8'));
    projectRegistry.projects[CHAT].workstreams = [];
    writeFileSync(projectPath, JSON.stringify(projectRegistry));

    await expect(awaitProjectTaskControlInboundAdmission({
      dataDir: mocks.dataDir,
      chatId: CHAT,
      dispatchRoot,
      targetAppId: 'cli_unrelated_target',
      messageId: 'om_missing_workstream_message',
    })).resolves.toBe('rejected');
  });

  it('rejects the persisted abandoned canary root when its current workstream was replaced', async () => {
    const { dispatchRoot } = writeAbandonedTaskControlFixture();
    const projectPath = `${mocks.dataDir}/project-groups.json`;
    const projectRegistry = JSON.parse(readFileSync(projectPath, 'utf8'));
    const replacement = projectRegistry.projects[CHAT].workstreams[0];
    const replacementRoot = 'om_replacement_mapped_root';
    const replacementTaskGuid = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    replacement.dispatchRoot = replacementRoot;
    replacement.taskControl.taskGuid = replacementTaskGuid;
    replacement.taskControl.phaseId = `workstream:${replacementTaskGuid}`;
    replacement.taskControl.mappingRef = `topic-message:${replacementRoot}`;
    replacement.taskControl.reservationId = 'f'.repeat(50);
    writeFileSync(projectPath, JSON.stringify(projectRegistry));

    await expect(awaitProjectTaskControlInboundAdmission({
      dataDir: mocks.dataDir,
      chatId: CHAT,
      dispatchRoot,
      targetAppId: 'cli_replacement_target',
      messageId: 'om_replaced_workstream_message',
    })).resolves.toBe('rejected');
  });

  it('uses the durable tombstone root when registry and current workstream are both missing', async () => {
    const { dispatchRoot, fence } = writeAbandonedTaskControlFixture();
    const projectPath = `${mocks.dataDir}/project-groups.json`;
    const projectRegistry = JSON.parse(readFileSync(projectPath, 'utf8'));
    projectRegistry.projects[CHAT].workstreams = [];
    writeFileSync(projectPath, JSON.stringify(projectRegistry));
    rmSync(`${mocks.dataDir}/orchestrate-dispatch.json`, { force: true });

    await expect(awaitProjectTaskControlInboundAdmission({
      dataDir: mocks.dataDir,
      chatId: CHAT,
      dispatchRoot,
      targetAppId: fence.workerAppId,
      messageId: 'om_durable_bound_root_without_derived_state',
    })).resolves.toBe('rejected');
    await expect(awaitProjectTaskControlInboundAdmission({
      dataDir: mocks.dataDir,
      chatId: CHAT,
      dispatchRoot: 'om_unrelated_without_derived_state',
      targetAppId: fence.reviewerAppId,
      messageId: 'om_unrelated_without_derived_state_message',
    })).resolves.toBe('unfenced');
  });

  it('recovers one exact Phase-B root from a legacy v1 tombstone', async () => {
    const { dispatchRoot, fence } = writeAbandonedTaskControlFixture({ legacy: true });
    rmSync(`${mocks.dataDir}/orchestrate-dispatch.json`, { force: true });

    await expect(awaitProjectTaskControlInboundAdmission({
      dataDir: mocks.dataDir,
      chatId: CHAT,
      dispatchRoot,
      targetAppId: fence.workerAppId,
      messageId: 'om_legacy_unique_bound_root',
    })).resolves.toBe('rejected');
    await expect(awaitProjectTaskControlInboundAdmission({
      dataDir: mocks.dataDir,
      chatId: CHAT,
      dispatchRoot: 'om_legacy_unique_unrelated_root',
      targetAppId: fence.workerAppId,
      messageId: 'om_legacy_unique_unrelated_message',
    })).resolves.toBe('unfenced');
  });

  it('keeps an unrecoverable legacy v1 tombstone isolated instead of guessing unfenced', async () => {
    const { dispatchRoot, fence } = writeAbandonedTaskControlFixture({ legacy: true });
    const projectPath = `${mocks.dataDir}/project-groups.json`;
    const projectRegistry = JSON.parse(readFileSync(projectPath, 'utf8'));
    projectRegistry.projects[CHAT].workstreams = [];
    writeFileSync(projectPath, JSON.stringify(projectRegistry));
    rmSync(`${mocks.dataDir}/orchestrate-dispatch.json`, { force: true });

    for (const candidateRoot of [dispatchRoot, 'om_legacy_unrecoverable_unrelated']) {
      await expect(awaitProjectTaskControlInboundAdmission({
        dataDir: mocks.dataDir,
        chatId: CHAT,
        dispatchRoot: candidateRoot,
        targetAppId: fence.workerAppId,
        messageId: `om_legacy_unrecoverable_${candidateRoot}`,
      })).resolves.toBe('rejected');
    }
  });

  it('keeps a conflicting legacy v1 root recovery isolated', async () => {
    const { dispatchRoot, operationId, fence } = writeAbandonedTaskControlFixture({ legacy: true });
    const registryPath = `${mocks.dataDir}/orchestrate-dispatch.json`;
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    registry.om_legacy_conflicting_root = {
      ...registry[dispatchRoot],
      dispatchOperationId: operationId,
    };
    writeFileSync(registryPath, JSON.stringify(registry));

    await expect(awaitProjectTaskControlInboundAdmission({
      dataDir: mocks.dataDir,
      chatId: CHAT,
      dispatchRoot: 'om_legacy_conflict_unrelated',
      targetAppId: fence.workerAppId,
      messageId: 'om_legacy_conflict_unrelated_message',
    })).resolves.toBe('rejected');
  });

  it('rejects the exact bound-root ingress after abandonment before a durable claim or fork', () => {
    const { dispatchRoot, fence } = writeAbandonedTaskControlFixture();
    registerBot({
      larkAppId: fence.workerAppId, larkAppSecret: 's', cliId: 'claude-code', allowedUsers: [OWNER],
    }).resolvedAllowedUsers = [OWNER];
    const ds = seedThreadSession(dispatchRoot, 'abandoned canary') as any;
    activeSessions.delete(sessionKey(dispatchRoot, APP));
    ds.larkAppId = fence.workerAppId;
    ds.session.larkAppId = fence.workerAppId;
    ds.pendingPrompt = fence.purpose;
    ds.pendingTurnId = 'om_late_kickoff';
    activeSessions.set(sessionKey(dispatchRoot, fence.workerAppId), ds);

    expect(() => forkReservedInitialSession(ds, [], {
      requestLarkAppId: fence.controllerAppId,
      requestUserOpenId: 'ou_controller',
      senderType: 'bot' as const,
    })).toThrow('project_task_control_canary_abandoned');
    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(`${mocks.dataDir}/orchestrate-dispatch.json`, 'utf8'))
      .__taskControlTurnAdmissionsV1).toBeUndefined();
  });

  it('rechecks abandonment before fork when the mapped workstream disappears after ingress', () => {
    const { dispatchRoot, fence } = writeAbandonedTaskControlFixture();
    registerBot({
      larkAppId: fence.workerAppId, larkAppSecret: 's', cliId: 'claude-code', allowedUsers: [OWNER],
    }).resolvedAllowedUsers = [OWNER];
    const ds = seedThreadSession(dispatchRoot, 'abandoned canary after initial ingress') as any;
    activeSessions.delete(sessionKey(dispatchRoot, APP));
    ds.larkAppId = fence.workerAppId;
    ds.session.larkAppId = fence.workerAppId;
    ds.pendingPrompt = fence.purpose;
    ds.pendingTurnId = 'om_late_kickoff_after_mapping_removed';
    activeSessions.set(sessionKey(dispatchRoot, fence.workerAppId), ds);

    const projectPath = `${mocks.dataDir}/project-groups.json`;
    const projectRegistry = JSON.parse(readFileSync(projectPath, 'utf8'));
    projectRegistry.projects[CHAT].workstreams = [];
    writeFileSync(projectPath, JSON.stringify(projectRegistry));
    rmSync(`${mocks.dataDir}/orchestrate-dispatch.json`, { force: true });
    mocks.forkWorker.mockReturnValueOnce(true);

    expect(() => forkReservedInitialSession(ds, [], {
      requestLarkAppId: fence.controllerAppId,
      requestUserOpenId: 'ou_controller',
      senderType: 'bot' as const,
    })).toThrow('project_task_control_canary_abandoned');
    expect(mocks.forkWorker).not.toHaveBeenCalled();
  });

  it('rejects a kickoff provider replay after abandonment before calling Lark', async () => {
    const { dispatchRoot, operationId, fence } = writeAbandonedTaskControlFixture();

    await expect(deliverProjectTaskControlKickoff({
      context: {
        dataDir: mocks.dataDir, chatId: CHAT, larkAppId: fence.controllerAppId,
        coordinatorSessionId: fence.coordinatorSessionId,
      },
      dispatchRoot,
      operationId,
      attempt: {
        wallTime: NOW, bootId: 'boot-abandoned',
        processStartIdentity: 'process-abandoned', monotonicMs: 1_000,
      },
    })).rejects.toThrow('project_task_control_canary_abandoned');
    expect(mocks.replyMessage).not.toHaveBeenCalled();
  });

  it('does not journal a kickoff provider response that arrives after abandonment', async () => {
    const { dispatchRoot, operationId, fence } = writeAbandonedTaskControlFixture();
    const projectPath = `${mocks.dataDir}/project-groups.json`;
    const registryPath = `${mocks.dataDir}/orchestrate-dispatch.json`;
    const projectRegistry = JSON.parse(readFileSync(projectPath, 'utf8'));
    const liveFence = projectTaskControlCanaryFenceRecord(fence, NOW);
    projectRegistry.projects[CHAT].blockerRecords = [liveFence];
    projectRegistry.projects[CHAT].blockers = [liveFence.summary];
    writeFileSync(projectPath, JSON.stringify(projectRegistry));
    mocks.replyMessage.mockImplementationOnce(async () => {
      const current = JSON.parse(readFileSync(projectPath, 'utf8'));
      const tombstone = projectTaskControlCanaryAbandonedRecord(fence, {
        authorizationRef: 'om_abandon', authorizedByOpenId: 'ou_controller', abandonedAt: NOW,
      }, NOW);
      current.projects[CHAT].blockerRecords = [tombstone];
      current.projects[CHAT].blockers = [tombstone.summary];
      writeFileSync(projectPath, JSON.stringify(current));
      return 'om_late_kickoff_response';
    });

    try {
      await expect(deliverProjectTaskControlKickoff({
        context: {
          dataDir: mocks.dataDir, chatId: CHAT, larkAppId: fence.controllerAppId,
          coordinatorSessionId: fence.coordinatorSessionId,
        },
        dispatchRoot,
        operationId,
        attempt: {
          wallTime: NOW, bootId: 'boot-live',
          processStartIdentity: 'process-live', monotonicMs: 1_000,
        },
      })).resolves.toEqual({ state: 'ambiguous' });
      expect(mocks.replyMessage).toHaveBeenCalledOnce();
      expect(JSON.parse(readFileSync(registryPath, 'utf8'))
        .__taskControlKickoffOperationsV1.operations[operationId]).toMatchObject({ state: 'ambiguous' });
    } finally {
      rmSync(projectPath, { force: true });
      rmSync(registryPath, { force: true });
    }
  });

  it('retains a grouped opening buffers when its cold fork is synchronously refused outside marginal', () => {
    const ds = seedThreadSession('om_thread_group_opening_hard', 'seeded') as any;
    const coordinator = {
      sessionId: 'sess-xpi-coord-opening-hard',
      chatId: 'oc_coord_opening_hard',
      rootMessageId: 'om_coord_opening_hard',
      title: 'coordinator',
      status: 'active' as const,
      createdAt: NOW,
      chatType: 'group' as const,
      larkAppId: APP,
      xpiSharedCwdAdmissionGroupId: 'xpi:hard-opening',
      xpiSharedCwdAdmissionCoordinatorSessionId: 'sess-xpi-coord-opening-hard',
    };
    mocks.sessions.set(coordinator.sessionId, coordinator);
    Object.assign(ds.session, {
      larkAppId: APP,
      xpiSharedCwdAdmissionGroupId: 'xpi:hard-opening',
      xpiSharedCwdAdmissionCoordinatorSessionId: coordinator.sessionId,
    });
    mocks.sessions.set(ds.session.sessionId, ds.session);
    ds.pendingPrompt = 'grouped opening task';
    ds.pendingTurnId = 'om_group_opening_hard';
    const trustedCaller = {
      requestLarkAppId: APP,
      requestUserOpenId: OWNER,
      senderType: 'user' as const,
    };
    // Hard refusal with the marginal boolean shape but no marginal out-flag.
    mocks.forkWorker.mockImplementationOnce(() => true);

    const started = forkReservedInitialSession(ds, [], trustedCaller);

    expect(started).toBe(false);
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    // Nothing is parked in the journal; the opening buffers stay for the
    // existing inbound/release retry paths.
    expect(ds.session.xpiSharedCwdQueuedTurns ?? []).toEqual([]);
    expect(ds.pendingTurnId).toBe('om_group_opening_hard');
    expect(ds.pendingPrompt).toBe('grouped opening task');
  });
});

describe('XPI cross-app human classification identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.replyMessage.mockResolvedValue('om_reply');
    mocks.sendMessage.mockResolvedValue('om_top');
    mocks.sessions.clear();
    activeSessions.clear();
    mocks.resolveTargetAppOpenId.mockImplementation(async (_appId: string, unionId: string) => ({
      status: 'resolved' as const,
      openId: `ou_target_${unionId.slice(3)}`,
    }));
    setCardDispatcher(createLarkAskCardDispatcher({
      replyMessage: mocks.replyMessage,
      sendMessage: mocks.sendMessage,
      updateMessage: vi.fn(async () => undefined),
    }));
    setCanTalkChecker(() => true);
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: [OWNER],
    });
    bot.resolvedAllowedUsers = [OWNER, 'ou_target_proposer'];
  });

  it('resolves union_id in the receiving app and never reuses the source-app open_id', async () => {
    const ds = seedThreadSession('om_xpi_cross_app_identity', 'seeded');
    const result = await resolveXpiHumanOpenId(ds, {
      requestUserOpenId: 'ou_foreign_source_app',
      requestUserUnionId: 'on_proposer',
      requestLarkAppId: 'foreign-app-observer',
      senderType: 'user',
    }, 'proposer');

    expect(result).toEqual({
      status: 'resolved',
      openId: 'ou_target_proposer',
      source: 'resolved_from_union',
    });
    expect(mocks.resolveTargetAppOpenId).toHaveBeenCalledWith(APP, 'on_proposer');
  });

  it('fails closed when a proposer has only a source-app open_id', async () => {
    const ds = seedThreadSession('om_xpi_reject_foreign_open_id', 'seeded');
    await expect(resolveXpiHumanOpenId(ds, {
      requestUserOpenId: 'ou_foreign_source_app',
      requestLarkAppId: 'foreign-app-observer',
      senderType: 'user',
    }, 'proposer')).resolves.toEqual({ status: 'rejected_source_app_open_id' });
    expect(mocks.resolveTargetAppOpenId).not.toHaveBeenCalled();
  });

  it('accepts an open_id captured by this exact app without a contact lookup', async () => {
    // Same-app events (with or without a union_id stamp, and even when the
    // contact API would refuse the user) already carry a target-app open_id;
    // no conversion or owner-only fallback is needed.
    mocks.resolveTargetAppOpenId.mockResolvedValue({ status: 'definitive' });
    const ds = seedThreadSession('om_xpi_owner_target_fallback', 'seeded');
    await expect(resolveXpiHumanOpenId(ds, {
      requestUserOpenId: OWNER,
      requestUserUnionId: 'on_owner_hidden_from_contact',
      requestLarkAppId: APP,
      senderType: 'user',
    }, 'owner')).resolves.toEqual({
      status: 'resolved',
      openId: OWNER,
      source: 'target_app_same_app',
    });
    expect(mocks.resolveTargetAppOpenId).not.toHaveBeenCalled();
  });

  it('falls back to the owner open_id only for a cross-app-captured active owner', async () => {
    mocks.resolveTargetAppOpenId.mockResolvedValue({ status: 'definitive' });
    const ds = seedThreadSession('om_xpi_owner_cross_app_fallback', 'seeded');
    await expect(resolveXpiHumanOpenId(ds, {
      requestUserOpenId: OWNER,
      requestUserUnionId: 'on_owner_hidden_from_contact',
      requestLarkAppId: 'other-app',
      senderType: 'user',
    }, 'owner')).resolves.toEqual({
      status: 'resolved',
      openId: OWNER,
      source: 'target_app_owner',
    });
  });

  it('keeps a staged human message across bounded transient identity lookup retries', async () => {
    const previousXpi = process.env.BOTMUX_XPI_ENABLED;
    process.env.BOTMUX_XPI_ENABLED = 'true';
    mocks.resolveTargetAppOpenId.mockResolvedValue({ status: 'transient' });
    const ds = seedThreadSession('om_xpi_transient_identity_retry', 'seeded') as any;
    ds.session.crossPrincipalInterruptions = [{
      version: 1,
      id: 'xpi_transient_identity_1234',
      ownerTurnId: 'owner-turn',
      owner: { requestLarkAppId: APP, requestUserOpenId: OWNER, senderType: 'user' as const },
      proposer: {
        requestLarkAppId: 'foreign-app-observer',
        requestUserOpenId: 'ou_foreign_source_app',
        requestUserUnionId: 'on_proposer',
        senderType: 'user' as const,
      },
      phase: 'awaiting_classification',
      messages: [{
        turnId: 'om_transient_identity_message',
        text: '作为建议',
        userPrompt: '作为建议',
        createdAt: NOW,
      }],
    }];
    mocks.sessions.set(ds.session.sessionId, ds.session);

    try {
      await driveCrossPrincipalInterruptions(ds);
      expect(ds.session.crossPrincipalInterruptions).toEqual([
        expect.objectContaining({
          id: 'xpi_transient_identity_1234',
          identityResolutionRetry: { role: 'proposer', attempts: 1 },
        }),
      ]);
      expect(ds.crossPrincipalWaitTimer).toBeDefined();

      clearTimeout(ds.crossPrincipalWaitTimer);
      ds.crossPrincipalWaitTimer = undefined;
      await driveCrossPrincipalInterruptions(ds);
      expect(ds.session.crossPrincipalInterruptions?.[0]?.identityResolutionRetry)
        .toEqual({ role: 'proposer', attempts: 2 });

      clearTimeout(ds.crossPrincipalWaitTimer);
      ds.crossPrincipalWaitTimer = undefined;
      await driveCrossPrincipalInterruptions(ds);
      expect(ds.session.crossPrincipalInterruptions?.[0]).toMatchObject({
        phase: 'terminal_notice_pending',
        terminalNoticeAttempts: 1,
      });

      clearTimeout(ds.crossPrincipalWaitTimer);
      ds.crossPrincipalWaitTimer = undefined;
      await driveCrossPrincipalInterruptions(ds);
      expect(ds.session.crossPrincipalInterruptions?.[0]?.terminalNoticeAttempts).toBe(2);

      clearTimeout(ds.crossPrincipalWaitTimer);
      ds.crossPrincipalWaitTimer = undefined;
      await driveCrossPrincipalInterruptions(ds);
      expect(ds.session.crossPrincipalInterruptions).toBeUndefined();
      expect(mocks.resolveTargetAppOpenId).toHaveBeenCalledTimes(6);
    } finally {
      if (ds.crossPrincipalWaitTimer) clearTimeout(ds.crossPrincipalWaitTimer);
      ds.crossPrincipalWaitTimer = undefined;
      if (previousXpi === undefined) delete process.env.BOTMUX_XPI_ENABLED;
      else process.env.BOTMUX_XPI_ENABLED = previousXpi;
    }
  });

  it('binds the classification card to the target-app open_id and accepts that user click', async () => {
    const previousXpi = process.env.BOTMUX_XPI_ENABLED;
    process.env.BOTMUX_XPI_ENABLED = 'true';
    const anchor = 'om_xpi_cross_app_card';
    const ds = seedThreadSession(anchor, 'seeded') as any;
    ds.activeInteractiveTurn = {
      turnId: 'owner-turn',
      caller: { requestLarkAppId: APP, requestUserOpenId: OWNER, senderType: 'user' as const },
    };
    ds.session.crossPrincipalInterruptions = [{
      version: 1,
      id: 'xpi_cross_app_card_12345678',
      ownerTurnId: 'owner-turn',
      owner: { requestLarkAppId: APP, requestUserOpenId: OWNER, senderType: 'user' as const },
      proposer: {
        requestLarkAppId: 'foreign-app-observer',
        requestUserOpenId: 'ou_foreign_source_app',
        requestUserUnionId: 'on_proposer',
        senderType: 'user' as const,
      },
      phase: 'awaiting_classification',
      messages: [{
        turnId: 'om_cross_app_message',
        text: '作为建议',
        userPrompt: '作为建议',
        createdAt: NOW,
      }],
    }];
    mocks.sessions.set(ds.session.sessionId, ds.session);

    try {
      const driving = driveCrossPrincipalInterruptions(ds);
      await vi.waitFor(() => {
        expect(findPendingAskByAnchor({ larkAppId: APP, chatId: CHAT, anchor })).toBeDefined();
      });
      const ask = findPendingAskByAnchor({ larkAppId: APP, chatId: CHAT, anchor })!;
      expect(ask.answererOpenId).toBe('ou_target_proposer');
      expect(JSON.stringify(mocks.replyMessage.mock.calls)).not.toContain('ou_foreign_source_app');
      expect(tryResolveAsk({
        askId: ask.askId,
        nonce: ask.nonce,
        selected: 'suggestion',
        by: 'ou_target_proposer',
      })).toBe('accepted');
      await driving;
      expect(ds.session.crossPrincipalInterruptions).toEqual([
        expect.objectContaining({ phase: 'awaiting_owner' }),
      ]);
      expect(repliedText()).toContain('建议已暂存，将在当前任务结束后由原任务发起人确认。');
      expect(repliedText()).not.toContain('消息已暂存，不会打断当前任务。');
    } finally {
      if (ds.crossPrincipalWaitTimer) clearTimeout(ds.crossPrincipalWaitTimer);
      ds.crossPrincipalWaitTimer = undefined;
      if (previousXpi === undefined) delete process.env.BOTMUX_XPI_ENABLED;
      else process.env.BOTMUX_XPI_ENABLED = previousXpi;
    }
  });

  it('offers only an independent task when the active owner is a bot', async () => {
    const previousXpi = process.env.BOTMUX_XPI_ENABLED;
    process.env.BOTMUX_XPI_ENABLED = 'true';
    const anchor = 'om_xpi_bot_owner_human_card';
    const ds = seedThreadSession(anchor, 'seeded') as any;
    ds.activeInteractiveTurn = {
      turnId: 'owner-bot-turn',
      caller: { requestLarkAppId: 'owner-bot-app', requestUserOpenId: 'ou_owner_bot', senderType: 'bot' as const },
    };
    ds.worker = { killed: false, send: vi.fn() };
    ds.workerGeneration = 1;
    ds.session.workerGeneration = 1;
    ds.session.crossPrincipalInterruptions = [{
      version: 1,
      id: 'xpi_bot_owner_card_123456789',
      ownerTurnId: 'owner-bot-turn',
      owner: { requestLarkAppId: 'owner-bot-app', requestUserOpenId: 'ou_owner_bot', senderType: 'bot' as const },
      proposer: {
        requestLarkAppId: 'foreign-app-observer',
        requestUserOpenId: 'ou_foreign_source_app',
        requestUserUnionId: 'on_proposer',
        senderType: 'user' as const,
      },
      phase: 'awaiting_classification',
      messages: [{
        turnId: 'om_bot_owner_human_message',
        text: '请帮忙处理',
        userPrompt: '请帮忙处理',
        createdAt: NOW,
      }],
    }];
    mocks.sessions.set(ds.session.sessionId, ds.session);

    try {
      const driving = driveCrossPrincipalInterruptions(ds);
      await vi.waitFor(() => {
        expect(findPendingAskByAnchor({ larkAppId: APP, chatId: CHAT, anchor })).toBeDefined();
      });
      const ask = findPendingAskByAnchor({ larkAppId: APP, chatId: CHAT, anchor })!;
      expect(ask.questions[0]?.prompt).toContain('当前任务由机器人发起');
      expect(ask.questions[0]?.options).toEqual([
        { key: 'independent', label: '另开任务' },
      ]);
      expect(tryResolveAsk({
        askId: ask.askId,
        nonce: ask.nonce,
        selected: 'suggestion',
        by: 'ou_target_proposer',
      })).toBe('stale');
      expect(tryResolveAsk({
        askId: ask.askId,
        nonce: ask.nonce,
        selected: 'independent',
        by: 'ou_target_proposer',
      })).toBe('accepted');
      await driving;
      expect(ds.session.crossPrincipalInterruptions?.[0]?.phase)
        .toMatch(/preparing_independent|independent_queued/);
      expect(repliedText()).not.toContain('--as');
      expect(repliedText()).not.toContain('requestLarkAppId');
      expect(repliedText()).not.toContain('turnId');
    } finally {
      if (ds.crossPrincipalWaitTimer) clearTimeout(ds.crossPrincipalWaitTimer);
      ds.crossPrincipalWaitTimer = undefined;
      if (previousXpi === undefined) delete process.env.BOTMUX_XPI_ENABLED;
      else process.env.BOTMUX_XPI_ENABLED = previousXpi;
    }
  });

  it('fails closed with human guidance when the target app cannot resolve the proposer', async () => {
    const previousXpi = process.env.BOTMUX_XPI_ENABLED;
    process.env.BOTMUX_XPI_ENABLED = 'true';
    mocks.resolveTargetAppOpenId.mockResolvedValue({ status: 'definitive' });
    const ds = seedThreadSession('om_xpi_cross_app_unresolvable', 'seeded') as any;
    ds.activeInteractiveTurn = {
      turnId: 'owner-turn',
      caller: { requestLarkAppId: APP, requestUserOpenId: OWNER, senderType: 'user' as const },
    };
    ds.session.crossPrincipalInterruptions = [{
      version: 1,
      id: 'xpi_cross_app_missing_123456',
      ownerTurnId: 'owner-turn',
      owner: { requestLarkAppId: APP, requestUserOpenId: OWNER, senderType: 'user' as const },
      proposer: {
        requestLarkAppId: 'foreign-app-observer',
        requestUserOpenId: 'ou_foreign_source_app',
        requestUserUnionId: 'on_unresolvable',
        senderType: 'user' as const,
      },
      phase: 'awaiting_classification',
      messages: [{
        turnId: 'om_cross_app_unresolvable',
        text: 'human message',
        userPrompt: 'human message',
        createdAt: NOW,
      }],
    }];
    mocks.sessions.set(ds.session.sessionId, ds.session);

    try {
      await driveCrossPrincipalInterruptions(ds);
      expect(ds.session.crossPrincipalInterruptions?.[0]).toMatchObject({
        phase: 'terminal_notice_pending',
        terminalNoticeAttempts: 1,
      });
      expect(ds.crossPrincipalWaitTimer).toBeDefined();

      clearTimeout(ds.crossPrincipalWaitTimer);
      ds.crossPrincipalWaitTimer = undefined;
      await driveCrossPrincipalInterruptions(ds);
      expect(ds.session.crossPrincipalInterruptions?.[0]?.terminalNoticeAttempts).toBe(2);

      clearTimeout(ds.crossPrincipalWaitTimer);
      ds.crossPrincipalWaitTimer = undefined;
      await driveCrossPrincipalInterruptions(ds);
    } finally {
      if (ds.crossPrincipalWaitTimer) clearTimeout(ds.crossPrincipalWaitTimer);
      ds.crossPrincipalWaitTimer = undefined;
      if (previousXpi === undefined) delete process.env.BOTMUX_XPI_ENABLED;
      else process.env.BOTMUX_XPI_ENABLED = previousXpi;
    }

    expect(ds.session.crossPrincipalInterruptions).toBeUndefined();
    expect(repliedText()).toBe('');
    expect(ds.session.crossPrincipalInterruptionDeliveryAudits?.at(-1)).toMatchObject({
      event: 'delivery_exhausted',
      reason: 'terminal notice outer retry exhausted; closing on audit plane',
    });
    expect(repliedText()).not.toContain('ou_foreign_source_app');
    expect(repliedText()).not.toContain('--as');
  });
});

describe('XPI human terminal alert delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.replyMessage.mockResolvedValue('om_reply');
    mocks.sendMessage.mockResolvedValue('om_top');
    mocks.sessions.clear();
    activeSessions.clear();
    mocks.resolveTargetAppOpenId.mockImplementation(async (_appId: string, unionId: string) => ({
      status: 'resolved' as const,
      openId: `ou_target_${unionId.slice(3)}`,
    }));
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: [OWNER],
    });
    bot.resolvedAllowedUsers = [OWNER];
  });

  function seedAlertRecord(ds: DaemonSession): any {
    return {
      version: 1,
      id: 'xpi_alert_test_123456789012',
      ownerTurnId: 'owner-turn',
      owner: { requestLarkAppId: APP, requestUserOpenId: OWNER, senderType: 'user' },
      proposer: {
        requestLarkAppId: 'proposer-app',
        requestUserOpenId: 'ou_foreign_source_app',
        requestUserUnionId: 'on_human_proposer',
        senderType: 'user',
      },
      phase: 'awaiting_classification',
      messages: [{
        turnId: 'turn-with-secret',
        text: 'secret-original-body-should-not-leak',
        userPrompt: 'secret-original-body-should-not-leak',
        createdAt: NOW,
      }],
    };
  }

  it('does not send XPI outcomes for an already closed session', async () => {
    const ds = seedThreadSession('om_alert_closed', 'seeded');
    ds.session.status = 'closed';

    await expect(notifyCrossPrincipalTerminal(ds, seedAlertRecord(ds), '未选择处理方式')).resolves.toBe(false);

    expect(mocks.replyMessage).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.resolveTargetAppOpenId).not.toHaveBeenCalled();
  });

  it('stops an XPI outcome when the session closes during identity resolution', async () => {
    const ds = seedThreadSession('om_alert_close_lookup', 'seeded');
    let resolveIdentity!: (result: { status: 'resolved'; openId: string }) => void;
    mocks.resolveTargetAppOpenId.mockImplementationOnce(() => new Promise(resolve => { resolveIdentity = resolve; }));
    const sending = notifyCrossPrincipalTerminal(ds, seedAlertRecord(ds), '未选择处理方式');
    expect(mocks.resolveTargetAppOpenId).toHaveBeenCalledOnce();

    ds.session.status = 'closed';
    resolveIdentity({ status: 'resolved', openId: 'ou_target_proposer' });

    await expect(sending).resolves.toBe(false);
    expect(mocks.replyMessage).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it('stops XPI transport retries when the session closes during retry backoff', async () => {
    vi.useFakeTimers();
    const ds = seedThreadSession('om_alert_close_retry', 'seeded');
    mocks.replyMessage.mockRejectedValueOnce(new Error('temporary failure'));
    try {
      const sending = notifyCrossPrincipalTerminal(ds, seedAlertRecord(ds), '未选择处理方式');
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.replyMessage).toHaveBeenCalledOnce();
      ds.session.status = 'closed';

      await vi.advanceTimersByTimeAsync(1_500);
      await expect(sending).resolves.toBe(false);

      expect(mocks.replyMessage).toHaveBeenCalledOnce();
      expect(mocks.sendMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reschedule or persist an XPI terminal cycle after close during delivery', async () => {
    const previousXpi = process.env.BOTMUX_XPI_ENABLED;
    process.env.BOTMUX_XPI_ENABLED = 'true';
    const ds = seedThreadSession('om_alert_close_cycle', 'seeded');
    const record = seedAlertRecord(ds);
    record.phase = 'terminal_notice_pending';
    record.terminalNoticeText = '未选择处理方式';
    ds.session.crossPrincipalInterruptions = [record];
    mocks.sessions.set(ds.session.sessionId, ds.session);
    mocks.replyMessage.mockImplementationOnce(async () => {
      ds.session.status = 'closed';
      ds.session.crossPrincipalInterruptions = undefined;
      mocks.updateSession.mockClear();
      throw new Error('delivery interrupted by close');
    });
    try {
      await driveCrossPrincipalInterruptions(ds);

      expect(mocks.replyMessage).toHaveBeenCalledOnce();
      expect(mocks.updateSession).not.toHaveBeenCalled();
      expect(ds.crossPrincipalWaitTimer).toBeUndefined();
      expect(ds.crossPrincipalInterruptionDriving).toBe(false);
    } finally {
      if (ds.crossPrincipalWaitTimer) clearTimeout(ds.crossPrincipalWaitTimer);
      if (previousXpi === undefined) delete process.env.BOTMUX_XPI_ENABLED;
      else process.env.BOTMUX_XPI_ENABLED = previousXpi;
    }
  });

  it('records delivery_failed for three failures and then delivery_exhausted', async () => {
    const ds = seedThreadSession('om_alert_retry', 'seeded');
    const record = seedAlertRecord(ds);
    mocks.replyMessage.mockRejectedValue(new Error('alert transport down'));
    mocks.sendMessage.mockRejectedValue(new Error('alert transport down'));

    await expect(notifyCrossPrincipalTerminal(ds, record, '未选择处理方式')).resolves.toBe(false);

    expect(ds.session.crossPrincipalInterruptionDeliveryAudits?.map((item: any) => item.event))
      .toEqual(['delivery_failed', 'delivery_failed', 'delivery_failed', 'delivery_exhausted']);
    expect(repliedText()).not.toContain('secret-original-body-should-not-leak');
  });

  it('records recovery on the second attempt and does not exhaust', async () => {
    const ds = seedThreadSession('om_alert_recover', 'seeded');
    const record = seedAlertRecord(ds);
    mocks.replyMessage
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('om_recovered');

    await expect(notifyCrossPrincipalTerminal(ds, record, '未选择处理方式')).resolves.toBe(true);

    expect(ds.session.crossPrincipalInterruptionDeliveryAudits?.map((item: any) => item.event))
      .toEqual(['delivery_failed', 'delivery_recovered']);
    expect(ds.session.crossPrincipalInterruptionDeliveryAudits?.some((item: any) => item.event === 'delivery_exhausted')).toBe(false);
    expect(repliedText()).toContain('你未选择处理方式，该消息未执行。请重新发送。');
    expect(repliedText()).not.toContain('接收应用');
    expect(repliedText()).not.toContain('发送者类型');
    expect(repliedText()).not.toContain('--as');
    expect(repliedText()).not.toContain('generic terminal reason');
  });

  it('uses target-app identity and human guidance without bot --as instructions', async () => {
    const ds = seedThreadSession('om_alert_cross_app_human', 'seeded');
    const record = {
      ...seedAlertRecord(ds),
      proposer: {
        requestLarkAppId: 'foreign-app-observer',
        requestUserOpenId: 'ou_foreign_source_app',
        requestUserUnionId: 'on_human_proposer',
        senderType: 'user',
      },
      messages: [{
        turnId: 'om_x100b65fde2fa2cb0c224fa8cbfcb084',
        text: 'secret-original-body-should-not-leak',
        userPrompt: 'secret-original-body-should-not-leak',
        createdAt: NOW,
      }],
    };

    await expect(notifyCrossPrincipalTerminal(ds, record as any, '未选择处理方式')).resolves.toBe(true);

    expect(repliedText()).toContain('<at id=ou_target_human_proposer></at>');
    expect(repliedText()).toContain('你未选择处理方式，该消息未执行。请重新发送。');
    expect(repliedText()).not.toContain('ou_foreign_source_app');
    expect(repliedText()).not.toContain('--as');
    expect(repliedText()).not.toContain('发送者类型');
    expect(repliedText()).not.toContain('接收应用');
    expect(repliedText()).not.toContain('turnId');
    expect(repliedText()).not.toContain('4fa8cbfcb084');
    expect(repliedText()).not.toContain('secret-original-body-should-not-leak');
  });

  it('fails closed outside a group/topic and records the route reason without sending', async () => {
    const ds = seedThreadSession('om_alert_private', 'seeded');
    ds.chatType = 'p2p';
    const record = seedAlertRecord(ds);

    await expect(notifyCrossPrincipalTerminal(ds, record, 'generic terminal reason')).resolves.toBe(false);

    expect(mocks.replyMessage).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(ds.session.crossPrincipalInterruptionDeliveryAudits?.map((item: any) => item.reason))
      .toEqual(['alert route is not a group/topic', 'alert route is not a group/topic']);
  });
});

/** 让匹配 predicate 的回复失败，其余照常成功（模拟 Lark 瞬时发送故障只打中某一条）。 */
function failRepliesMatching(predicate: (content: string) => boolean, message: string): void {
  mocks.replyMessage.mockImplementation(async (...args: any[]) => {
    if (predicate(String(args[2] ?? ''))) throw new Error(message);
    return 'om_reply';
  });
  mocks.sendMessage.mockImplementation(async (...args: any[]) => {
    if (predicate(String(args[2] ?? ''))) throw new Error(message);
    return 'om_top';
  });
}

describe('durable admission then failing status reply → no resend advice (PR #846 review)', () => {
  const resendNotice = () => tr('daemon.ordinary_ingress_failed', undefined, localeForBot(APP));
  const admittedNotice = () => tr('daemon.ordinary_ingress_admitted_reply_failed', undefined, localeForBot(APP));
  const chooseRepoNotice = () => tr('daemon.choose_repo_first', undefined, localeForBot(APP));

  beforeEach(() => {
    vi.clearAllMocks();
    mkdirSync(mocks.dataDir, { recursive: true });
    mocks.replyMessage.mockResolvedValue('om_reply');
    mocks.sendMessage.mockResolvedValue('om_top');
    mocks.getChatMode.mockResolvedValue('group');
    mocks.getChatNameAndMode.mockResolvedValue({ name: null, mode: 'group' });
    mocks.sessions.clear();
    mocks.forkWorker.mockImplementation((ds: any) => {
      ds.worker = { killed: false, send: vi.fn() };
    });
    mocks.scanMultipleProjects.mockReturnValue([]);
    mocks.getAvailableBots.mockResolvedValue([]);
    mocks.downloadResources.mockResolvedValue({ attachments: [], needLogin: false });
    activeSessions.clear();
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: [OWNER],
    });
    bot.resolvedAllowedUsers = [OWNER];
  });

  it('pending-repo follower admitted to the durable tail: failing status reply keeps exactly one tail entry and never advises a resend', async () => {
    const anchor = 'om_thread_pending_repo_1';
    const ds = seedThreadSession(anchor, 'seeded') as any;
    ds.pendingRepo = true;
    ds.pendingPrompt = 'durable opening';
    ds.pendingTurnId = 'om_opening_turn';
    failRepliesMatching(c => c.includes(chooseRepoNotice()), 'lark transient send failure');

    await expect(
      handleThreadReply(makeEventData('om_msg_pr1', 'follow-up work', anchor), makeCtx(anchor, 'om_msg_pr1')),
    ).rejects.toThrow('lark transient send failure');

    expect(repliedText()).not.toContain(resendNotice());
    expect(repliedText()).toContain(admittedNotice());
    expect(ds.session.queuedActivationTail?.length ?? 0).toBe(1);
  });

  it('pending-repo opening staged durably: failing status reply never advises a resend', async () => {
    const anchor = 'om_thread_pending_repo_2';
    const ds = seedThreadSession(anchor, 'seeded') as any;
    ds.pendingRepo = true;
    ds.pendingPrompt = '';
    failRepliesMatching(c => c.includes(chooseRepoNotice()), 'lark transient send failure');

    await expect(
      handleThreadReply(makeEventData('om_msg_pr2', 'becomes the opening', anchor), makeCtx(anchor, 'om_msg_pr2')),
    ).rejects.toThrow('lark transient send failure');

    expect(repliedText()).not.toContain(resendNotice());
    expect(repliedText()).toContain(admittedNotice());
    expect(ds.session.pendingRepoSetup?.turnId).toBe('om_msg_pr2');
  });

  // A failing repo card used to escape this handler and land here as an
  // "admitted, do not resend" notice. That was the least-bad reading of a wedge:
  // the turn was durably staged behind a picker that did not exist, so every
  // follow-up hit 「请先在上方卡片中选择仓库」 and a restart re-published the same
  // card. The publish sites now degrade instead — no picker means fork with the
  // default cwd — so the turn actually runs. The invariant this case was written
  // for still holds and is what it now pins: a failed card never advises a
  // resend and never duplicates the queue item.
  it('new topic staged + queued durably: a failing repo card degrades to a working session instead of wedging', async () => {
    const anchor = 'om_msg_nt_admitted';
    mocks.scanMultipleProjects.mockReturnValue([
      { name: 'demo', path: '/tmp/botmux-demo', type: 'repo', branch: 'main' },
    ] as any);
    failRepliesMatching(() => false, 'unused');
    mocks.replyMessage.mockImplementation(async (...args: any[]) => {
      if (args[3] === 'interactive') throw new Error('lark card send failure');
      return 'om_reply';
    });
    mocks.sendMessage.mockImplementation(async (...args: any[]) => {
      if (args[3] === 'interactive') throw new Error('lark card send failure');
      return 'om_top';
    });

    await handleNewTopic(makeEventData(anchor, 'start a durable task'), makeCtx(anchor, anchor));

    const ds: any = activeSessions.get(sessionKey(anchor, APP));
    expect(ds?.pendingRepo).toBe(false);
    expect(ds?.repoCardMessageId).toBeUndefined();
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    expect(repliedText()).not.toContain(resendNotice());
    expect(repliedText()).not.toContain(chooseRepoNotice());
    expect(messageQueue.readUnread(anchor).length).toBe(1);
  });

  // 同一降级的另外两个发卡点。三处的 fallback 各自不同（raw passthrough 走
  // forkReservedInitialRawSession，auto-create 走 noteTurnReceived +
  // forkReservedInitialSession），所以分别钉住，避免只在一处补了兜底。
  it('initial raw passthrough: a failing repo card runs the command on the default cwd', async () => {
    const anchor = 'om_msg_raw_passthrough';
    mocks.scanMultipleProjects.mockReturnValue([
      { name: 'demo', path: '/tmp/botmux-demo', type: 'repo', branch: 'main' },
    ] as any);
    mocks.replyMessage.mockImplementation(async (...args: any[]) => {
      if (args[3] === 'interactive') throw new Error('lark card send failure');
      return 'om_reply';
    });
    mocks.sendMessage.mockImplementation(async (...args: any[]) => {
      if (args[3] === 'interactive') throw new Error('lark card send failure');
      return 'om_top';
    });

    // /goal is claude-code's adapter default passthrough → initial raw passthrough route.
    await handleNewTopic(makeEventData(anchor, '/goal ship the fix'), makeCtx(anchor, anchor));

    const ds: any = activeSessions.get(sessionKey(anchor, APP));
    expect(ds?.pendingRepo).toBe(false);
    expect(ds?.repoCardMessageId).toBeUndefined();
    // The raw command survives the degradation — it is what gets executed.
    expect(ds?.pendingRawInput).toBe('/goal ship the fix');
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    expect(repliedText()).not.toContain(resendNotice());
  });

  it('thread auto-create: a failing repo card forks the new session on the default cwd', async () => {
    const anchor = 'om_autocreate_root';
    mocks.scanMultipleProjects.mockReturnValue([
      { name: 'demo', path: '/tmp/botmux-demo', type: 'repo', branch: 'main' },
    ] as any);
    mocks.replyMessage.mockImplementation(async (...args: any[]) => {
      if (args[3] === 'interactive') throw new Error('lark card send failure');
      return 'om_reply';
    });
    mocks.sendMessage.mockImplementation(async (...args: any[]) => {
      if (args[3] === 'interactive') throw new Error('lark card send failure');
      return 'om_top';
    });

    // A reply under a root with no session → auto-create takes the picker route.
    await handleThreadReply(
      makeEventData('om_autocreate_msg', 'auto create me', anchor),
      makeCtx(anchor, 'om_autocreate_msg'),
    );

    const ds: any = activeSessions.get(sessionKey(anchor, APP));
    expect(ds?.pendingRepo).toBe(false);
    expect(ds?.repoCardMessageId).toBeUndefined();
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    expect(repliedText()).not.toContain(resendNotice());
    expect(repliedText()).not.toContain(chooseRepoNotice());
  });

  it('a failing admitted-notice never masks the original status-reply error', async () => {
    const anchor = 'om_thread_pending_repo_3';
    const ds = seedThreadSession(anchor, 'seeded') as any;
    ds.pendingRepo = true;
    ds.pendingPrompt = 'durable opening';
    failRepliesMatching(
      c => c.includes(chooseRepoNotice()) || c.includes(admittedNotice()),
      'status reply transport down',
    );

    await expect(
      handleThreadReply(makeEventData('om_msg_pr3', 'follow-up work', anchor), makeCtx(anchor, 'om_msg_pr3')),
    ).rejects.toThrow('status reply transport down');

    expect(repliedText()).not.toContain(resendNotice());
    expect(ds.session.queuedActivationTail?.length ?? 0).toBe(1);
  });

  it('pre-admission failure still advises a resend (unchanged behavior)', async () => {
    const anchor = 'om_thread_pre_admission';
    seedThreadSession(anchor, 'seeded');
    mocks.downloadResources.mockRejectedValue(new Error('boom: before any admission'));

    await expect(
      handleThreadReply(makeEventData('om_msg_pre', 'never admitted', anchor), makeCtx(anchor, 'om_msg_pre')),
    ).rejects.toThrow('boom: before any admission');

    expect(repliedText()).toContain(resendNotice());
    expect(repliedText()).not.toContain(admittedNotice());
  });

  it('worker-dead refork failure still advises a resend: the turn was never accepted anywhere durable', async () => {
    const anchor = 'om_thread_refork_fail';
    const ds = seedThreadSession(anchor, 'seeded') as any;
    ds.hasHistory = true;
    mocks.forkWorker.mockImplementation(() => {
      throw new Error('fork failed: EAGAIN');
    });

    await expect(
      handleThreadReply(makeEventData('om_msg_refork', 'run the task', anchor), makeCtx(anchor, 'om_msg_refork')),
    ).rejects.toThrow('fork failed: EAGAIN');

    expect(repliedText()).toContain(resendNotice());
    expect(repliedText()).not.toContain(admittedNotice());
  });

  it('a rejected /vc-auth (pure-reply branch, no side effect) still advises a resend', async () => {
    const anchor = 'om_thread_vc_auth_help';
    seedThreadSession(anchor, 'seeded');
    failRepliesMatching(() => true, 'vc-auth usage send failure');

    await expect(
      handleThreadReply(makeEventData('om_msg_vcauth', '/vc-auth help', anchor), makeCtx(anchor, 'om_msg_vcauth')),
    ).rejects.toThrow('vc-auth usage send failure');

    expect(repliedText()).toContain(resendNotice());
    expect(repliedText()).not.toContain(admittedNotice());
  });
});

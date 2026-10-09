import { createHash } from 'node:crypto';
import {
  readScheduleRuntimeState,
  writeScheduleRuntimeState,
} from './schedule-runtime-state-store.js';

export interface SendScheduleDeliveryOnceInput {
  dataDir: string;
  chatId: string;
  taskId: string;
  runAt: string;
  turnId: string;
  now?: () => string;
  send: (providerKey: string) => Promise<string>;
}

export interface SendScheduleDeliveryOnceResult {
  messageId: string;
  providerKey: string;
  runKey: string;
}

export const SCHEDULE_DELIVERY_PROVIDER_DEDUPE_TTL_MS = 60 * 60 * 1000;
const SCHEDULE_DELIVERY_RETRY_SAFETY_MS = 30 * 1000;

function canonicalIso(value: string, field: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`invalid_${field}`);
  const canonical = new Date(time).toISOString();
  if (canonical !== value) throw new Error(`invalid_${field}`);
  return canonical;
}

export function scheduleDeliveryProviderKey(chatId: string, runKey: string): string {
  const digest = createHash('sha256').update(`${chatId}\0${runKey}`).digest('hex');
  return `schedule-${digest.slice(0, 41)}`;
}

export async function sendScheduleDeliveryOnce(
  input: SendScheduleDeliveryOnceInput,
): Promise<SendScheduleDeliveryOnceResult> {
  const runAt = canonicalIso(input.runAt, 'run_at');
  const runKey = `${input.taskId}:${runAt}`;
  const attemptAt = canonicalIso((input.now ?? (() => new Date().toISOString()))(), 'claimed_at');
  const current = readScheduleRuntimeState('delivery', input.chatId, input.dataDir);
  let claimedAt = attemptAt;
  let retryDeadlineMs: number | undefined;
  if (current.state?.runKey === runKey && current.state.status === 'delivery_failed') {
    if (current.state.messageId !== null || typeof current.state.claimedAt !== 'string') {
      throw new Error('delivery_retry_not_safe');
    }
    claimedAt = canonicalIso(current.state.claimedAt, 'claimed_at');
    const elapsedMs = Date.parse(attemptAt) - Date.parse(claimedAt);
    if (elapsedMs < 0) throw new Error('delivery_retry_clock_invalid');
    retryDeadlineMs = Date.parse(claimedAt)
      + SCHEDULE_DELIVERY_PROVIDER_DEDUPE_TTL_MS
      - SCHEDULE_DELIVERY_RETRY_SAFETY_MS;
    if (Date.parse(attemptAt) >= retryDeadlineMs) {
      throw new Error('delivery_retry_window_expired');
    }
  }
  const claim = {
    schemaVersion: 1,
    chatId: input.chatId,
    hourlyTaskId: input.taskId,
    runKey,
    status: 'sending',
    claimedAt,
    lastAttemptRunAt: attemptAt,
    turnId: input.turnId,
    messageId: null,
    lastError: null,
  };
  const claimed = writeScheduleRuntimeState({
    kind: 'delivery',
    chatId: input.chatId,
    expectedSha256: current.sha256,
    next: claim,
    dataDir: input.dataDir,
    now: () => attemptAt,
  });
  const providerKey = scheduleDeliveryProviderKey(input.chatId, runKey);
  const failClaim = (lastError: string, lastAttemptRunAt: string): void => {
    writeScheduleRuntimeState({
      kind: 'delivery',
      chatId: input.chatId,
      expectedSha256: claimed.sha256,
      next: {
        ...claim,
        status: 'delivery_failed',
        lastAttemptRunAt,
        lastError,
      },
      dataDir: input.dataDir,
      now: () => lastAttemptRunAt,
    });
  };

  if (retryDeadlineMs !== undefined) {
    const effectAt = canonicalIso((input.now ?? (() => new Date().toISOString()))(), 'send_at');
    if (Date.parse(effectAt) < Date.parse(attemptAt)) {
      failClaim('delivery_retry_clock_invalid', effectAt);
      throw new Error('delivery_retry_clock_invalid');
    }
    if (Date.parse(effectAt) >= retryDeadlineMs) {
      failClaim('delivery_retry_window_expired', effectAt);
      throw new Error('delivery_retry_window_expired');
    }
  }

  let messageId: string;
  try {
    messageId = await input.send(providerKey);
  } catch (error) {
    failClaim(error instanceof Error ? error.message : String(error), attemptAt);
    throw error;
  }

  writeScheduleRuntimeState({
    kind: 'delivery',
    chatId: input.chatId,
    expectedSha256: claimed.sha256,
    next: {
      ...claim,
      status: 'sent',
      messageId,
      sentAt: attemptAt,
    },
    dataDir: input.dataDir,
    now: () => attemptAt,
  });
  return { messageId, providerKey, runKey };
}

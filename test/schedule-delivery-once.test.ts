import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  scheduleDeliveryProviderKey,
  sendScheduleDeliveryOnce,
} from '../src/services/schedule-delivery-once.js';
import {
  readScheduleRuntimeState,
  writeScheduleRuntimeState,
} from '../src/services/schedule-runtime-state-store.js';

const dirs: string[] = [];

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-schedule-delivery-once-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const base = {
  chatId: 'oc_demo',
  taskId: 'task1234',
  runAt: '2026-09-28T10:00:00.000Z',
  turnId: 'schedule:task1234:11111111-1111-4111-8111-111111111111',
  now: () => '2026-09-28T10:00:01.000Z',
};

describe('schedule delivery once', () => {
  it('claims a new run, sends once with a stable provider key, and records the message id', async () => {
    const dataDir = tempDataDir();
    const send = vi.fn(async () => 'om_sent');

    const result = await sendScheduleDeliveryOnce({ ...base, dataDir, send });

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(result.providerKey);
    expect(result.providerKey).toHaveLength(50);
    expect(result.providerKey).toBe(scheduleDeliveryProviderKey(base.chatId, result.runKey));
    expect(readScheduleRuntimeState('delivery', base.chatId, dataDir).state).toMatchObject({
      hourlyTaskId: base.taskId,
      runKey: result.runKey,
      status: 'sent',
      messageId: 'om_sent',
      turnId: base.turnId,
    });
  });

  it('does not call the provider when the same run is replayed', async () => {
    const dataDir = tempDataDir();
    const firstSend = vi.fn(async () => 'om_sent');
    await sendScheduleDeliveryOnce({ ...base, dataDir, send: firstSend });
    const replaySend = vi.fn(async () => 'om_duplicate');

    await expect(sendScheduleDeliveryOnce({ ...base, dataDir, send: replaySend }))
      .rejects.toThrow(/delivery_transition_invalid|delivery_already_claimed/);
    expect(replaySend).not.toHaveBeenCalled();
    expect(readScheduleRuntimeState('delivery', base.chatId, dataDir).state).toMatchObject({
      status: 'sent',
      messageId: 'om_sent',
    });
  });

  it('records provider failure without a message id and permits one later retry', async () => {
    const dataDir = tempDataDir();
    const failedSend = vi.fn(async () => { throw new Error('provider unavailable'); });

    await expect(sendScheduleDeliveryOnce({ ...base, dataDir, send: failedSend }))
      .rejects.toThrow('provider unavailable');
    expect(readScheduleRuntimeState('delivery', base.chatId, dataDir).state).toMatchObject({
      status: 'delivery_failed',
      messageId: null,
      lastError: 'provider unavailable',
    });

    const retrySend = vi.fn(async () => 'om_retry');
    await expect(sendScheduleDeliveryOnce({ ...base, dataDir, send: retrySend }))
      .resolves.toMatchObject({ messageId: 'om_retry' });
    expect(retrySend).toHaveBeenCalledOnce();
    expect(retrySend.mock.calls[0]?.[0]).toBe(failedSend.mock.calls[0]?.[0]);
  });

  it('fails closed without sending when a failed run is outside the provider dedupe window', async () => {
    const dataDir = tempDataDir();
    await expect(sendScheduleDeliveryOnce({
      ...base,
      dataDir,
      send: async () => { throw new Error('response lost'); },
    })).rejects.toThrow('response lost');
    const retrySend = vi.fn(async () => 'om_too_late');

    await expect(sendScheduleDeliveryOnce({
      ...base,
      dataDir,
      now: () => '2026-09-28T11:00:01.000Z',
      send: retrySend,
    })).rejects.toThrow(/delivery_retry_window_expired/);
    expect(retrySend).not.toHaveBeenCalled();
  });

  it('rechecks the retry deadline immediately before the provider effect', async () => {
    const dataDir = tempDataDir();
    await expect(sendScheduleDeliveryOnce({
      ...base,
      dataDir,
      send: async () => { throw new Error('response lost'); },
    })).rejects.toThrow('response lost');
    const times = [
      '2026-09-28T10:59:30.999Z',
      '2026-09-28T10:59:31.000Z',
    ];
    const retrySend = vi.fn(async () => 'om_too_late');

    await expect(sendScheduleDeliveryOnce({
      ...base,
      dataDir,
      now: () => times.shift()!,
      send: retrySend,
    })).rejects.toThrow(/delivery_retry_window_expired/);
    expect(retrySend).not.toHaveBeenCalled();
    expect(readScheduleRuntimeState('delivery', base.chatId, dataDir).state).toMatchObject({
      status: 'delivery_failed',
      messageId: null,
      lastError: 'delivery_retry_window_expired',
    });
  });

  it('restores delivery_failed when the clock moves backwards after retry claim', async () => {
    const dataDir = tempDataDir();
    await expect(sendScheduleDeliveryOnce({
      ...base,
      dataDir,
      send: async () => { throw new Error('response lost'); },
    })).rejects.toThrow('response lost');
    const times = [
      '2026-09-28T10:00:03.000Z',
      '2026-09-28T10:00:02.000Z',
    ];
    const retrySend = vi.fn(async () => 'om_must_not_send');

    await expect(sendScheduleDeliveryOnce({
      ...base,
      dataDir,
      now: () => times.shift()!,
      send: retrySend,
    })).rejects.toThrow(/delivery_retry_clock_invalid/);
    expect(retrySend).not.toHaveBeenCalled();
    expect(readScheduleRuntimeState('delivery', base.chatId, dataDir).state).toMatchObject({
      status: 'delivery_failed',
      messageId: null,
      lastError: 'delivery_retry_clock_invalid',
    });
  });

  it.each([
    {
      name: 'missing claimedAt',
      claimedAt: undefined,
      now: '2026-09-28T10:00:02.000Z',
      error: /delivery_retry_not_safe/,
    },
    {
      name: 'clock rollback',
      claimedAt: '2026-09-28T10:00:01.000Z',
      now: '2026-09-28T10:00:00.000Z',
      error: /delivery_retry_clock_invalid/,
    },
  ])('fails closed for $name without changing the ledger', async ({ claimedAt, now, error }) => {
    const dataDir = tempDataDir();
    const sending = {
      schemaVersion: 1,
      chatId: base.chatId,
      hourlyTaskId: base.taskId,
      runKey: `${base.taskId}:${base.runAt}`,
      status: 'sending',
      ...(claimedAt === undefined ? {} : { claimedAt }),
      messageId: null,
      lastError: null,
    };
    const first = writeScheduleRuntimeState({
      kind: 'delivery', chatId: base.chatId, expectedSha256: 'missing', next: sending, dataDir,
    });
    writeScheduleRuntimeState({
      kind: 'delivery', chatId: base.chatId, expectedSha256: first.sha256,
      next: { ...sending, status: 'delivery_failed', lastError: 'ambiguous' }, dataDir,
    });
    const before = readScheduleRuntimeState('delivery', base.chatId, dataDir);
    const send = vi.fn(async () => 'om_bad');

    await expect(sendScheduleDeliveryOnce({ ...base, dataDir, now: () => now, send }))
      .rejects.toThrow(error);
    expect(send).not.toHaveBeenCalled();
    expect(readScheduleRuntimeState('delivery', base.chatId, dataDir)).toEqual(before);
  });

  it('allows a strictly newer run and sends it exactly once', async () => {
    const dataDir = tempDataDir();
    await sendScheduleDeliveryOnce({ ...base, dataDir, send: async () => 'om_old' });
    const send = vi.fn(async () => 'om_new');

    await expect(sendScheduleDeliveryOnce({
      ...base,
      dataDir,
      runAt: '2026-09-28T11:00:00.000Z',
      send,
    })).resolves.toMatchObject({ messageId: 'om_new' });
    expect(send).toHaveBeenCalledOnce();
    expect(readScheduleRuntimeState('delivery', base.chatId, dataDir).state).toMatchObject({
      runKey: 'task1234:2026-09-28T11:00:00.000Z',
      status: 'sent',
      messageId: 'om_new',
    });
  });

  it('lets only one concurrent claimant invoke the provider', async () => {
    const dataDir = tempDataDir();
    const send = vi.fn(async () => 'om_winner');

    const attempts = await Promise.allSettled([
      sendScheduleDeliveryOnce({ ...base, dataDir, send }),
      sendScheduleDeliveryOnce({ ...base, dataDir, send }),
    ]);

    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(send).toHaveBeenCalledOnce();
  });

  it('permits the last retry still covered by the provider dedupe window', async () => {
    const dataDir = tempDataDir();
    const firstSend = vi.fn(async () => { throw new Error('response lost'); });
    await expect(sendScheduleDeliveryOnce({ ...base, dataDir, send: firstSend }))
      .rejects.toThrow('response lost');
    const retrySend = vi.fn(async () => 'om_retry');

    await expect(sendScheduleDeliveryOnce({
      ...base,
      dataDir,
      now: () => '2026-09-28T10:59:30.999Z',
      send: retrySend,
    })).resolves.toMatchObject({ messageId: 'om_retry' });
    expect(retrySend).toHaveBeenCalledWith(firstSend.mock.calls[0]?.[0]);
  });

  it('derives different provider keys for different chats', () => {
    const runKey = `${base.taskId}:${base.runAt}`;
    expect(scheduleDeliveryProviderKey('oc_a', runKey))
      .not.toBe(scheduleDeliveryProviderKey('oc_b', runKey));
  });

  it('does not let a delivered run rewrite its evidence fields', () => {
    const dataDir = tempDataDir();
    const sending = {
      schemaVersion: 1,
      chatId: base.chatId,
      hourlyTaskId: base.taskId,
      runKey: `${base.taskId}:${base.runAt}`,
      status: 'sending',
      claimedAt: base.now(),
      messageId: null,
      lastError: null,
    };
    const claimed = writeScheduleRuntimeState({
      kind: 'delivery', chatId: base.chatId, expectedSha256: 'missing', next: sending, dataDir,
    });
    const sent = writeScheduleRuntimeState({
      kind: 'delivery', chatId: base.chatId, expectedSha256: claimed.sha256,
      next: { ...sending, status: 'sent', messageId: 'om_sent' }, dataDir,
    });
    const delivered = writeScheduleRuntimeState({
      kind: 'delivery', chatId: base.chatId, expectedSha256: sent.sha256,
      next: {
        ...sending,
        status: 'delivered',
        messageId: 'om_sent',
        deliveryVerifiedAt: '2026-09-28T10:00:02.000Z',
        lastSuccessfulRunAt: '2026-09-28T10:00:02.000Z',
      },
      dataDir,
    });

    expect(() => writeScheduleRuntimeState({
      kind: 'delivery', chatId: base.chatId, expectedSha256: delivered.sha256,
      next: {
        ...delivered.state,
        deliveryVerifiedAt: '2026-09-28T10:00:03.000Z',
        lastSuccessfulRunAt: '2026-09-28T10:00:03.000Z',
      },
      dataDir,
    })).toThrow(/delivery_already_delivered/);
  });
});

import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  watch: vi.fn(),
  publish: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, watch: (...args: unknown[]) => mocks.watch(...args) };
});

let tempDir = '';
vi.mock('../src/config.js', () => ({
  config: { session: { get dataDir() { return join(tempDir, 'data'); } } },
}));
vi.mock('../src/core/dashboard-events.js', () => ({
  dashboardEventBus: { publish: (...args: unknown[]) => mocks.publish(...args) },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: (...args: unknown[]) => mocks.warn(...args), debug: vi.fn() },
}));

class FakeWatcher extends EventEmitter {
  close = vi.fn();
}

async function freshStore() {
  vi.resetModules();
  const store = await import('../src/services/schedule-store.js');
  store.setScheduleScope('cli_watcher_test');
  return store;
}

describe('schedule-store external write watcher recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.watch.mockReset();
    mocks.publish.mockReset();
    mocks.warn.mockReset();
    tempDir = mkdtempSync(join(tmpdir(), 'schedule-watcher-'));
  });

  afterEach(async () => {
    const store = await import('../src/services/schedule-store.js');
    store.__resetExternalWriteWatcherForTest();
    vi.useRealTimers();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('retries one failed watch without duplicating the pending timer', async () => {
    const watcher = new FakeWatcher();
    mocks.watch.mockImplementationOnce(() => {
      const error = new Error('too many open files') as NodeJS.ErrnoException;
      error.code = 'EMFILE';
      throw error;
    }).mockReturnValueOnce(watcher);
    const store = await freshStore();

    store.startExternalWriteWatcher();
    store.startExternalWriteWatcher();
    expect(mocks.watch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.watch).toHaveBeenCalledTimes(2);
    store.startExternalWriteWatcher();
    expect(mocks.watch).toHaveBeenCalledTimes(2);
  });

  it('closes and retries a watcher that fails asynchronously', async () => {
    const first = new FakeWatcher();
    const second = new FakeWatcher();
    mocks.watch.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const store = await freshStore();

    store.startExternalWriteWatcher();
    first.emit('error', new Error('watch backend failed'));
    expect(first.close).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.watch).toHaveBeenCalledTimes(2);
    store.startExternalWriteWatcher();
    expect(mocks.watch).toHaveBeenCalledTimes(2);
  });
});

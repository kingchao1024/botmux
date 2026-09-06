import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  getBotClient: vi.fn(() => ({})),
  getMessageDetail: vi.fn(),
  larkGet: vi.fn(),
}));

vi.mock('../src/bot-registry.js', () => ({ getBotClient: mocks.getBotClient }));
vi.mock('../src/im/lark/client.js', () => ({
  getMessageDetail: mocks.getMessageDetail,
  larkGet: mocks.larkGet,
}));

import { DaemonTaskControlAuthority } from '../src/services/task-control-plane-authority.js';
import { DaemonTaskControlShadowCollector } from '../src/services/task-control-plane-daemon-integration.js';
import { startTaskControlPlaneRuntime } from '../src/services/task-control-plane-runtime.js';

const APP_ID = 'cli_aac926f0eb795bc1';
const TASK_GUID = '2cd616e9-910b-47e1-a081-349b4808ee5a';

describe('scoped task control Shadow collector', () => {
  it('reads only the exact task and records inaccessible comments as bounded UNKNOWN across restart', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-scoped-shadow-'));
    const warnings: string[] = [];
    const authority = new DaemonTaskControlAuthority({ resolvePrincipal: () => undefined });
    mocks.larkGet.mockImplementation(async (_client, path, query) => {
      if (path === `/open-apis/task/v2/tasks/${TASK_GUID}`) {
        return { code: 0, data: { task: { updated_at: '1728000000000', status: 'todo' } } };
      }
      if (path === '/open-apis/task/v2/comments' && query?.resource_id === TASK_GUID) {
        throw new Error('permission_denied');
      }
      throw new Error(`unexpected_read:${path}`);
    });

    try {
      let scopedCollector: DaemonTaskControlShadowCollector | undefined;
      for (let run = 0; run < 2; run++) {
        const lifecycle = await startTaskControlPlaneRuntime({
          dataDir, larkAppId: APP_ID, flags: { ledgerEnabled: true }, authority, logger: { warn: warning => warnings.push(warning) },
        });
        const shadow = new DaemonTaskControlShadowCollector({
          larkAppId: APP_ID, taskGuid: TASK_GUID, lifecycle, logger: { warn: warning => warnings.push(warning) },
        });
        scopedCollector = shadow;
        await shadow.collectAll();
        await vi.waitFor(() => expect(lifecycle.getStore()!.listObservations()).toHaveLength(2), { interval: 5, timeout: 500 });
        expect(lifecycle.getStore()!.listTrustedMappings()).toEqual([]);
        expect(lifecycle.getStore()!.listEvents()).toEqual([]);
        await lifecycle.close();
      }

      expect(mocks.larkGet).toHaveBeenCalledTimes(4);
      expect(mocks.larkGet.mock.calls.every(([, path, query]) =>
        path === `/open-apis/task/v2/tasks/${TASK_GUID}`
          || (path === '/open-apis/task/v2/comments' && query?.resource_id === TASK_GUID
            && query?.direction === 'desc' && query?.page_size === 1))).toBe(true);
      expect(mocks.getMessageDetail).not.toHaveBeenCalled();
      expect(warnings).toEqual(expect.arrayContaining([expect.stringContaining(`task_comment reference unavailable for ${TASK_GUID}`)]));
      expect('registerMapping' in scopedCollector!).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('records a nonzero comment API response as bounded UNKNOWN', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-task-control-scoped-shadow-error-'));
    const authority = new DaemonTaskControlAuthority({ resolvePrincipal: () => undefined });
    mocks.larkGet.mockImplementation(async (_client, path) => path.includes('/tasks/')
      ? { code: 0, data: { task: { status: 'todo' } } }
      : { code: 1470403, msg: 'permission denied' });
    try {
      const lifecycle = await startTaskControlPlaneRuntime({
        dataDir, larkAppId: APP_ID, flags: { ledgerEnabled: true }, authority, logger: { warn: () => {} },
      });
      const shadow = new DaemonTaskControlShadowCollector({
        larkAppId: APP_ID, taskGuid: TASK_GUID, lifecycle, logger: { warn: () => {} },
      });
      await shadow.collectAll();
      await vi.waitFor(() => expect(lifecycle.getStore()!.listObservations()).toHaveLength(2), { interval: 5, timeout: 500 });
      expect(lifecycle.getStore()!.listObservations()).toEqual(expect.arrayContaining([
        expect.objectContaining({ sourceRef: `collection-error:task_comment:${TASK_GUID}`, outcome: 'unknown' }),
      ]));
      await lifecycle.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

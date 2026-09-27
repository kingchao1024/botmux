import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBotConfigsJson } from '../src/setup/bot-config-editor.js';
import { resolveBotsConfigFile } from '../src/core/config-dir.js';
import { selectPluginServiceReconcileIds } from '../src/core/plugins/effective.js';

describe('plugin service reconciliation selection', () => {
  let root: string | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('uses BOTS_CONFIG instead of the default registry for auto services', () => {
    root = mkdtempSync(join(tmpdir(), 'botmux-plugin-reconcile-'));
    const home = join(root, 'home');
    const configured = join(root, 'configured-bots.json');
    mkdirSync(join(home, '.botmux'), { recursive: true });
    writeFileSync(join(home, '.botmux', 'bots.json'), JSON.stringify([{ plugins: ['default-only'] }]));
    writeFileSync(configured, JSON.stringify([{ plugins: ['configured-only'] }]));
    vi.stubEnv('HOME', home);
    vi.stubEnv('BOTS_CONFIG', configured);

    const loadedPaths: string[] = [];
    const selected = selectPluginServiceReconcileIds(undefined, { autoOnly: true }, {
      resolveConfigPath: () => resolveBotsConfigFile({ env: process.env }),
      loadBots: path => {
        loadedPaths.push(path);
        return parseBotConfigsJson(readFileSync(path, 'utf8'), path);
      },
      global: { plugins: ['global-enabled'] },
    });

    expect(loadedPaths).toEqual([configured]);
    expect(selected).toEqual(['global-enabled', 'configured-only']);
  });

  it('preserves explicit service-start ids without reading configuration', () => {
    const ids = ['disabled-but-manual'];
    expect(selectPluginServiceReconcileIds(ids, {}, {
      resolveConfigPath: () => { throw new Error('must not resolve config'); },
      loadBots: () => { throw new Error('must not load bots'); },
      global: {},
    })).toBe(ids);
  });
});

import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readDeviceIsolationRosterSnapshot,
  sameDeviceIsolationRoster,
} from '../src/services/device-isolation-roster.js';
import { resolveFleetBots, resolveFleetDaemonEnv } from '../src/core/fleet-runtime.js';

const roots: string[] = [];
const priorBotsConfig = process.env.BOTS_CONFIG;
function configFile(value: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'botmux-roster-'));
  roots.push(root);
  mkdirSync(join(root, '.botmux'), { recursive: true });
  const path = join(root, '.botmux', 'bots.json');
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return path;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (priorBotsConfig === undefined) delete process.env.BOTS_CONFIG;
  else process.env.BOTS_CONFIG = priorBotsConfig;
});

describe('device isolation configured roster', () => {
  it('returns exact sorted startable IDs and stable hashes while excluding pending rows', () => {
    const path = configFile([
      { larkAppId: 'cli_b', larkAppSecret: 's' },
      { larkAppId: 'cli_pending', larkAppSecret: 's', activationPending: true },
      { larkAppId: 'cli_a', larkAppSecret: 's' },
    ]);
    const first = readDeviceIsolationRosterSnapshot({ configPath: path });
    const second = readDeviceIsolationRosterSnapshot({ configPath: path });
    expect(first.requestedConfigPath).toBe(path);
    expect(first.configPath).toBe(realpathSync(path));
    expect(first.appIds).toEqual(['cli_a', 'cli_b']);
    expect(first.rawSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.configSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(sameDeviceIsolationRoster(first, second)).toBe(true);
  });

  it.each([
    [[{ larkAppId: '../unsafe', larkAppSecret: 's' }], /unsafe/],
    [[{ larkAppId: 'cli_dup', larkAppSecret: 's' }, { larkAppId: 'cli_dup', larkAppSecret: 's' }], /duplicate/],
  ])('fails closed for unsafe or duplicate configured identities', (value, message) => {
    expect(() => readDeviceIsolationRosterSnapshot({ configPath: configFile(value) })).toThrow(message);
  });

  it('detects raw/config revision drift even when the effective app set is unchanged', () => {
    const path = configFile([{ larkAppId: 'cli_a', larkAppSecret: 's' }]);
    const before = readDeviceIsolationRosterSnapshot({ configPath: path });
    writeFileSync(path, `${JSON.stringify([{ larkAppId: 'cli_a', larkAppSecret: 'changed' }])}\n`);
    const after = readDeviceIsolationRosterSnapshot({ configPath: path });
    expect(after.appIds).toEqual(before.appIds);
    expect(sameDeviceIsolationRoster(before, after)).toBe(false);
  });

  it.runIf(process.platform !== 'win32')('preserves the configured alias while tracking its canonical target', () => {
    const firstTarget = configFile([{ larkAppId: 'cli_a', larkAppSecret: 'first' }]);
    const secondTarget = configFile([{ larkAppId: 'cli_a', larkAppSecret: 'second' }]);
    const aliasPath = join(firstTarget, '..', 'fleet-alias.json');
    symlinkSync(firstTarget, aliasPath);
    process.env.BOTS_CONFIG = aliasPath;

    const before = readDeviceIsolationRosterSnapshot();
    expect(before.requestedConfigPath).toBe(aliasPath);
    expect(before.configPath).toBe(realpathSync(firstTarget));
    expect(resolveFleetDaemonEnv().BOTS_CONFIG).toBe(aliasPath);
    expect(resolveFleetBots()[0]?.botsConfigPath).toBe(aliasPath);

    unlinkSync(aliasPath);
    symlinkSync(secondTarget, aliasPath);
    const after = readDeviceIsolationRosterSnapshot();
    expect(after.requestedConfigPath).toBe(aliasPath);
    expect(after.configPath).toBe(realpathSync(secondTarget));
    expect(after.revision).not.toBe(before.revision);
    expect(sameDeviceIsolationRoster(before, after)).toBe(false);
  });

  it('fails closed for an ambient explicit path that is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-roster-missing-'));
    roots.push(root);
    const missingPath = join(root, 'missing.json');
    process.env.BOTS_CONFIG = missingPath;

    expect(() => readDeviceIsolationRosterSnapshot({
      homeDir: root,
      allowMissingDefault: true,
    })).toThrow(/bots config file not found/);
  });

  it.runIf(process.platform !== 'win32')('fails closed for an ambient explicit dangling alias', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-roster-dangling-explicit-'));
    roots.push(root);
    const aliasPath = join(root, 'fleet-alias.json');
    symlinkSync(join(root, 'missing-target.json'), aliasPath);
    process.env.BOTS_CONFIG = aliasPath;

    expect(() => readDeviceIsolationRosterSnapshot({
      homeDir: root,
      allowMissingDefault: true,
    })).toThrow(/dangling or unreadable/);
  });

  it.runIf(process.platform !== 'win32')('fails closed for a dangling default config alias', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-roster-dangling-default-'));
    roots.push(root);
    const configDir = join(root, '.botmux');
    mkdirSync(configDir, { recursive: true });
    symlinkSync(join(configDir, 'missing-target.json'), join(configDir, 'bots.json'));
    delete process.env.BOTS_CONFIG;

    expect(() => readDeviceIsolationRosterSnapshot({
      homeDir: root,
      allowMissingDefault: true,
    })).toThrow(/dangling or unreadable/);
  });

  it('pins the full config revision into every supervisor bot spec', () => {
    const path = configFile([{
      larkAppId: 'cli_a', larkAppSecret: 'secret-a', backendType: 'tmux', sandbox: false,
    }]);
    process.env.BOTS_CONFIG = path;
    const before = readDeviceIsolationRosterSnapshot({ configPath: path });
    expect(resolveFleetBots()).toEqual([expect.objectContaining({
      appId: 'cli_a', botsConfigPath: before.requestedConfigPath, rosterRevision: before.revision,
    })]);
    expect(before.revision).not.toBe(before.rosterSha256);

    writeFileSync(path, `${JSON.stringify([{
      larkAppId: 'cli_a', larkAppSecret: 'secret-b', backendType: 'zellij', sandbox: true,
    }])}\n`, { mode: 0o600 });
    const after = readDeviceIsolationRosterSnapshot({ configPath: path });
    expect(after.appIds).toEqual(before.appIds);
    expect(after.rosterSha256).toBe(before.rosterSha256);
    expect(after.revision).not.toBe(before.revision);
    expect(resolveFleetBots()[0]?.rosterRevision).toBe(after.revision);
  });
});

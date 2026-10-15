import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import type { CliAdapter } from '../src/adapters/cli/types.js';
import { installLocalPlugin } from '../src/core/plugins/install.js';
import { prepareCliPluginGeneration } from '../src/core/plugins/cli-generation.js';
import {
  readSessionMcpRuntimeManifest,
  sessionMcpRuntimeHostOnlyPaths,
  sessionMcpRuntimeManifestPath,
} from '../src/core/plugins/mcp/session-runtime.js';
import { pluginMcpPrivatePath } from '../src/core/plugins/paths.js';
import { readSessionPluginManifest } from '../src/core/plugins/session-manifest.js';
import { readSessionSkillManifest } from '../src/core/skills/manifest-store.js';
import {
  appendTraexSkillCatalog,
  prepareTraexNativeContext,
  settleTraexNativeContextReceipt,
} from '../src/core/traex-native-context.js';

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

describe('CLI plugin generation', () => {
  let home: string;
  let dataDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-plugin-generation-'));
    dataDir = join(home, '.botmux', 'data');
    vi.stubEnv('HOME', home);
    vi.stubEnv('SESSION_DATA_DIR', dataDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('zero injection emits no replacement or deferred skill catalog on resume', () => {
    for (const prompt of ['', '只运行测试']) {
      const result = prepareCliPluginGeneration({ sessionId: 'zero', bot: { larkAppId: 'sub' },
        cliId: 'claude-code', adapter: { id: 'claude-code' } as CliAdapter,
        workingDir: home, dataDir, global: { plugins: [] }, prompt,
        replacesPriorGeneration: true, promptInjection: 'none' });
      expect(result.prompt).toBe(prompt);
      expect(result.skillCatalog).toBeUndefined();
      expect(result.skillPluginDir).toBeUndefined();
      expect(result.deferredSkillCatalog).toBeUndefined();
      expect(readSessionSkillManifest('zero')).toBeNull();
    }
  });

  it('protects shared global skills for every CLI using the common spawn preparation', () => {
    const skillsDir = join(home, '.shared', 'skills');
    const shared = join(skillsDir, 'botmux-send', 'SKILL.md');
    const user = join(skillsDir, 'user-skill', 'SKILL.md');
    write(shared, 'shared rules');
    write(user, 'native user skill');
    const opts = { sessionId: 'sub', bot: { larkAppId: 'sub' }, cliId: 'traex' as const,
      adapter: { id: 'traex', skillsDir } as CliAdapter, workingDir: home,
      dataDir, global: { plugins: [] }, prompt: 'task', replacesPriorGeneration: false,
      promptInjection: 'none' as const };
    expect(() => prepareCliPluginGeneration(opts)).toThrow('全局 botmux 技能');
    expect(existsSync(shared)).toBe(true);
    expect(existsSync(user)).toBe(true);
    rmSync(join(skillsDir, 'botmux-send'), { recursive: true });
    expect(prepareCliPluginGeneration(opts).prompt).toBe('task');
    expect(existsSync(user)).toBe(true);
  });

  it('replaces Skills and MCP plugin bindings when the same session starts a new CLI process', () => {
    const source = join(home, 'demo-source');
    write(join(source, 'package.json'), JSON.stringify({
      name: '@botmux-ai/plugin-demo',
      version: '0.1.0',
      keywords: ['botmux-plugin'],
      botmux: { schemaVersion: 1, id: 'demo' },
    }));
    write(join(source, 'dist', 'skills', 'browser', 'SKILL.md'), [
      '---',
      'name: browser',
      'description: Browser tools',
      '---',
      '# Browser',
    ].join('\n'));
    write(join(source, 'dist', 'mcp', 'index.json'), JSON.stringify({
      transport: 'stdio',
      command: ['./mcp/server.mjs'],
    }));
    write(join(source, 'dist', 'mcp', 'server.mjs'), 'process.exit(0);\n');
    installLocalPlugin(source);
    const adapter = { id: 'codex' } as CliAdapter;

    const first = prepareCliPluginGeneration({
      sessionId: 'same-session',
      bot: { larkAppId: 'app-1', plugins: ['demo'] },
      global: { plugins: [] },
      dataDir,
      cliId: 'codex',
      adapter,
      workingDir: '/repo',
      prompt: 'first turn',
      replacesPriorGeneration: false,
      now: () => '2026-07-12T00:00:00.000Z',
    });
    expect(first.pluginManifest.pluginIds).toEqual(['demo']);
    expect(first.prompt).toContain('botmux skill show browser');
    expect(first.skillCatalog).toContain('botmux skill show browser');
    expect(readSessionSkillManifest('same-session')?.prioritySkills.map(skill => skill.name)).toEqual(['browser']);
    const firstMcpRuntime = readSessionMcpRuntimeManifest('same-session', dataDir);
    expect(firstMcpRuntime).toMatchObject({
      sessionId: 'same-session',
      pluginIds: ['demo'],
      entries: [{
        pluginId: 'demo',
        server: { transport: 'stdio', command: ['./mcp/server.mjs'] },
      }],
    });
    if (!firstMcpRuntime) throw new Error('expected session MCP runtime manifest');
    expect(sessionMcpRuntimeHostOnlyPaths(firstMcpRuntime, dataDir)).toEqual([
      sessionMcpRuntimeManifestPath('same-session', dataDir),
      pluginMcpPrivatePath('demo'),
      join(home, '.botmux', 'plugins', 'demo', 'dist', 'mcp', 'index.json'),
    ]);
    expect('mcpReadonlyRoots' in first).toBe(false);
    expect('mcpHidePaths' in first).toBe(false);

    const refreshed = prepareCliPluginGeneration({
      sessionId: 'same-session',
      bot: { larkAppId: 'app-1', plugins: [] },
      global: { plugins: [] },
      dataDir,
      cliId: 'codex',
      adapter,
      workingDir: '/repo',
      prompt: 'after restart',
      replacesPriorGeneration: true,
      now: () => '2026-07-12T01:00:00.000Z',
    });
    expect(refreshed.pluginManifest.pluginIds).toEqual([]);
    expect(refreshed.prompt).toContain('<botmux_skills_refresh>');
    expect(refreshed.skillCatalog).toContain('<botmux_skills_refresh>');
    expect(refreshed.prompt).toContain('Skills not listed here are no longer available');
    expect(readSessionPluginManifest('same-session', dataDir)?.pluginIds).toEqual([]);
    expect(readSessionSkillManifest('same-session')).toBeNull();
    expect(readSessionMcpRuntimeManifest('same-session', dataDir)).toMatchObject({
      pluginIds: [],
      entries: [],
    });
    const refreshedMcpRuntime = readSessionMcpRuntimeManifest('same-session', dataDir);
    if (!refreshedMcpRuntime) throw new Error('expected refreshed session MCP runtime manifest');
    expect(sessionMcpRuntimeHostOnlyPaths(refreshedMcpRuntime, dataDir)).toEqual([
      sessionMcpRuntimeManifestPath('same-session', dataDir),
    ]);
  });

  it('builds a digest-addressed compact skill index for TraeX RPC', () => {
    const source = join(home, 'compact-source');
    write(join(source, 'package.json'), JSON.stringify({
      name: '@botmux-ai/plugin-compact',
      version: '0.1.0',
      keywords: ['botmux-plugin'],
      botmux: { schemaVersion: 1, id: 'compact' },
    }));
    write(join(source, 'dist', 'skills', 'review', 'SKILL.md'), [
      '---',
      'name: review',
      'description: Use when reviewing a change. Detailed workflow stays in the skill file.',
      '---',
      '# Review',
    ].join('\n'));
    write(join(source, 'dist', 'mcp', 'index.json'), JSON.stringify({
      transport: 'stdio',
      command: ['./mcp/server.mjs'],
    }));
    write(join(source, 'dist', 'mcp', 'server.mjs'), 'process.exit(0);\n');
    installLocalPlugin(source);

    const result = prepareCliPluginGeneration({
      sessionId: 'traex-compact',
      bot: { larkAppId: 'app-1', plugins: ['compact'] },
      global: { plugins: [] },
      dataDir,
      cliId: 'traex',
      adapter: { id: 'traex' } as CliAdapter,
      workingDir: '/repo',
      prompt: 'first turn',
      replacesPriorGeneration: false,
      compactCatalog: true,
      deferCatalogToContextManager: true,
      now: () => '2026-10-14T00:00:00.000Z',
    } as any);

    expect(result.prompt).toBe('first turn');
    expect(result.deferredSkillCatalog).toBe(result.skillCatalog);
    expect(result.skillCatalog).toContain('trigger="Use when reviewing a change."');
    expect(result.skillCatalog).not.toContain('Detailed workflow stays in the skill file');
    expect(result.skillCatalogDigest).toMatch(/^[a-f0-9]{64}$/);

    const resumed = prepareCliPluginGeneration({
      sessionId: 'traex-compact',
      bot: { larkAppId: 'app-1', plugins: ['compact'] },
      global: { plugins: [] },
      dataDir,
      cliId: 'traex',
      adapter: { id: 'traex' } as CliAdapter,
      workingDir: '/repo',
      prompt: 'after same-thread restart',
      replacesPriorGeneration: true,
      compactCatalog: true,
      deferCatalogToContextManager: true,
      now: () => '2026-10-14T01:00:00.000Z',
    } as any);
    expect(resumed.prompt).toBe('after same-thread restart');
    expect(resumed.deferredSkillCatalog).toContain('<botmux_skills_refresh>');
    expect(resumed.skillCatalogDigest).toBe(result.skillCatalogDigest);

    const roleBlock = `<role context="group">${'安全边界。'.repeat(1_050)}</role>`;
    const firstContext = appendTraexSkillCatalog(
      prepareTraexNativeContext(`${roleBlock}\n\n<user_message>first</user_message>`, 'native-thread-1'),
      result.skillCatalog!,
      undefined,
      result.skillCatalogDigest,
    );
    expect(firstContext.fixedContextBytes).toBeLessThanOrEqual(24 * 1024);
    expect(firstContext.content).toContain('安全边界。');
    expect(firstContext.content).toContain('name="review"');
    expect(firstContext.content).toContain('botmux skill show <name>');

    const receipt = settleTraexNativeContextReceipt(firstContext, 'om_first', 'accepted')!;
    const resumedContext = appendTraexSkillCatalog(
      prepareTraexNativeContext(
        `${roleBlock}\n\n<botmux_reminder>continue</botmux_reminder>\n\n<user_message>next</user_message>`,
        'native-thread-1',
        receipt,
      ),
      resumed.deferredSkillCatalog!,
      receipt,
      resumed.skillCatalogDigest,
    );
    expect(resumedContext.content).not.toContain('<role');
    expect(resumedContext.content).not.toContain('<botmux_skills');
    expect(resumedContext.fixedContextBytes).toBeLessThanOrEqual(4 * 1024);

    const changedCatalog = result.skillCatalog!.replace(
      'Use when reviewing a change.',
      'Use when auditing a release.',
    );
    const changedDigest = createHash('sha256').update(changedCatalog, 'utf8').digest('hex');
    const changedContext = appendTraexSkillCatalog(
      prepareTraexNativeContext('<user_message>changed</user_message>', 'native-thread-1', receipt),
      changedCatalog,
      receipt,
      changedDigest,
    );
    expect(changedContext.content).toContain('Use when auditing a release.');
    const changedReceipt = settleTraexNativeContextReceipt(changedContext, 'om_changed', 'accepted')!;
    const afterChange = appendTraexSkillCatalog(
      prepareTraexNativeContext('<user_message>steady</user_message>', 'native-thread-1', changedReceipt),
      changedCatalog,
      changedReceipt,
      changedDigest,
    );
    expect(afterChange.content).not.toContain('<botmux_skills');
  });
});

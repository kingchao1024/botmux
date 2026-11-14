import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { runSkillSessionCommand } from '../src/core/skills/cli-session-command.js';
import { writeSessionSkillManifest } from '../src/core/skills/manifest-store.js';

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

describe('botmux skill session command', () => {
  let dataDir: string;
  let skillDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-skill-data-'));
    skillDir = mkdtempSync(join(tmpdir(), 'botmux-skill-dir-'));
    vi.stubEnv('SESSION_DATA_DIR', dataDir);
    write(join(skillDir, 'SKILL.md'), '# Deploy');
    write(join(skillDir, 'references', 'release.md'), '# Release');
    writeSessionSkillManifest({
      sessionId: 's1',
      cliId: 'codex',
      workingDir: '/repo',
      policyMode: 'priority',
      prioritySkills: [{
        id: 'deploy',
        name: 'deploy',
        description: 'Deploy services',
        tags: [],
        rootDir: skillDir,
        entrypoint: 'SKILL.md',
        source: { type: 'user', root: skillDir },
        priorityReason: 'bot:include',
      }],
      diagnostics: [],
      generatedAt: '2026-06-14T00:00:00.000Z',
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });

  it('lists skills from the current session manifest', () => {
    expect(runSkillSessionCommand(['list'], { BOTMUX_SESSION_ID: 's1' }).stdout).toContain('deploy');
  });

  it('shows SKILL.md entrypoint', () => {
    expect(runSkillSessionCommand(['show', 'deploy'], {
      BOTMUX_SESSION_ID: 's1', BOTMUX_LARK_APP_ID: 'app-1', SESSION_DATA_DIR: dataDir,
    }).stdout).toContain('# Deploy');
    const auditPath = join(dataDir, 'audit', 'skill-invocations.ndjson');
    const records = readFileSync(auditPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(records).toEqual([expect.objectContaining({
      sessionId: 's1', larkAppId: 'app-1', action: 'show', skill: 'deploy', outcome: 'ok',
    })]);
    expect(JSON.stringify(records)).not.toContain('# Deploy');
    expect(statSync(auditPath).mode & 0o777).toBe(0o600);
    const state = JSON.parse(readFileSync(join(dataDir, 'skill-preflight', 's1.json'), 'utf8'));
    expect(state).toEqual(expect.objectContaining({ status: 'satisfied', skill: 'deploy' }));
  });

  it('renders botmux-send from the explicit per-session reply style env', () => {
    const result = runSkillSessionCommand(['show', 'botmux-send'], {
      BOTMUX_SESSION_ID: 's1',
      BOTMUX_LARK_APP_ID: 'app-1',
      BOTMUX_REPLY_STYLE: JSON.stringify({ recipes: false, layout: false }),
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('name: botmux-send');
    expect(result.stdout).not.toContain('可选排版配方');
    expect(result.stdout).not.toContain('结果摘要');
    expect(result.stdout).not.toContain('--layout');
  });

  it('renders the default guide outside an injected session even with a stale ambient style', () => {
    const result = runSkillSessionCommand(['show', 'botmux-send'], {
      BOTMUX_REPLY_STYLE: JSON.stringify({ recipes: false, layout: false }),
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('可选排版配方');
    expect(result.stdout).toContain('--layout result');
  });

  it('reads relative resources', () => {
    expect(runSkillSessionCommand(['read', 'deploy', 'references/release.md'], {
      BOTMUX_SESSION_ID: 's1', BOTMUX_LARK_APP_ID: 'app-1', SESSION_DATA_DIR: dataDir,
    }).stdout).toContain('# Release');
    const record = JSON.parse(readFileSync(join(dataDir, 'audit', 'skill-invocations.ndjson'), 'utf8').trim());
    expect(record).toEqual(expect.objectContaining({
      action: 'read', skill: 'deploy', resource: 'references/release.md', outcome: 'ok',
    }));
  });

  it('audits failed skill reads without exposing content', () => {
    const result = runSkillSessionCommand(['show', 'missing'], {
      BOTMUX_SESSION_ID: 's1', BOTMUX_LARK_APP_ID: 'app-1', SESSION_DATA_DIR: dataDir,
    });
    expect(result.code).toBe(1);
    const record = JSON.parse(readFileSync(join(dataDir, 'audit', 'skill-invocations.ndjson'), 'utf8').trim());
    expect(record).toEqual(expect.objectContaining({ action: 'show', skill: 'missing', outcome: 'error' }));
    expect(record).not.toHaveProperty('content');
  });

  it('audits named malformed read and resources invocations', () => {
    const env = { BOTMUX_SESSION_ID: 's1', BOTMUX_LARK_APP_ID: 'app-1', SESSION_DATA_DIR: dataDir };
    expect(runSkillSessionCommand(['read', 'deploy'], env).code).toBe(2);
    expect(runSkillSessionCommand(['resources', 'missing'], env).code).toBe(2);
    const records = readFileSync(join(dataDir, 'audit', 'skill-invocations.ndjson'), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line));
    expect(records).toEqual([
      expect.objectContaining({ action: 'read', skill: 'deploy', outcome: 'error' }),
      expect.objectContaining({ action: 'resources', skill: 'missing', outcome: 'error' }),
    ]);
  });

  it('keeps skill reads available when the audit path is unwritable', () => {
    const blocker = join(dataDir, 'not-a-directory');
    writeFileSync(blocker, 'x');
    const result = runSkillSessionCommand(['show', 'deploy'], {
      BOTMUX_SESSION_ID: 's1', SESSION_DATA_DIR: dataDir,
      BOTMUX_SKILL_INVOCATION_AUDIT_PATH: join(blocker, 'audit.ndjson'),
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('# Deploy');
    expect(existsSync(join(blocker, 'audit.ndjson'))).toBe(false);
  });

  it('enumerates an empty resource set for an in-memory built-in without a session manifest', () => {
    const result = runSkillSessionCommand(['resources', 'botmux-send'], {
      BOTMUX_SESSION_ID: 'missing-session',
    });
    expect(result).toEqual({ code: 0, stdout: '\n', stderr: '' });
  });

  it('reports that in-memory built-ins have no readable sidecar resources', () => {
    const result = runSkillSessionCommand(['read', 'botmux-send', 'references/demo.md'], {
      BOTMUX_SESSION_ID: 'missing-session',
    });
    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'built-in skill botmux-send has no resources\n',
    });
  });

  it('refuses to run without a session id', () => {
    expect(runSkillSessionCommand(['list'], {}).stderr).toContain('missing BOTMUX_SESSION_ID');
  });

  it('reports a corrupt manifest as unreadable, not not-found', () => {
    write(join(dataDir, 'skill-manifests', 'broken.json'), '{ nope');
    const res = runSkillSessionCommand(['show', 'deploy'], { BOTMUX_SESSION_ID: 'broken' });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('corrupt');
    expect(res.stderr).not.toContain('not found');
  });

  it('reports a present-but-unreadable manifest as unreadable (exit 1), for any uid', () => {
    // EISDIR stands in for a permission fault: root bypasses mode bits, so a
    // chmod-000 file would be readable exactly where the daemon runs.
    mkdirSync(join(dataDir, 'skill-manifests', 'locked.json'), { recursive: true });
    const res = runSkillSessionCommand(['show', 'deploy'], { BOTMUX_SESSION_ID: 'locked' });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('exists but is unreadable');
    expect(res.stderr).toContain('EISDIR');
    expect(res.stderr).not.toContain('not found');
  });

  it.each([
    [['--help']],
    [['-h']],
    [['help']],
    [['list', '--help']],
    [['show', '--help']],
    [['show', '-h']],
    [['resources', '--help']],
    [['read', 'deploy', '--help']],
  ])('prints usage for %j without needing a session id or manifest', (args) => {
    for (const env of [{}, { BOTMUX_SESSION_ID: 'absent' }, { BOTMUX_SESSION_ID: 's1' }]) {
      const res = runSkillSessionCommand(args, env);
      expect(res.code).toBe(0);
      expect(res.stderr).toBe('');
      expect(res.stdout).toMatch(/^usage:/);
    }
  });

  it('keeps first-position help as the help command even when a skill is named help', () => {
    const helpSkillDir = mkdtempSync(join(tmpdir(), 'botmux-skill-help-named-'));
    write(join(helpSkillDir, 'SKILL.md'), '# Help skill');
    writeSessionSkillManifest({
      sessionId: 's-help',
      cliId: 'codex',
      workingDir: '/repo',
      policyMode: 'priority',
      prioritySkills: [{
        id: 'help',
        name: 'help',
        description: 'A skill literally named help',
        tags: [],
        rootDir: helpSkillDir,
        entrypoint: 'SKILL.md',
        source: { type: 'user', root: helpSkillDir },
        priorityReason: 'bot:include',
      }],
      diagnostics: [],
      generatedAt: '2026-06-14T00:00:00.000Z',
    });
    try {
      const helpCmd = runSkillSessionCommand(['help'], { BOTMUX_SESSION_ID: 's-help' });
      expect(helpCmd).toMatchObject({ code: 0, stderr: '' });
      expect(helpCmd.stdout).toMatch(/^usage:/);

      // Second-position help is a skill name, not the help command: the boundary
      // must stay at args[0] and never widen to args.includes('help').
      const shown = runSkillSessionCommand(['show', 'help'], { BOTMUX_SESSION_ID: 's-help' });
      expect(shown.code).toBe(0);
      expect(shown.stderr).toBe('');
      expect(shown.stdout).toContain('# Help skill');
      expect(shown.stdout).not.toMatch(/^usage:/);

      const read = runSkillSessionCommand(['read', 'help', 'SKILL.md'], { BOTMUX_SESSION_ID: 's-help' });
      expect(read.code).toBe(0);
      expect(read.stderr).toBe('');
      expect(read.stdout).toContain('# Help skill');
    } finally {
      rmSync(helpSkillDir, { recursive: true, force: true });
    }
  });

  it('still reports a genuinely absent manifest as not found', () => {
    const res = runSkillSessionCommand(['show', 'deploy'], { BOTMUX_SESSION_ID: 'absent' });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('manifest not found');
  });
});

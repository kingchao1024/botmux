import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { runSkillSessionCommand } from '../src/core/skills/cli-session-command.js';

const hook = fileURLToPath(new URL('../scripts/skill-runtime-hook.py', import.meta.url));

describe('skill runtime hook', () => {
  let dataDir: string;
  let fakeMemory: string;
  let capture: string;
  let calls: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-skill-hook-'));
    mkdirSync(join(dataDir, 'skill-manifests'), { recursive: true });
    capture = join(dataDir, 'memory-input.txt');
    calls = join(dataDir, 'memory-calls.txt');
    fakeMemory = join(dataDir, 'fake-memory.py');
    writeFileSync(fakeMemory, [
      '#!/usr/bin/env python3',
      'import os, sys',
      'open(os.environ["MEMORY_CALLS"], "a", encoding="utf-8").write(" ".join(sys.argv[1:]) + "\\n")',
      'if os.environ.get("MEMORY_FAIL") == "1":',
      '    raise SystemExit(1)',
      'if "search" in sys.argv:',
      '    print("remembered context")',
      'elif "save" in sys.argv:',
      '    open(os.environ["MEMORY_CAPTURE"], "wb").write(sys.stdin.buffer.read())',
    ].join('\n') + '\n');
    chmodSync(fakeMemory, 0o700);
  });

  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  function writeManifest(skills: string[], generatedAt = '2026-09-28T00:00:00.000Z'): void {
    writeFileSync(join(dataDir, 'skill-manifests', 's1.json'), JSON.stringify({
      sessionId: 's1',
      prioritySkills: skills.map(name => ({ name })),
      generatedAt,
    }));
  }

  function run(payload: unknown, extraEnv: Record<string, string> = {}) {
    return spawnSync('python3', [hook], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: {
        ...process.env,
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: 's1',
        BOTMUX_LARK_APP_ID: 'app-1',
        BOTMUX_MEMORY_SCRIPT: fakeMemory,
        MEMORY_CAPTURE: capture,
        MEMORY_CALLS: calls,
        ...extraEnv,
      },
    });
  }

  it('denies the first non-skill tool until a successful show satisfies preflight', () => {
    writeManifest(['tdd']);
    expect(run({ hook_event_name: 'UserPromptSubmit', prompt: '<user_message>fix it</user_message>' }).status).toBe(0);

    const denied = run({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/repo/a.ts' } });
    expect(JSON.parse(denied.stdout).hookSpecificOutput).toEqual(expect.objectContaining({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
    }));

    const skillRead = run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'botmux skill show tdd' } });
    expect(skillRead.stdout).toBe('');

    const skillDir = join(dataDir, 'skills', 'tdd');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# TDD\nRead the tests before editing.\n');
    writeFileSync(join(dataDir, 'skill-manifests', 's1.json'), JSON.stringify({
      sessionId: 's1', generatedAt: '2026-09-28T00:00:00.000Z',
      prioritySkills: [{ name: 'tdd', rootDir: skillDir, entrypoint: 'SKILL.md' }],
    }));
    const previousDataDir = config.session.dataDir;
    try {
      config.session.dataDir = dataDir;
      const read = runSkillSessionCommand(['show', 'tdd'], {
        SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: 's1', BOTMUX_LARK_APP_ID: 'app-1',
      });
      expect(read.code).toBe(0);
      expect(read.stdout).toContain('# TDD');
    } finally {
      config.session.dataDir = previousDataDir;
    }
    expect(run({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/repo/a.ts' } }).stdout).toBe('');
  });

  it('fails open when no session manifest exists', () => {
    expect(run({ hook_event_name: 'UserPromptSubmit', prompt: 'hello' }).stdout).toBe('');
    expect(run({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} }).stdout).toBe('');
  });

  it('does not change sessions whose manifest predates the hook cutover', () => {
    writeManifest(['share-context-memory', 'tdd'], '2026-09-27T23:59:59.000Z');
    writeFileSync(join(dataDir, 'skill-runtime-enabled-at'), '2026-09-28T00:00:00.000Z\n');

    expect(run({ hook_event_name: 'UserPromptSubmit', prompt: 'old session' }).stdout).toBe('');
    expect(run({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} }).stdout).toBe('');
  });

  it('recalls and saves memory only when share-context-memory is assigned', () => {
    writeManifest(['share-context-memory', 'tdd']);
    const prompt = run({ hook_event_name: 'UserPromptSubmit', prompt: '<user_message>remember this</user_message>' });
    const output = JSON.parse(prompt.stdout);
    expect(output.hookSpecificOutput.additionalContext).toContain('remembered context');
    expect(output.hookSpecificOutput.additionalContext).toContain('managed="hook"');

    const stop = run({ hook_event_name: 'Stop', text_content: 'done' });
    expect(stop.status).toBe(0);
    const saved = readFileSync(capture, 'utf8');
    expect(saved).toContain('=== USER');
    expect(saved).toContain('remember this');
    expect(saved).toContain('=== ASSISTANT');
    expect(saved).toContain('done');
    expect(statSync(join(dataDir, 'audit', 'skill-invocations.ndjson')).mode & 0o777).toBe(0o600);
  });

  it('backs off after a memory failure instead of delaying every turn', () => {
    writeManifest(['share-context-memory']);
    run({ hook_event_name: 'UserPromptSubmit', prompt: 'first' }, { MEMORY_FAIL: '1' });
    run({ hook_event_name: 'UserPromptSubmit', prompt: 'second' }, { MEMORY_FAIL: '1' });

    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve('.');
const overlayScript = join(repoRoot, 'scripts', 'update-local-overlay.sh');
const daemonSmoke = join(repoRoot, 'scripts', 'smoke-bun-daemon-nonempty.mjs');
const roots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function executable(path: string, lines: string[]): void {
  writeFileSync(path, `${lines.join('\n')}\n`);
  chmodSync(path, 0o755);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('integration maintenance scripts', () => {
  it('uses packageManager Bun and keeps origin as the overlay rebase source', () => {
    const root = tempRoot('botmux-overlay-script-');
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(join(root, 'node_modules'));
    mkdirSync(join(root, 'fake-bin'));
    cpSync(overlayScript, join(root, 'scripts', 'update-local-overlay.sh'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ packageManager: 'bun@1.4.2' }));
    const calls = join(root, 'calls.log');
    executable(join(root, 'fake-bin', 'git'), [
      '#!/bin/sh',
      `printf 'git %s\n' "$*" >> "${calls}"`,
      'case "$1 $2" in',
      "  'branch --show-current') echo integrate/all-local-branches-20260916 ;;",
      "  'status --porcelain') ;;",
      "  'describe --tags') echo v3.20.0 ;;",
      "  'rev-parse --short=8') echo deadbeef ;;",
      'esac',
    ]);
    for (const name of ['npx', 'node', 'sha256sum']) {
      executable(join(root, 'fake-bin', name), [
        '#!/bin/sh',
        ...(name === 'node' ? ["if [ \"$1\" = -p ]; then echo 1.4.2; exit 0; fi"] : []),
        `printf '${name} %s\n' "$*" >> "${calls}"`,
        'exit 0',
      ]);
    }

    const result = spawnSync('bash', [join(root, 'scripts', 'update-local-overlay.sh')], {
      cwd: root,
      env: { ...process.env, PATH: `${join(root, 'fake-bin')}:/usr/bin:/bin` },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    const log = readFileSync(calls, 'utf8');
    expect(log).toContain('git fetch origin master --tags');
    expect(log).toContain('git rebase origin/master');
    expect(log).toContain('npx --yes bun@1.4.2 run test');
    expect(log).not.toContain('bun@1.4.0');
  });

  it('rejects a non-Bun packageManager before invoking npx', () => {
    const root = tempRoot('botmux-overlay-invalid-package-manager-');
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(join(root, 'node_modules'));
    mkdirSync(join(root, 'fake-bin'));
    cpSync(overlayScript, join(root, 'scripts', 'update-local-overlay.sh'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.0.0' }));
    const marker = join(root, 'npx-called');
    executable(join(root, 'fake-bin', 'git'), [
      '#!/bin/sh',
      'case "$1 $2" in',
      "  'branch --show-current') echo integrate/all-local-branches-20260916 ;;",
      "  'status --porcelain') ;;",
      'esac',
      'exit 0',
    ]);
    executable(join(root, 'fake-bin', 'npx'), ['#!/bin/sh', `touch "${marker}"`, 'exit 0']);

    const result = spawnSync('bash', [join(root, 'scripts', 'update-local-overlay.sh')], {
      cwd: root,
      env: { ...process.env, PATH: `${join(root, 'fake-bin')}:/usr/bin:/bin` },
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('packageManager must pin an exact Bun version');
    expect(existsSync(marker)).toBe(false);
  });

  it('documents the real remote roles without a nonexistent push remote or private account', () => {
    const document = readFileSync(join(repoRoot, 'LOCAL_OVERLAY.md'), 'utf8');
    expect(document).toContain('`origin`');
    expect(document).toContain('`upstream`');
    expect(document).not.toContain('git push codebase');
    expect(document).not.toContain('`codebase`');
    expect(document).not.toContain('sole remote source of truth for private overlay commits');
    expect(document).not.toContain('`origin` is the public upstream');
    expect(document).not.toContain('From the `local/s1-overlay` worktree');
  });

  it('reports spawn failure and removes its scratch directory', () => {
    const root = tempRoot('botmux-nonempty-smoke-test-');
    const binary = join(root, 'not-executable');
    writeFileSync(binary, 'not executable');
    chmodSync(binary, 0o600);

    const result = spawnSync(process.execPath, [daemonSmoke, binary], {
      env: { ...process.env, TMPDIR: root },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('smoke: FAIL [nonempty-daemon]');
    expect(result.stderr).not.toContain("Unhandled 'error' event");
    expect(readdirSync(root).filter(name => name.startsWith('botmux-nonempty-daemon-smoke-'))).toEqual([]);
    expect(existsSync(binary)).toBe(true);
  });
});

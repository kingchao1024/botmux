import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectCredentialIsolationEntries } from '../src/adapters/cli/credential-isolation-entries.js';
import { DEVICE_CREDENTIAL_ISOLATION_READERS_DIRECTORY } from '../src/adapters/cli/read-isolation.js';
import { buildCredentialOnlySandboxArgs, probeHostCredentialIsolationMechanism } from '../src/adapters/backend/sandbox.js';

const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'botmux-authority-entries-'));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('credential-only host authority entries', () => {
  it.skipIf(process.platform !== 'linux' || probeHostCredentialIsolationMechanism().mechanism !== 'bwrap')(
    'exposes only the owning writable outbox below a sealed relay parent', () => {
      const root = fixture();
      const sessions = join(root, 'sandboxes');
      const outbox = join(sessions, 'own', 'outbox');
      const sibling = join(sessions, 'other', 'outbox');
      mkdirSync(outbox, { recursive: true });
      mkdirSync(sibling, { recursive: true });
      writeFileSync(join(sibling, 'capability'), 'host-only sibling capability');
      const args = buildCredentialOnlySandboxArgs({
        hideDirectories: [sessions], hideFiles: [], writableOutbox: outbox,
        workingDir: root, cliBin: '/bin/sh',
        cliArgs: ['-c', 'test ! -e "$1/other" && ! mkdir "$1/unowned" 2>/dev/null && printf relay > "$2/request"', 'sh', sessions, outbox],
      });
      execFileSync('bwrap', args, { timeout: 10_000 });
      expect(readFileSync(join(outbox, 'request'), 'utf8')).toBe('relay');
      expect(readFileSync(join(sibling, 'capability'), 'utf8')).toBe('host-only sibling capability');
    },
  );

  it('masks the readers directory wholesale and ordinary credentials as files', () => {
    const root = fixture();
    const readers = join(root, DEVICE_CREDENTIAL_ISOLATION_READERS_DIRECTORY);
    mkdirSync(readers, { mode: 0o700 });
    writeFileSync(join(readers, 'lease'), 'host-only reader lease');
    const secret = join(root, 'platform.json');
    writeFileSync(secret, 'host-only credential');
    const dashboard = join(root, '.dashboard-secret');
    writeFileSync(dashboard, 'dashboard credential');
    mkdirSync(join(root, 'device-auth'));
    mkdirSync(join(root, 'data'));
    const entries = collectCredentialIsolationEntries(root);
    expect(entries).toEqual({ directories: [readers], files: [dashboard, secret] });
    const args = buildCredentialOnlySandboxArgs({
      cliBin: '/bin/true', cliArgs: [], workingDir: root,
      hideDirectories: entries.directories, hideFiles: entries.files,
    });
    const directoryAt = args.indexOf(readers);
    expect(args.slice(directoryAt - 1, directoryAt + 3)).toEqual(['--tmpfs', readers, '--remount-ro', readers]);
    const fileAt = args.indexOf(secret);
    expect(args.slice(fileAt - 2, fileAt + 1)).toEqual(['--ro-bind', '/dev/null', secret]);
    expect(readFileSync(join(readers, 'lease'), 'utf8')).toBe('host-only reader lease');
  });

  it.each(['symlink', 'file', 'fifo'])('rejects a readers %s without following or opening it', kind => {
    const root = fixture();
    const entry = join(root, DEVICE_CREDENTIAL_ISOLATION_READERS_DIRECTORY);
    if (kind === 'symlink') symlinkSync(root, entry);
    else if (kind === 'fifo') execFileSync('mkfifo', [entry]);
    else writeFileSync(entry, 'wrong type');
    expect(() => collectCredentialIsolationEntries(root)).toThrow('not a directory');
  });

  it.each(['directory', 'symlink', 'fifo'])('rejects an unexpected reserved %s', kind => {
    const root = fixture();
    const entry = join(root, 'platform.json.backup');
    if (kind === 'directory') mkdirSync(entry);
    else if (kind === 'symlink') symlinkSync(root, entry);
    else execFileSync('mkfifo', [entry]);
    expect(() => collectCredentialIsolationEntries(root)).toThrow('not a regular file');
  });
});

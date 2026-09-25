import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  normalizeDispatchWriteScopes,
  projectDispatchAccessConflicts,
} from '../src/core/dispatch-write-scope.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; src: string; api: string; sibling: string } {
  const root = mkdtempSync(join(tmpdir(), 'botmux-write-scope-'));
  roots.push(root);
  const src = join(root, 'src');
  const api = join(src, 'api');
  const sibling = join(root, 'src-api');
  mkdirSync(api, { recursive: true });
  mkdirSync(sibling);
  return { root, src, api, sibling };
}

describe('dispatch write scopes', () => {
  it('realpaths existing absolute directories, removes duplicates and child scopes', () => {
    const f = fixture();

    expect(normalizeDispatchWriteScopes([f.api, f.src, `${f.src}/`, f.src])).toEqual([f.src]);
  });

  it('rejects relative, missing and non-directory scopes', () => {
    const f = fixture();

    expect(() => normalizeDispatchWriteScopes(['relative/path'])).toThrow('write_scope_must_be_absolute');
    expect(() => normalizeDispatchWriteScopes([join(f.root, 'missing')])).toThrow('write_scope_must_exist');
    expect(() => normalizeDispatchWriteScopes([import.meta.filename])).toThrow('write_scope_must_be_directory');
  });

  it('detects equal and ancestor conflicts by path segment only', () => {
    const f = fixture();
    const writeSrc = { mode: 'write' as const, scopes: [f.src] };

    expect(projectDispatchAccessConflicts(writeSrc, { mode: 'write', scopes: [f.src] })).toBe(true);
    expect(projectDispatchAccessConflicts(writeSrc, { mode: 'write', scopes: [f.api] })).toBe(true);
    expect(projectDispatchAccessConflicts(writeSrc, { mode: 'write', scopes: [f.root] })).toBe(true);
    expect(projectDispatchAccessConflicts(writeSrc, { mode: 'write', scopes: [f.sibling] })).toBe(false);
    expect(projectDispatchAccessConflicts(writeSrc, { mode: 'read_only' })).toBe(false);
    expect(projectDispatchAccessConflicts({ mode: 'read_only' }, writeSrc)).toBe(false);
  });
});

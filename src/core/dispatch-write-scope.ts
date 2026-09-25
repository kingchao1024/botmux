import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';

export type ProjectDispatchAccess =
  | Readonly<{ mode: 'read_only' }>
  | Readonly<{ mode: 'write'; scopes: string[] }>;

export function normalizeDispatchWriteScopes(scopes: readonly string[]): string[] {
  const normalized = [...new Set(scopes.map(scope => {
    if (!isAbsolute(scope)) throw new Error('write_scope_must_be_absolute');
    let path: string;
    try { path = realpathSync(scope); } catch { throw new Error('write_scope_must_exist'); }
    if (!statSync(path).isDirectory()) throw new Error('write_scope_must_be_directory');
    return path;
  }))].sort((left, right) => left.length - right.length || left.localeCompare(right));
  return normalized.filter((scope, index) => (
    !normalized.slice(0, index).some(parent => pathContains(parent, scope))
  ));
}

function pathContains(parent: string, child: string): boolean {
  const childFromParent = relative(parent, child);
  return childFromParent === ''
    || (!childFromParent.startsWith('..') && !isAbsolute(childFromParent));
}

export function projectDispatchAccessConflicts(
  _left: ProjectDispatchAccess,
  _right: ProjectDispatchAccess,
): boolean {
  if (_left.mode === 'read_only' || _right.mode === 'read_only') return false;
  return _left.scopes.some(left => _right.scopes.some(right => (
    pathContains(left, right) || pathContains(right, left)
  )));
}

/**
 * Strict host-authority file primitives.
 *
 * Unlike general dotfiles, machine/device credentials must never follow a
 * leaf symlink. Linux pins the containing directory while operating on the
 * leaf; other platforms require a non-replaceable ancestor chain. All writes
 * atomically replace the leaf, and its directory must be owned by the current
 * user without group/other write access.
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLock, withFileLockSync, type FileLockOptions } from '../utils/file-lock.js';

export class UnsafeHostAuthorityFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeHostAuthorityFileError';
  }
}

function sameInode(
  left: Pick<import('node:fs').Stats, 'dev' | 'ino'>,
  right: Pick<import('node:fs').Stats, 'dev' | 'ino'>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertOwnedByCurrentUser(stats: import('node:fs').Stats, label: string): void {
  if (process.platform === 'win32' || !process.getuid) return;
  if (stats.uid !== process.getuid()) {
    throw new UnsafeHostAuthorityFileError(`${label} 不属于当前用户`);
  }
}

function assertSecureParentStats(stats: import('node:fs').Stats): void {
  if (!stats.isDirectory()) {
    throw new UnsafeHostAuthorityFileError('宿主凭证目录不是普通目录');
  }
  assertOwnedByCurrentUser(stats, '宿主凭证目录');
  if (process.platform !== 'win32' && (stats.mode & 0o022) !== 0) {
    throw new UnsafeHostAuthorityFileError('宿主凭证目录可被组内或其它用户写入');
  }
}

/**
 * A 0700 credential directory is still replaceable when one of its ancestors
 * is writable by another user. Walk the canonical chain so later path-based
 * open/rename operations cannot be redirected by renaming the whole directory.
 *
 * POSIX sticky directories (notably /tmp) are the one safe writable exception:
 * when both the directory owner and child owner are trusted, unrelated users
 * cannot rename that child despite the directory's 01777 mode.
 */
function assertAncestorChainCannotReplace(canonicalParent: string): void {
  if (process.platform === 'win32' || !process.getuid) return;
  const uid = process.getuid();
  const trustedOwner = (owner: number) => owner === uid || owner === 0;
  let childPath = canonicalParent;
  let childStats = statSync(childPath);

  while (true) {
    const ancestorPath = dirname(childPath);
    if (ancestorPath === childPath) return;
    const ancestorStats = statSync(ancestorPath);
    if (!ancestorStats.isDirectory()) {
      throw new UnsafeHostAuthorityFileError('宿主凭证祖先路径不是目录');
    }

    const untrustedOwnerCanWrite = !trustedOwner(ancestorStats.uid)
      && (ancestorStats.mode & 0o200) !== 0;
    const groupOrOtherCanWrite = (ancestorStats.mode & 0o022) !== 0;
    if (untrustedOwnerCanWrite || groupOrOtherCanWrite) {
      const stickyProtectsChild = (ancestorStats.mode & 0o1000) !== 0
        && trustedOwner(ancestorStats.uid)
        && trustedOwner(childStats.uid);
      if (!stickyProtectsChild) {
        throw new UnsafeHostAuthorityFileError('宿主凭证目录可被不可信祖先目录替换');
      }
    }

    childPath = ancestorPath;
    childStats = ancestorStats;
  }
}

function canonicalSecureHostParent(filePath: string, exactParentMode?: number): string {
  const parent = dirname(filePath);
  mkdirSync(parent, { recursive: true, mode: exactParentMode ?? 0o700 });
  const canonicalParent = realpathSync(parent);
  const parentStats = statSync(canonicalParent);
  assertSecureParentStats(parentStats);
  if (exactParentMode !== undefined && process.platform !== 'win32'
      && (parentStats.mode & 0o777) !== exactParentMode) {
    throw new UnsafeHostAuthorityFileError(`宿主凭证目录权限必须严格为 0${exactParentMode.toString(8)}`);
  }
  return canonicalParent;
}

/** Create/resolve the parent without ever resolving the final path component. */
export function secureHostFilePath(filePath: string): string {
  const canonicalParent = canonicalSecureHostParent(filePath);
  assertAncestorChainCannotReplace(canonicalParent);
  return join(canonicalParent, basename(filePath));
}

interface SecureHostParent {
  path: string;
  fd?: number;
}

/**
 * Linux exposes an opened directory through /proc/self/fd. Keeping that
 * directory descriptor open makes all leaf operations independent of later
 * ancestor renames: an untrusted mount-point owner can still cause denial of
 * service, but cannot redirect a credential write into a directory it reads.
 *
 * Other platforms retain the conservative ancestor-chain requirement until
 * they have an equivalent descriptor-relative primitive.
 */
function acquireSecureHostParent(filePath: string, exactParentMode?: number): SecureHostParent {
  const canonicalParent = canonicalSecureHostParent(filePath, exactParentMode);
  if (process.platform !== 'linux') {
    assertAncestorChainCannotReplace(canonicalParent);
    return { path: canonicalParent };
  }

  const fd = openSync(
    canonicalParent,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const openedStats = fstatSync(fd);
    assertSecureParentStats(openedStats);
    const anchoredPath = `/proc/self/fd/${fd}`;
    let anchoredStats: import('node:fs').Stats;
    try {
      anchoredStats = statSync(anchoredPath);
    } catch {
      // Minimal/chrooted Linux environments may not mount procfs. Preserve
      // the old fail-closed path validation there.
      closeSync(fd);
      assertAncestorChainCannotReplace(canonicalParent);
      return { path: canonicalParent };
    }
    if (!sameInode(openedStats, anchoredStats)) {
      throw new UnsafeHostAuthorityFileError('宿主凭证目录句柄发生变化');
    }
    return { path: anchoredPath, fd };
  } catch (error) {
    try { closeSync(fd); } catch { /* best effort */ }
    throw error;
  }
}

function releaseSecureHostParent(parent: SecureHostParent): void {
  if (parent.fd === undefined) return;
  closeSync(parent.fd);
}

function assertSecureFileStats(stats: import('node:fs').Stats, maxBytes: number): void {
  if (!stats.isFile()) {
    throw new UnsafeHostAuthorityFileError('宿主凭证必须是普通文件');
  }
  assertOwnedByCurrentUser(stats, '宿主凭证文件');
  if (process.platform !== 'win32' && (stats.mode & 0o777) !== 0o600) {
    throw new UnsafeHostAuthorityFileError('宿主凭证文件权限必须严格为 0600');
  }
  if (stats.size < 0 || stats.size > maxBytes) {
    throw new UnsafeHostAuthorityFileError('宿主凭证文件大小异常');
  }
}

function assertSecureRegularFileMetadata(stats: import('node:fs').Stats): void {
  if (!stats.isFile()) {
    throw new UnsafeHostAuthorityFileError('宿主凭证必须是普通文件');
  }
  assertOwnedByCurrentUser(stats, '宿主凭证文件');
  if (process.platform !== 'win32' && (stats.mode & 0o777) !== 0o600) {
    throw new UnsafeHostAuthorityFileError('宿主凭证文件权限必须严格为 0600');
  }
}

function unlinkSecureRegularLeafFromParentSync(
  parent: SecureHostParent,
  leafName: string,
): boolean {
  const resolved = join(parent.path, leafName);
  let fd: number;
  try {
    fd = openSync(
      resolved,
      process.platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new UnsafeHostAuthorityFileError('宿主凭证拒绝符号链接');
    }
    throw error;
  }

  try {
    const opened = fstatSync(fd);
    assertSecureRegularFileMetadata(opened);
    const current = lstatSync(resolved);
    if (current.isSymbolicLink() || !sameInode(opened, current)) {
      throw new UnsafeHostAuthorityFileError('宿主凭证路径在删除时发生变化');
    }
    unlinkSync(resolved);
    if (process.platform !== 'win32') {
      if (parent.fd !== undefined) fsyncSync(parent.fd);
      else {
        const directoryFd = openSync(parent.path, constants.O_RDONLY);
        try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      }
    }
    return true;
  } finally {
    closeSync(fd);
  }
}

function readSecureHostFileFromParentSync(
  parent: SecureHostParent,
  leafName: string,
  maxBytes: number,
): string | null {
  const resolved = join(parent.path, leafName);
  let fd: number;
  try {
    const flags = process.platform === 'win32'
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW;
    fd = openSync(resolved, flags);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new UnsafeHostAuthorityFileError('宿主凭证拒绝符号链接');
    }
    throw error;
  }

  try {
    const before = fstatSync(fd);
    assertSecureFileStats(before, maxBytes);
    const pathStats = lstatSync(resolved);
    if (pathStats.isSymbolicLink() || !sameInode(before, pathStats)) {
      throw new UnsafeHostAuthorityFileError('宿主凭证路径在读取时发生变化');
    }
    const raw = readFileSync(fd, 'utf8');
    const after = fstatSync(fd);
    if (
      !sameInode(before, after)
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
    ) {
      throw new UnsafeHostAuthorityFileError('宿主凭证在读取时发生变化');
    }
    return raw;
  } finally {
    closeSync(fd);
  }
}

/** Return null only for a genuinely absent leaf; unsafe shapes fail closed. */
export function readSecureHostFileSync(filePath: string, maxBytes = 64 * 1024): string | null {
  try {
    lstatSync(dirname(filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const parent = acquireSecureHostParent(filePath);
  try {
    return readSecureHostFileFromParentSync(parent, basename(filePath), maxBytes);
  } finally {
    releaseSecureHostParent(parent);
  }
}

function writePinnedSecureHostFileSync(
  parent: SecureHostParent,
  directoryFd: number,
  leafName: string,
  data: string,
): void {
  const resolved = join(parent.path, leafName);
  const tmp = join(
    parent.path,
    `${leafName}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, data, { encoding: 'utf8' });
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, resolved);
    fsyncSync(directoryFd);
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw error;
  }
}

/**
 * Strict, durable atomic replace of a leaf under an already-acquired parent.
 * Every path is resolved through `parent.path` (the pinned /proc/self/fd anchor
 * on Linux), so a caller that holds the parent across several operations never
 * re-resolves the swappable directory name between them.
 */
function writeSecureLeafFromParentSync(
  parent: SecureHostParent,
  leafName: string,
  data: string,
  maxExistingBytes = 64 * 1024,
): void {
  const resolved = join(parent.path, leafName);
  let leafExists = false;
  try {
    lstatSync(resolved);
    leafExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (leafExists) {
    // Pin and validate the existing leaf before replacement. The final
    // rename never follows a leaf symlink.
    readSecureHostFileFromParentSync(parent, leafName, maxExistingBytes);
  }
  if (parent.fd !== undefined) {
    writePinnedSecureHostFileSync(parent, parent.fd, leafName, data);
  } else {
    atomicWriteFileSync(resolved, data, {
      mode: 0o600,
      durable: true,
      followTargetSymlink: false,
    });
  }
}

/** Strict, durable atomic replace that never follows a leaf symlink. */
export function writeSecureHostFileSync(filePath: string, data: string, maxExistingBytes = 64 * 1024): void {
  const parent = acquireSecureHostParent(filePath);
  try {
    writeSecureLeafFromParentSync(parent, basename(filePath), data, maxExistingBytes);
  } finally {
    releaseSecureHostParent(parent);
  }
}

function assertPlainLeafName(name: string): void {
  if (!name || name === '.' || name === '..' || basename(name) !== name || name.includes('/')) {
    throw new UnsafeHostAuthorityFileError('宿主凭证叶子名非法');
  }
}

/**
 * A pinned view of the credential directory that stays valid ONLY for the
 * synchronous duration of the callback. On Linux every operation resolves
 * through the opened directory descriptor (`/proc/self/fd/<fd>`), so an
 * ancestor rename/replacement after acquisition cannot redirect subsequent
 * lock/read/write operations into an attacker-substituted directory. On other
 * platforms (and Linux without procfs) the parent is the canonical real path
 * and the strict ancestor-chain check has already run.
 *
 * The handle is single-use and fail-closed. It deliberately exposes NO raw
 * filesystem path: the `/proc/self/fd/<fd>` anchor is a live capability that
 * cannot be revoked once handed out as a string, so a caller could stash it,
 * let the fd be recycled after release, and hand the stale string to `fs` or a
 * lock — landing on a directory that never passed the 0700/owner checks. Every
 * capability is therefore a method that re-checks `active` at call time: once
 * the owning {@link withSecureHostParentSync} call returns and releases the
 * descriptor, `readLeaf`/`writeLeaf`/`withLeafLock` throw
 * {@link UnsafeHostAuthorityFileError} instead of touching the recycled fd.
 */
export interface SecureHostParentHandle {
  /** Basename of the credential leaf (informational; carries no path capability). */
  readonly leafName: string;
  /** Read the pinned leaf (fail-closed on unsafe shapes); null if absent. */
  readLeaf(maxBytes?: number): string | null;
  /** Read a sibling leaf under the same pinned parent. */
  readNamedLeaf(name: string, maxBytes?: number): string | null;
  /** Durably, atomically replace the pinned leaf without following a symlink. */
  writeLeaf(data: string): void;
  /** Durably, atomically replace a sibling leaf under the same pinned parent. */
  writeNamedLeaf(name: string, data: string, maxExistingBytes?: number): void;
  /** Strict durable unlink of a sibling leaf; false only when absent. */
  unlinkNamedLeaf(name: string, maxBytes?: number): boolean;
  /** Unlink a pinned sibling after metadata-only validation. This deliberately
   * accepts oversized regular files and is intended for malformed-entry cleanup. */
  unlinkNamedRegularFile(name: string): boolean;
  /** Enumerate sibling leaf names under the same pinned parent. */
  listLeafNames(): string[];
  /** Run under a lock for a named sibling while retaining this pinned parent. */
  withNamedLeafLock<R>(name: string, fn: () => NonThenable<R>): R;
  /** Open/create a named child directory relative to this pinned parent and keep
   * that child inode pinned for the synchronous callback. */
  withChildDirectory<R>(
    name: string,
    fn: (child: SecureHostParentHandle) => NonThenable<R>,
    options?: { create?: boolean; exactMode?: number },
  ): R | undefined;
  /**
   * Run `fn` while holding a cross-process advisory lock on the pinned leaf,
   * serialized against other processes doing the same get-or-create. The lock
   * path is derived from the internal anchor and never exposed, so it cannot be
   * reused after release. `fn` must be synchronous (see {@link NonThenable}).
   */
  withLeafLock<R>(fn: () => NonThenable<R>): R;
}

export interface AsyncSecureHostParentHandle {
  readonly leafName: string;
  readLeaf(maxBytes?: number): Promise<string | null>;
  writeLeaf(data: string, maxExistingBytes?: number): Promise<void>;
  withLeafLock<R>(fn: () => Promise<R>, options?: FileLockOptions): Promise<R>;
}

async function acquireSecureHostParentAsync(
  filePath: string,
  exactParentMode?: number,
): Promise<{ path: string; handle?: import('node:fs/promises').FileHandle }> {
  const parent = dirname(filePath);
  await import('node:fs/promises').then(fs => fs.mkdir(parent, { recursive: true, mode: exactParentMode ?? 0o700 }));
  const fsp = await import('node:fs/promises');
  const canonicalParent = await fsp.realpath(parent);
  const parentStats = await fsp.stat(canonicalParent);
  assertSecureParentStats(parentStats);
  if (exactParentMode !== undefined && process.platform !== 'win32'
      && (parentStats.mode & 0o777) !== exactParentMode) {
    throw new UnsafeHostAuthorityFileError(`宿主凭证目录权限必须严格为 0${exactParentMode.toString(8)}`);
  }
  // The canonical path contains no symlink components. On non-Linux, retain
  // the existing conservative ancestor-chain rule.
  if (process.platform !== 'linux') assertAncestorChainCannotReplace(canonicalParent);
  if (process.platform !== 'linux') return { path: canonicalParent };
  const handle = await fsp.open(canonicalParent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const opened = await handle.stat();
  assertSecureParentStats(opened);
  const anchored = `/proc/self/fd/${handle.fd}`;
  try {
    if (!sameInode(opened, await fsp.stat(anchored))) throw new UnsafeHostAuthorityFileError('宿主凭证目录句柄发生变化');
  } catch (error) {
    await handle.close();
    throw error;
  }
  return { path: anchored, handle };
}

async function readSecureLeafAsync(
  parent: { path: string },
  leafName: string,
  maxBytes: number,
): Promise<string | null> {
  const fsp = await import('node:fs/promises');
  const resolved = join(parent.path, leafName);
  let handle: import('node:fs/promises').FileHandle;
  try {
    handle = await fsp.open(resolved, process.platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const before = await handle.stat();
    assertSecureFileStats(before, maxBytes);
    const pathStats = await fsp.lstat(resolved);
    if (pathStats.isSymbolicLink() || !sameInode(before, pathStats)) {
      throw new UnsafeHostAuthorityFileError('宿主凭证路径在读取时发生变化');
    }
    const raw = await handle.readFile('utf8');
    const after = await handle.stat();
    if (!sameInode(before, after) || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new UnsafeHostAuthorityFileError('宿主凭证在读取时发生变化');
    }
    return raw;
  } finally {
    await handle.close();
  }
}

async function writeSecureLeafAsync(
  parent: { path: string; handle?: import('node:fs/promises').FileHandle },
  leafName: string,
  data: string,
  maxExistingBytes = 1024 * 1024,
): Promise<void> {
  const fsp = await import('node:fs/promises');
  const resolved = join(parent.path, leafName);
  if (await readSecureLeafAsync(parent, leafName, maxExistingBytes) !== null) {
    // Existing leaf was validated above.
  }
  const tmp = join(parent.path, `${leafName}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  let handle: import('node:fs/promises').FileHandle | undefined;
  try {
    handle = await fsp.open(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
        | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
      0o600,
    );
    await handle.writeFile(data, 'utf8');
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fsp.rename(tmp, resolved);
    if (process.platform !== 'win32') {
      if (parent.handle) await parent.handle.sync();
      else {
        const directory = await fsp.open(parent.path, constants.O_RDONLY);
        try { await directory.sync(); } finally { await directory.close(); }
      }
    }
  } catch (error) {
    if (handle) { try { await handle.close(); } catch { /* best effort */ } }
    try { await fsp.unlink(tmp); } catch { /* best effort */ }
    throw error;
  }
}

/** Async variant for latency-sensitive authorization paths. */
export async function withSecureHostParent<T>(
  filePath: string,
  fn: (handle: AsyncSecureHostParentHandle) => Promise<T>,
  options: { exactParentMode?: number } = {},
): Promise<T> {
  const parent = await acquireSecureHostParentAsync(filePath, options.exactParentMode);
  const leafName = basename(filePath);
  const anchoredLeafPath = join(parent.path, leafName);
  let released = false;
  const assertActive = (): void => {
    if (released) throw new UnsafeHostAuthorityFileError('宿主凭证目录句柄已释放，禁止在回调返回后继续使用');
  };
  try {
    return await fn({
      leafName,
      readLeaf: async (maxBytes = 64 * 1024) => { assertActive(); return readSecureLeafAsync(parent, leafName, maxBytes); },
      writeLeaf: async (data, maxExistingBytes) => {
        assertActive();
        await writeSecureLeafAsync(parent, leafName, data, maxExistingBytes);
      },
      withLeafLock: async (inner, lockOptions) => {
        assertActive();
        return withFileLock(anchoredLeafPath, async () => { assertActive(); return inner(); }, lockOptions);
      },
    });
  } finally {
    released = true;
    if (parent.handle) await parent.handle.close();
  }
}

/**
 * `T` constrained to a non-thenable so an `async` callback (or any callback
 * returning a Promise) is a compile-time error. The pinned descriptor is
 * released synchronously when the callback returns; an awaited continuation
 * would run after release, on a possibly-recycled fd. See
 * {@link withSecureHostParentSync}.
 */
type NonThenable<T> = T extends PromiseLike<unknown> ? never : T;

function acquireSecureChildDirectorySync(
  parent: SecureHostParent,
  name: string,
  options: { create?: boolean; exactMode?: number },
): SecureHostParent {
  const childPath = join(parent.path, name);
  if (options.create) {
    try { mkdirSync(childPath, { mode: options.exactMode ?? 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const pathStats = lstatSync(childPath);
  if (pathStats.isSymbolicLink() || !pathStats.isDirectory()) {
    throw new UnsafeHostAuthorityFileError('宿主凭证子目录不是普通目录');
  }
  assertSecureParentStats(pathStats);
  if (options.exactMode !== undefined && process.platform !== 'win32'
      && (pathStats.mode & 0o777) !== options.exactMode) {
    throw new UnsafeHostAuthorityFileError(
      `宿主凭证目录权限必须严格为 0${options.exactMode.toString(8)}`,
    );
  }
  if (process.platform !== 'linux') {
    const canonical = realpathSync(childPath);
    assertAncestorChainCannotReplace(canonical);
    return { path: canonical };
  }
  const fd = openSync(childPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const openedStats = fstatSync(fd);
    assertSecureParentStats(openedStats);
    if (!sameInode(pathStats, openedStats)) {
      throw new UnsafeHostAuthorityFileError('宿主凭证子目录在打开时发生变化');
    }
    const anchoredPath = `/proc/self/fd/${fd}`;
    if (!sameInode(openedStats, statSync(anchoredPath))) {
      throw new UnsafeHostAuthorityFileError('宿主凭证子目录句柄发生变化');
    }
    if (parent.fd !== undefined) fsyncSync(parent.fd);
    return { path: anchoredPath, fd };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function withAcquiredSecureHostParentSync<T>(
  parent: SecureHostParent,
  leafName: string,
  fn: (handle: SecureHostParentHandle) => NonThenable<T>,
): T {
  const anchoredLeafPath = join(parent.path, leafName);
  let released = false;
  const assertActive = (): void => {
    if (released) {
      throw new UnsafeHostAuthorityFileError('宿主凭证目录句柄已释放，禁止在回调返回后继续使用');
    }
  };
  try {
    const handle: SecureHostParentHandle = {
      leafName,
      readLeaf: (maxBytes = 64 * 1024) => {
        assertActive();
        return readSecureHostFileFromParentSync(parent, leafName, maxBytes);
      },
      readNamedLeaf: (name: string, maxBytes = 64 * 1024) => {
        assertActive();
        assertPlainLeafName(name);
        return readSecureHostFileFromParentSync(parent, name, maxBytes);
      },
      writeLeaf: (data: string) => {
        assertActive();
        writeSecureLeafFromParentSync(parent, leafName, data);
      },
      writeNamedLeaf: (name: string, data: string, maxExistingBytes = 64 * 1024) => {
        assertActive();
        assertPlainLeafName(name);
        writeSecureLeafFromParentSync(parent, name, data, maxExistingBytes);
      },
      unlinkNamedLeaf: (name: string, maxBytes = 64 * 1024) => {
        assertActive();
        assertPlainLeafName(name);
        if (readSecureHostFileFromParentSync(parent, name, maxBytes) === null) return false;
        unlinkSync(join(parent.path, name));
        if (process.platform !== 'win32') {
          if (parent.fd !== undefined) fsyncSync(parent.fd);
          else {
            const fd = openSync(parent.path, constants.O_RDONLY);
            try { fsyncSync(fd); } finally { closeSync(fd); }
          }
        }
        return true;
      },
      unlinkNamedRegularFile: (name: string) => {
        assertActive();
        assertPlainLeafName(name);
        return unlinkSecureRegularLeafFromParentSync(parent, name);
      },
      listLeafNames: () => {
        assertActive();
        return readdirSync(parent.path)
          .filter((name) => basename(name) === name && name !== '.' && name !== '..');
      },
      withNamedLeafLock: <R>(name: string, inner: () => NonThenable<R>): R => {
        assertActive();
        assertPlainLeafName(name);
        return withFileLockSync(join(parent.path, name), inner);
      },
      withChildDirectory: <R>(
        name: string,
        inner: (child: SecureHostParentHandle) => NonThenable<R>,
        childOptions: { create?: boolean; exactMode?: number } = {},
      ): R | undefined => {
        assertActive();
        assertPlainLeafName(name);
        let childParent: SecureHostParent;
        try { childParent = acquireSecureChildDirectorySync(parent, name, childOptions); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw error;
        }
        return withAcquiredSecureHostParentSync(childParent, '.pinned-child', inner);
      },
      withLeafLock: <R>(inner: () => NonThenable<R>): R => {
        assertActive();
        return withFileLockSync(anchoredLeafPath, inner);
      },
    };
    return fn(handle);
  } finally {
    released = true;
    releaseSecureHostParent(parent);
  }
}

/**
 * Acquire the secure parent directory once and expose it to `fn` as a pinned
 * handle for the SYNCHRONOUS duration of the call, releasing the descriptor
 * afterwards. Use this instead of chaining {@link secureHostFilePath} +
 * independent read/write calls when a credential needs a serialized
 * get-or-create (lock → read → write): resolving the lock and the leaf through
 * the same descriptor keeps the whole critical section on one directory inode.
 * Unlike {@link secureHostFilePath}, this does not force the strict
 * ancestor-chain assertion on Linux — the pinned descriptor already makes later
 * operations independent of ancestor renames — so it works under a symlinked
 * HOME or a shared-drive/0777 ancestor while `~/.botmux` itself stays 0700 and
 * owned by the current user.
 *
 * Fail-closed lifetime: `fn` MUST be synchronous. The `NonThenable` return
 * bound rejects `async`/Promise-returning callbacks at compile time; the handle
 * exposes no raw path (only guarded methods); and every method re-checks
 * `active` at runtime — after this function returns, any escaped handle traps
 * instead of touching the released (and possibly fd-recycled) anchor.
 */
export function withSecureHostParentSync<T>(
  filePath: string,
  fn: (handle: SecureHostParentHandle) => NonThenable<T>,
  options: { exactParentMode?: number } = {},
): T {
  const parent = acquireSecureHostParent(filePath, options.exactParentMode);
  const leafName = basename(filePath);
  return withAcquiredSecureHostParentSync(parent, leafName, fn);
}

/** Strict durable unlink. Returns false only if the leaf is absent. */
export function unlinkSecureHostFileSync(filePath: string): boolean {
  const parent = acquireSecureHostParent(filePath);
  const leafName = basename(filePath);
  const resolved = join(parent.path, leafName);
  try {
    if (readSecureHostFileFromParentSync(parent, leafName, 64 * 1024) === null) return false;
    unlinkSync(resolved);
    if (process.platform !== 'win32') {
      if (parent.fd !== undefined) {
        fsyncSync(parent.fd);
      } else {
        const fd = openSync(parent.path, constants.O_RDONLY);
        try { fsyncSync(fd); } finally { closeSync(fd); }
      }
    }
    return true;
  } finally {
    releaseSecureHostParent(parent);
  }
}

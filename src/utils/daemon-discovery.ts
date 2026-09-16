/**
 * Cross-process discovery and publication helpers for botmux daemons.
 *
 * Modern descriptors are keyed by an irreversible digest of the complete
 * process generation identity. This deliberately permits an outgoing and an
 * incoming generation of the same Lark app to coexist during restart. Legacy
 * `<larkAppId>.json` descriptors remain readable for rolling upgrades, but
 * modern writers and removers never address that legacy pathname.
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  type Stats,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveBotmuxDataDir } from '../core/data-dir.js';
import { readSupervisorProcessStartIdentity } from '../core/process-start-identity.js';
import { atomicWriteFileSync } from './atomic-write.js';
import { withFileLockSync } from './file-lock.js';

export interface DaemonDescriptorIdentity {
  larkAppId: string;
  bootInstanceId: string;
  pid: number;
  processStartIdentity: string;
  rosterRevision: string;
}

export interface OnlineDaemonInfo {
  larkAppId: string;
  ipcPort: number;
  /** Random per-process audience for authenticated Workflow v3 mutations. */
  bootInstanceId?: string;
  /** Kernel/OS process-birth identity from the published daemon descriptor. */
  processStartIdentity?: string;
  /** Full authoritative bots-config revision this process proved at startup. */
  rosterRevision?: string;
  /** Auth protocol advertised atomically with bootInstanceId + ipcPort. */
  workflowIpcProtocol?: string;
  /** Ask-receipt authority protocol advertised by the live daemon descriptor. */
  receiptAuthorityProtocolVersion?: number;
  /** Active marker epoch currently advertised by the live daemon descriptor. */
  receiptAuthorityActivationEpoch?: string;
  /** Exact graceful-shutdown protocol armed by this daemon generation. */
  supervisorShutdownProtocol?: string;
  botName?: string;
  cliId?: string;
  botAvatarUrl?: string;
  botIndex?: number;
  pid?: number;
  startedAt?: number;
  lastHeartbeat?: number;
  resolvedAllowedUsers?: string[];
}

export interface DaemonDescriptorPublication {
  filePath: string;
  raw: string;
  identity: DaemonDescriptorIdentity;
  device: number;
  inode: number;
}

export interface DaemonDiscoveryOptions {
  registryDir?: string;
  now?: number;
  processStart?: (pid: number) => string | undefined;
  processExists?: (pid: number) => boolean;
  cleanupStale?: boolean;
}

export class DaemonDescriptorValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonDescriptorValidationError';
  }
}

export const DAEMON_DESCRIPTOR_STALE_MS = 90_000;
const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const SAFE_APP_ID = /^[A-Za-z0-9._-]+$/;
const ROSTER_REVISION = /^[a-f0-9]{64}$/;
const IDENTITY_DESCRIPTOR = /^daemon-([a-f0-9]{64})\.json$/;

interface ObservedFile {
  filePath: string;
  raw: string;
  stat: Stats;
}

interface DaemonCandidate {
  daemon: OnlineDaemonInfo;
  identityKey?: string;
  legacy: boolean;
}

type ExactProcessStatus = 'alive' | 'dead' | 'unknown';
interface ProcessGeneration {
  pid: number;
  processStartIdentity: string;
}

/** `dataDir` lets a caller that already resolved a data dir keep the daemon
 *  probe and its store access on the SAME directory. Omitting it falls back to
 *  the process-wide resolution, which is what every host-CLI caller wants. */
function registryDir(dataDir?: string): string {
  return join(dataDir ?? resolveBotmuxDataDir(), 'dashboard-daemons');
}

function validIdentity(identity: DaemonDescriptorIdentity): boolean {
  return SAFE_APP_ID.test(identity.larkAppId)
    && identity.larkAppId.length <= 256
    && identity.bootInstanceId.length > 0
    && identity.bootInstanceId.length <= 256
    && !identity.bootInstanceId.includes('\0')
    && Number.isSafeInteger(identity.pid)
    && identity.pid > 1
    && identity.processStartIdentity.length > 0
    && identity.processStartIdentity.length <= 1_024
    && !identity.processStartIdentity.includes('\0')
    && ROSTER_REVISION.test(identity.rosterRevision);
}

function identityTuple(identity: DaemonDescriptorIdentity): string {
  return [
    'botmux-daemon-descriptor-v2',
    identity.larkAppId,
    identity.bootInstanceId,
    String(identity.pid),
    identity.processStartIdentity,
    identity.rosterRevision,
  ].join('\0');
}

/** Safe, irreversible filename for one exact daemon process generation. */
export function daemonDescriptorFileName(identity: DaemonDescriptorIdentity): string {
  if (!validIdentity(identity)) throw new Error('invalid daemon descriptor identity');
  const digest = createHash('sha256').update(identityTuple(identity), 'utf8').digest('hex');
  return `daemon-${digest}.json`;
}

export function daemonDescriptorPath(
  directory: string,
  identity: DaemonDescriptorIdentity,
): string {
  return join(directory, daemonDescriptorFileName(identity));
}

function sameInode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function readObservedFile(filePath: string): ObservedFile | null {
  let fd: number | undefined;
  try {
    const flags = constants.O_RDONLY
      | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW);
    fd = openSync(filePath, flags);
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > MAX_DESCRIPTOR_BYTES) return null;
    const raw = readFileSync(fd, 'utf8');
    const after = fstatSync(fd);
    if (!sameInode(before, after)
        || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs
        || before.ctimeMs !== after.ctimeMs) return null;
    return { filePath, raw, stat: after };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

function removeObservedFile(observed: ObservedFile, maxWaitMs = 2_000): boolean {
  try {
    return withFileLockSync(observed.filePath, () => {
      const current = readObservedFile(observed.filePath);
      if (!current
          || current.raw !== observed.raw
          || !sameInode(current.stat, observed.stat)) return false;
      let pathStat: Stats;
      try { pathStat = lstatSync(observed.filePath); } catch { return false; }
      if (!pathStat.isFile() || !sameInode(pathStat, current.stat)) return false;
      unlinkSync(observed.filePath);
      return true;
    }, { maxWaitMs });
  } catch {
    return false;
  }
}

/**
 * Atomically publish a descriptor and retain the exact bytes/inode needed for
 * compare-and-remove cleanup. Writers of the same generation serialize on the
 * leaf lock; different generations never share a pathname.
 */
export function publishDaemonDescriptor<T extends DaemonDescriptorIdentity & { lastHeartbeat: number }>(
  directory: string,
  descriptor: T,
): DaemonDescriptorPublication {
  const identity: DaemonDescriptorIdentity = {
    larkAppId: descriptor.larkAppId,
    bootInstanceId: descriptor.bootInstanceId,
    pid: descriptor.pid,
    processStartIdentity: descriptor.processStartIdentity,
    rosterRevision: descriptor.rosterRevision,
  };
  const filePath = daemonDescriptorPath(directory, identity);
  const raw = JSON.stringify(descriptor);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return withFileLockSync(filePath, () => {
    atomicWriteFileSync(filePath, raw, { mode: 0o600, followTargetSymlink: false });
    const stat = lstatSync(filePath);
    if (!stat.isFile()) throw new Error('daemon descriptor publication is not a regular file');
    return { filePath, raw, identity, device: stat.dev, inode: stat.ino };
  });
}

/** Remove only the exact bytes and inode produced by this publication. */
export function removeDaemonDescriptorPublication(
  publication: DaemonDescriptorPublication | undefined,
): boolean {
  if (!publication) return false;
  const expectedPath = daemonDescriptorPath(
    dirname(publication.filePath),
    publication.identity,
  );
  if (expectedPath !== publication.filePath) return false;
  try {
    return withFileLockSync(publication.filePath, () => {
      const current = readObservedFile(publication.filePath);
      if (!current
          || current.raw !== publication.raw
          || current.stat.dev !== publication.device
          || current.stat.ino !== publication.inode) return false;
      const pathStat = lstatSync(publication.filePath);
      if (!pathStat.isFile() || !sameInode(pathStat, current.stat)) return false;
      unlinkSync(publication.filePath);
      return true;
    }, { maxWaitMs: 2_000 });
  } catch {
    return false;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH proves absence; permission and unexpected probe failures must
    // retain the descriptor because the process may still be alive.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function exactProcessStatus(
  daemon: ProcessGeneration,
  readStart: (pid: number) => string | undefined,
  exists: (pid: number) => boolean,
): ExactProcessStatus {
  const pid = daemon.pid;
  const liveStart = readStart(pid);
  if (liveStart !== undefined) {
    return liveStart === daemon.processStartIdentity ? 'alive' : 'dead';
  }
  return exists(pid) ? 'unknown' : 'dead';
}

function exactModernProcessStatus(
  daemon: OnlineDaemonInfo,
  readStart: (pid: number) => string | undefined,
  exists: (pid: number) => boolean,
): ExactProcessStatus {
  const { pid, processStartIdentity } = daemon;
  if (!pid || !processStartIdentity) {
    throw new Error('validated modern descriptor is missing its process identity');
  }
  return exactProcessStatus({
    pid,
    processStartIdentity,
  }, readStart, exists);
}

function invalidDescriptor(fileName: string, reason: string): never {
  throw new DaemonDescriptorValidationError(`invalid daemon descriptor ${fileName}: ${reason}`);
}

function parseDescriptor(
  fileName: string,
  raw: string,
  identityNamed: boolean,
): OnlineDaemonInfo {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { return invalidDescriptor(fileName, 'malformed JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalidDescriptor(fileName, 'invalid object');
  }
  const d = value as Record<string, unknown>;
  if (typeof d.larkAppId !== 'string'
      || !SAFE_APP_ID.test(d.larkAppId)
      || d.larkAppId.length > 256
      || !Number.isSafeInteger(d.ipcPort)
      || (d.ipcPort as number) < 1
      || (d.ipcPort as number) > 65_535
      || !Number.isSafeInteger(d.lastHeartbeat)
      || (d.lastHeartbeat as number) <= 0) {
    return invalidDescriptor(fileName, 'invalid common fields');
  }
  if (!identityNamed && fileName !== `${d.larkAppId}.json`) {
    return invalidDescriptor(fileName, 'legacy filename/content mismatch');
  }

  const identityFieldsPresent = d.bootInstanceId !== undefined
    || d.pid !== undefined
    || d.processStartIdentity !== undefined
    || d.rosterRevision !== undefined;
  if (!identityNamed
      && (d.processStartIdentity !== undefined || d.rosterRevision !== undefined)) {
    return invalidDescriptor(fileName, 'legacy descriptor carries modern identity');
  }
  let identity: DaemonDescriptorIdentity | undefined;
  if (identityNamed || identityFieldsPresent) {
    identity = {
      larkAppId: d.larkAppId,
      bootInstanceId: typeof d.bootInstanceId === 'string' ? d.bootInstanceId : '',
      pid: typeof d.pid === 'number' ? d.pid : Number.NaN,
      processStartIdentity: typeof d.processStartIdentity === 'string'
        ? d.processStartIdentity
        : '',
      rosterRevision: typeof d.rosterRevision === 'string' ? d.rosterRevision : '',
    };
    if (identityNamed && !validIdentity(identity)) {
      return invalidDescriptor(fileName, 'invalid generation identity');
    }
    if (identityNamed && daemonDescriptorFileName(identity) !== fileName) {
      return invalidDescriptor(fileName, 'filename/content identity mismatch');
    }
  }

  if (d.receiptAuthorityProtocolVersion !== undefined
      && (!Number.isSafeInteger(d.receiptAuthorityProtocolVersion)
        || (d.receiptAuthorityProtocolVersion as number) < 1)) {
    return invalidDescriptor(fileName, 'invalid receipt authority protocol');
  }
  if (d.receiptAuthorityActivationEpoch !== undefined
      && (typeof d.receiptAuthorityActivationEpoch !== 'string'
        || !/^[A-Za-z0-9_-]{32,128}$/.test(d.receiptAuthorityActivationEpoch))) {
    return invalidDescriptor(fileName, 'invalid receipt authority epoch');
  }

  return {
    larkAppId: d.larkAppId,
    ipcPort: d.ipcPort as number,
    ...(typeof d.bootInstanceId === 'string' && d.bootInstanceId
      ? { bootInstanceId: d.bootInstanceId }
      : {}),
    ...(typeof d.processStartIdentity === 'string' && d.processStartIdentity
      ? { processStartIdentity: d.processStartIdentity }
      : {}),
    ...(typeof d.rosterRevision === 'string' && ROSTER_REVISION.test(d.rosterRevision)
      ? { rosterRevision: d.rosterRevision }
      : {}),
    ...(typeof d.workflowIpcProtocol === 'string' && d.workflowIpcProtocol
      ? { workflowIpcProtocol: d.workflowIpcProtocol }
      : {}),
    ...(typeof d.receiptAuthorityProtocolVersion === 'number'
      ? { receiptAuthorityProtocolVersion: d.receiptAuthorityProtocolVersion }
      : {}),
    ...(typeof d.receiptAuthorityActivationEpoch === 'string'
      ? { receiptAuthorityActivationEpoch: d.receiptAuthorityActivationEpoch }
      : {}),
    ...(typeof d.supervisorShutdownProtocol === 'string' && d.supervisorShutdownProtocol
      ? { supervisorShutdownProtocol: d.supervisorShutdownProtocol }
      : {}),
    ...(typeof d.botName === 'string' && d.botName.trim() ? { botName: d.botName.trim() } : {}),
    ...(typeof d.cliId === 'string' && d.cliId.trim() ? { cliId: d.cliId.trim() } : {}),
    ...(typeof d.botAvatarUrl === 'string' && d.botAvatarUrl.trim()
      ? { botAvatarUrl: d.botAvatarUrl.trim() }
      : {}),
    ...(Number.isSafeInteger(d.botIndex) ? { botIndex: d.botIndex as number } : {}),
    ...(Number.isSafeInteger(d.pid) ? { pid: d.pid as number } : {}),
    ...(Number.isSafeInteger(d.startedAt) ? { startedAt: d.startedAt as number } : {}),
    lastHeartbeat: d.lastHeartbeat as number,
    ...(Array.isArray(d.resolvedAllowedUsers)
        && d.resolvedAllowedUsers.every(item => typeof item === 'string')
      ? { resolvedAllowedUsers: d.resolvedAllowedUsers as string[] }
      : {}),
  };
}

function candidateFreshness(left: DaemonCandidate, right: DaemonCandidate): number {
  if (left.legacy !== right.legacy) return left.legacy ? 1 : -1;
  const heartbeat = (right.daemon.lastHeartbeat ?? 0) - (left.daemon.lastHeartbeat ?? 0);
  if (heartbeat !== 0) return heartbeat;
  const started = (right.daemon.startedAt ?? 0) - (left.daemon.startedAt ?? 0);
  if (started !== 0) return started;
  return (right.daemon.pid ?? 0) - (left.daemon.pid ?? 0);
}

function readDaemonCandidates(options: DaemonDiscoveryOptions): DaemonCandidate[] {
  const directory = options.registryDir ?? registryDir();
  if (!existsSync(directory)) return [];
  const now = options.now ?? Date.now();
  const readStart = options.processStart ?? readSupervisorProcessStartIdentity;
  const exists = options.processExists ?? processExists;
  const cleanupStale = options.cleanupStale ?? true;
  let names: string[];
  try { names = readdirSync(directory).sort(); } catch { return []; }
  const candidates: DaemonCandidate[] = [];

  for (const fileName of names) {
    if (!fileName.endsWith('.json')) continue;
    const modernLike = fileName.startsWith('daemon-');
    const identityNamed = IDENTITY_DESCRIPTOR.test(fileName);
    const observed = readObservedFile(join(directory, fileName));
    if (!observed) {
      if (modernLike) invalidDescriptor(fileName, 'unreadable or unstable');
      continue;
    }

    let daemon: OnlineDaemonInfo;
    try {
      daemon = parseDescriptor(fileName, observed.raw, identityNamed);
    } catch (error) {
      if (modernLike) throw error;
      const staleByMtime = now - observed.stat.mtimeMs > DAEMON_DESCRIPTOR_STALE_MS;
      if (staleByMtime && cleanupStale) {
        removeObservedFile(observed, 100);
        continue;
      }
      continue;
    }

    let exactModernProcessAlive = false;
    if (identityNamed && daemon.processStartIdentity && daemon.pid) {
      const processStatus = exactModernProcessStatus(daemon, readStart, exists);
      exactModernProcessAlive = processStatus === 'alive';
      if (processStatus !== 'alive') {
        if (processStatus === 'unknown') {
          invalidDescriptor(fileName, 'live process identity is unavailable');
        }
        if (cleanupStale) removeObservedFile(observed, 100);
        continue;
      }
    }

    const heartbeat = daemon.lastHeartbeat!;
    if (heartbeat > now + DAEMON_DESCRIPTOR_STALE_MS) {
      if (identityNamed) invalidDescriptor(fileName, 'heartbeat is in the future');
      continue;
    }
    // A modern descriptor names an exact live kernel process generation. Its
    // heartbeat may stop while the process is paused or event-loop stalled;
    // hiding it would let activation ignore a still-live predecessor. Legacy
    // descriptors have no such proof and retain heartbeat-only compatibility.
    if (!exactModernProcessAlive && now - heartbeat > DAEMON_DESCRIPTOR_STALE_MS) {
      if (cleanupStale) removeObservedFile(observed, 100);
      continue;
    }

    const identity = daemon.bootInstanceId
      && daemon.pid
      && daemon.processStartIdentity
      && daemon.rosterRevision
      ? {
          larkAppId: daemon.larkAppId,
          bootInstanceId: daemon.bootInstanceId,
          pid: daemon.pid,
          processStartIdentity: daemon.processStartIdentity,
          rosterRevision: daemon.rosterRevision,
        }
      : undefined;
    candidates.push({
      daemon,
      identityKey: identity ? identityTuple(identity) : undefined,
      legacy: !identityNamed,
    });
  }

  const byIdentity = new Map<string, DaemonCandidate>();
  const withoutIdentity: DaemonCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate.identityKey) {
      withoutIdentity.push(candidate);
      continue;
    }
    const current = byIdentity.get(candidate.identityKey);
    if (!current || (current.legacy && !candidate.legacy)) {
      byIdentity.set(candidate.identityKey, candidate);
    }
  }
  return [...byIdentity.values(), ...withoutIdentity].sort((left, right) => {
    const app = left.daemon.larkAppId.localeCompare(right.daemon.larkAppId);
    return app || candidateFreshness(left, right);
  });
}

/** Parse a loopback daemon IPC port from a descriptor or injected env value. */
export function parseDaemonIpcPort(value: unknown): number | undefined {
  const port = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : Number.NaN;
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535
    ? port
    : undefined;
}

/** Prefer host discovery, then an explicitly injected isolated-CLI port. */
export function resolveDaemonIpcPort(
  discovered: unknown,
  injected: unknown,
): number | undefined {
  return parseDaemonIpcPort(discovered) ?? parseDaemonIpcPort(injected);
}

function normalizeDiscoveryOptions(
  options: DaemonDiscoveryOptions | string,
): DaemonDiscoveryOptions {
  return typeof options === 'string'
    ? { registryDir: registryDir(options) }
    : options;
}

/** List every live process generation; same-App predecessors are preserved. */
export function listOnlineDaemons(
  options: DaemonDiscoveryOptions | string = {},
): OnlineDaemonInfo[] {
  return readDaemonCandidates(normalizeDiscoveryOptions(options))
    .map(candidate => candidate.daemon);
}

/** Select the freshest modern generation for ordinary single-daemon callers. */
export function findOnlineDaemon(
  larkAppId: string,
  options: DaemonDiscoveryOptions | string = {},
): OnlineDaemonInfo | null {
  const matches = readDaemonCandidates(normalizeDiscoveryOptions(options))
    .filter(candidate => candidate.daemon.larkAppId === larkAppId)
    .sort(candidateFreshness);
  return matches[0]?.daemon ?? null;
}

/**
 * Exact-CAS cleanup for old registry files. Modern descriptors are removed
 * only after proving their exact process generation is gone; legacy files
 * retain the historical mtime-only cleanup rule.
 */
export function cleanupStaleDaemonDescriptorFiles(
  directory: string,
  staleAfterMs = 5 * 60_000,
  now = Date.now(),
  options: Pick<DaemonDiscoveryOptions, 'processStart' | 'processExists'> = {},
): number {
  if (!existsSync(directory)) return 0;
  const readStart = options.processStart ?? readSupervisorProcessStartIdentity;
  const exists = options.processExists ?? processExists;
  let names: string[];
  try { names = readdirSync(directory); } catch { return 0; }
  let removed = 0;
  for (const fileName of names) {
    if (!fileName.endsWith('.json')) continue;
    const observed = readObservedFile(join(directory, fileName));
    if (!observed || now - observed.stat.mtimeMs <= staleAfterMs) continue;

    const modernLike = fileName.startsWith('daemon-');
    const identityNamed = IDENTITY_DESCRIPTOR.test(fileName);
    if (modernLike && !identityNamed) {
      invalidDescriptor(fileName, 'invalid modern filename');
    }
    if (identityNamed) {
      const daemon = parseDescriptor(fileName, observed.raw, true);
      const processStatus = exactModernProcessStatus(daemon, readStart, exists);
      if (processStatus !== 'dead') continue;
    }
    if (removeObservedFile(observed)) removed += 1;
  }
  return removed;
}

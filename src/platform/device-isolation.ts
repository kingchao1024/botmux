/** Host-side activation marker for mandatory device isolation. */
import { homedir } from 'node:os';
import { probeHostCredentialIsolationMechanism } from '../adapters/backend/sandbox.js';
import { withFileLock, withFileLockSync, type FileLockOptions } from '../utils/file-lock.js';
import {
  deviceCredentialIsolationMarkerPath,
} from '../adapters/cli/read-isolation.js';
import {
  readSecureHostFileSync,
  writeSecureHostFileSync,
} from './secure-host-file.js';

const DEVICE_ISOLATION_MARKER_VERSION = 1 as const;
export const ASK_RECEIPT_AUTHORITY_VERSION = 1 as const;
export const ASK_RECEIPT_AUTHORITY_PROTOCOL_VERSION = 1 as const;
export const MAX_MARKER_BYTES = 256 * 1024;
export const MAX_PARTICIPANTS = 256;
export const MAX_LARK_APP_ID_BYTES = 132;
export const MAX_BOOT_INSTANCE_ID_BYTES = 128;
export const MAX_PROC_START_BYTES = 256;

const LARK_APP_ID_PATTERN = /^cli_[A-Za-z0-9_-]{1,128}$/;
const MARKER_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
const PROC_START_PATTERN = /^[\x20-\x7e]+$/;

export interface DeviceIsolationMarkerParticipant {
  larkAppId: string;
  bootInstanceId: string;
  pid: number;
  procStart: string;
}

export interface DeviceIsolationMarkerProof {
  activationEpoch: string;
  protocolVersion: typeof ASK_RECEIPT_AUTHORITY_PROTOCOL_VERSION;
  participants: DeviceIsolationMarkerParticipant[];
}

export interface DeviceIsolationMarker {
  version: typeof DEVICE_ISOLATION_MARKER_VERSION;
  /** pending still activates worker fail-closed masking, but cannot authorize
   * the first credential write until every daemon has quiesced legacy CLIs. */
  state: 'pending' | 'active';
  enabledAt: string;
  activatedAt?: string;
  askReceiptAuthorityVersion?: number;
  askReceiptAuthorityProof?: DeviceIsolationMarkerProof;
}

export class DeviceIsolationActivationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceIsolationActivationError';
  }
}

export interface DeviceIsolationActivationOptions {
  homeDir?: string;
  now?: () => Date;
}

export interface DeviceIsolationMarkerCompletionOptions extends DeviceIsolationActivationOptions {
  receiptAuthorityProof: DeviceIsolationMarkerProof;
  preparedMarker?: PreparedDeviceIsolationMarkerCompletion;
}

export interface PreparedDeviceIsolationMarkerCompletion {
  path: string;
  expectedCurrentRaw: string;
  activeRaw: string;
}

/**
 * Serialize the host-wide credential-isolation transition with daemon startup.
 * Both sides deliberately lock the marker's sibling lock file: a daemon may
 * publish its discoverable descriptor only while holding this lock, and the
 * activation coordinator holds it from discovery through ACTIVE publication.
 */
export function withDeviceCredentialIsolationActivationLock<T>(
  fn: () => Promise<T>,
  options: DeviceIsolationActivationOptions & { lock?: FileLockOptions } = {},
): Promise<T> {
  return withFileLock(
    deviceCredentialIsolationMarkerPath(options.homeDir ?? homedir()),
    fn,
    options.lock,
  );
}

/** Synchronous companion for the supervisor's spawn boundary. The lock order is
 * always activation gate first, then the startup-registry leaf lock. */
export function withDeviceCredentialIsolationActivationLockSync<T>(
  fn: () => T,
  options: DeviceIsolationActivationOptions & { lock?: FileLockOptions } = {},
): T {
  return withFileLockSync(
    deviceCredentialIsolationMarkerPath(options.homeDir ?? homedir()),
    fn,
    options.lock,
  );
}

/** Probe before writing the one-way marker; unsupported hosts refuse enroll. */
export function deviceCredentialIsolationSupported(platform = process.platform): boolean {
  if (platform !== process.platform || (platform !== 'darwin' && platform !== 'linux')) return false;
  return probeHostCredentialIsolationMechanism().supported;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(record).every(key => allowed.has(key));
}

function byteLengthWithin(value: string, maxBytes: number): boolean {
  return Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function normalizeReceiptAuthorityProof(value: unknown): DeviceIsolationMarkerProof {
  if (!isRecord(value) || !hasOnlyKeys(value, ['activationEpoch', 'protocolVersion', 'participants'])) {
    throw new Error('invalid marker');
  }
  if (
    typeof value.activationEpoch !== 'string'
    || !/^[A-Za-z0-9_-]{32,128}$/.test(value.activationEpoch)
    || value.protocolVersion !== ASK_RECEIPT_AUTHORITY_PROTOCOL_VERSION
    || !Array.isArray(value.participants)
    || value.participants.length === 0
    || value.participants.length > MAX_PARTICIPANTS
  ) {
    throw new Error('invalid marker');
  }

  const appIds = new Set<string>();
  const identities = new Set<string>();
  const participants = value.participants.map((item) => {
    if (!isRecord(item) || !hasOnlyKeys(item, ['larkAppId', 'bootInstanceId', 'pid', 'procStart'])) {
      throw new Error('invalid marker');
    }
    if (
      typeof item.larkAppId !== 'string'
      || !LARK_APP_ID_PATTERN.test(item.larkAppId)
      || !byteLengthWithin(item.larkAppId, MAX_LARK_APP_ID_BYTES)
      || typeof item.bootInstanceId !== 'string'
      || !MARKER_TOKEN_PATTERN.test(item.bootInstanceId)
      || !byteLengthWithin(item.bootInstanceId, MAX_BOOT_INSTANCE_ID_BYTES)
      || typeof item.pid !== 'number'
      || !Number.isSafeInteger(item.pid)
      || item.pid <= 1
      || item.pid > 0x7fff_ffff
      || typeof item.procStart !== 'string'
      || item.procStart.trim() !== item.procStart
      || !PROC_START_PATTERN.test(item.procStart)
      || !byteLengthWithin(item.procStart, MAX_PROC_START_BYTES)
    ) {
      throw new Error('invalid marker');
    }
    const identity = `${item.bootInstanceId}\u0000${item.pid}\u0000${item.procStart}`;
    if (appIds.has(item.larkAppId) || identities.has(identity)) throw new Error('invalid marker');
    appIds.add(item.larkAppId);
    identities.add(identity);
    return {
      larkAppId: item.larkAppId,
      bootInstanceId: item.bootInstanceId,
      pid: item.pid,
      procStart: item.procStart,
    } satisfies DeviceIsolationMarkerParticipant;
  });
  return {
    activationEpoch: value.activationEpoch,
    protocolVersion: ASK_RECEIPT_AUTHORITY_PROTOCOL_VERSION,
    participants,
  };
}

function normalizeDeviceIsolationMarker(value: unknown): DeviceIsolationMarker {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'version',
    'state',
    'enabledAt',
    'activatedAt',
    'askReceiptAuthorityVersion',
    'askReceiptAuthorityProof',
  ])) {
    throw new Error('invalid marker');
  }
  const parsed = value;
    const enabledAt = typeof parsed.enabledAt === 'string' ? parsed.enabledAt : '';
    const state = parsed.state === 'active' ? 'active' : 'pending';
    const activatedAt = typeof parsed.activatedAt === 'string' ? parsed.activatedAt : undefined;
    const askReceiptAuthorityVersion = parsed.askReceiptAuthorityVersion;
    const proofValue = parsed.askReceiptAuthorityProof;
    let askReceiptAuthorityProof: DeviceIsolationMarkerProof | undefined;
    if (proofValue !== undefined) {
      askReceiptAuthorityProof = normalizeReceiptAuthorityProof(proofValue);
    }
    if (
      parsed.version !== DEVICE_ISOLATION_MARKER_VERSION
      || !enabledAt
      || new Date(enabledAt).toISOString() !== enabledAt
      || (parsed.state !== undefined && parsed.state !== 'pending' && parsed.state !== 'active')
      || (askReceiptAuthorityVersion !== undefined && (
        typeof askReceiptAuthorityVersion !== 'number'
        || !Number.isSafeInteger(askReceiptAuthorityVersion)
        || askReceiptAuthorityVersion < 1
      ))
      || (state === 'active' && (!activatedAt || new Date(activatedAt).toISOString() !== activatedAt))
      || (state === 'pending' && (activatedAt !== undefined
        || askReceiptAuthorityVersion !== undefined
        || askReceiptAuthorityProof !== undefined))
      || ((askReceiptAuthorityVersion === undefined) !== (askReceiptAuthorityProof === undefined))
      || (askReceiptAuthorityProof !== undefined
        && askReceiptAuthorityVersion !== ASK_RECEIPT_AUTHORITY_VERSION)
    ) throw new Error('invalid marker');
    return {
      version: DEVICE_ISOLATION_MARKER_VERSION,
      state,
      enabledAt,
      ...(activatedAt ? { activatedAt } : {}),
      ...(askReceiptAuthorityVersion !== undefined ? { askReceiptAuthorityVersion } : {}),
      ...(askReceiptAuthorityProof ? { askReceiptAuthorityProof } : {}),
    };
}

function markerBytes(raw: string): number {
  return Buffer.byteLength(raw, 'utf8');
}

export function encodeDeviceCredentialIsolationMarker(marker: DeviceIsolationMarker): string {
  try {
    const normalized = normalizeDeviceIsolationMarker(marker);
    const raw = `${JSON.stringify(normalized, null, 2)}\n`;
    if (markerBytes(raw) > MAX_MARKER_BYTES) throw new Error('marker too large');
    return raw;
  } catch {
    throw new DeviceIsolationActivationError(
      '设备凭证隔离 marker 已损坏；拒绝继续注册，请先修复宿主配置',
    );
  }
}

export function parseDeviceIsolationMarker(raw: string): DeviceIsolationMarker {
  try {
    if (markerBytes(raw) > MAX_MARKER_BYTES) throw new Error('marker too large');
    return normalizeDeviceIsolationMarker(JSON.parse(raw));
  } catch {
    throw new DeviceIsolationActivationError(
      '设备凭证隔离 marker 已损坏；拒绝继续注册，请先修复宿主配置',
    );
  }
}

export function deviceCredentialIsolationMarkerState(
  raw: string,
): 'pending' | 'active' | 'invalid' {
  try {
    const marker = parseDeviceIsolationMarker(raw);
    if (marker.state === 'pending') return 'pending';
    return deviceCredentialIsolationMarkerEnablesAskReceiptAuthority(marker) ? 'active' : 'invalid';
  } catch {
    return 'invalid';
  }
}

export function readDeviceCredentialIsolationMarker(
  options: Pick<DeviceIsolationActivationOptions, 'homeDir'> = {},
): DeviceIsolationMarker | null {
  const home = options.homeDir ?? homedir();
  const raw = readSecureHostFileSync(
    deviceCredentialIsolationMarkerPath(home),
    MAX_MARKER_BYTES,
  );
  return raw === null ? null : parseDeviceIsolationMarker(raw);
}

/** Create the one-way PENDING marker durably. Pending already forces every new
 * local worker into credential isolation, but retries must still quiesce all
 * daemons before the marker may transition to ACTIVE. */
export function ensureDeviceCredentialIsolationMarker(
  options: DeviceIsolationActivationOptions = {},
): { created: boolean; path: string; state: 'pending' | 'active' } {
  const home = options.homeDir ?? homedir();
  const path = deviceCredentialIsolationMarkerPath(home);
  const current = readSecureHostFileSync(path, MAX_MARKER_BYTES);
  if (current !== null) {
    const parsed = parseDeviceIsolationMarker(current);
    if (deviceCredentialIsolationMarkerEnablesAskReceiptAuthority(parsed)) {
      return { created: false, path, state: 'active' };
    }
    writeSecureHostFileSync(path, encodeDeviceCredentialIsolationMarker({
      version: DEVICE_ISOLATION_MARKER_VERSION,
      state: 'pending',
      enabledAt: parsed.enabledAt,
    }), MAX_MARKER_BYTES);
    return { created: false, path, state: 'pending' };
  }
  const enabledAt = (options.now ?? (() => new Date()))().toISOString();
  writeSecureHostFileSync(path, encodeDeviceCredentialIsolationMarker({
    version: DEVICE_ISOLATION_MARKER_VERSION,
    state: 'pending',
    enabledAt,
  }), MAX_MARKER_BYTES);
  return { created: true, path, state: 'pending' };
}

export function deviceCredentialIsolationMarkerEnablesAskReceiptAuthority(
  marker: DeviceIsolationMarker | null,
): boolean {
  return marker?.state === 'active'
    && marker.askReceiptAuthorityVersion === ASK_RECEIPT_AUTHORITY_VERSION
    && !!marker.askReceiptAuthorityProof
    && marker.askReceiptAuthorityProof.protocolVersion === ASK_RECEIPT_AUTHORITY_PROTOCOL_VERSION
    && /^[A-Za-z0-9_-]{32,128}$/.test(marker.askReceiptAuthorityProof.activationEpoch)
    && marker.askReceiptAuthorityProof.participants.length > 0;
}

export type AskReceiptAuthorityBootstrapDecision =
  | { enabled: true }
  | {
    enabled: false;
    reason:
    | 'marker_missing'
    | 'marker_invalid'
    | 'marker_pending'
    | 'marker_incomplete'
    | 'marker_roster_mismatch'
    | 'inventory_blocked'
    | 'local_session_unisolated';
  };

export interface AskReceiptAuthorityLiveSibling {
  larkAppId: string;
  bootInstanceId: string;
  pid: number;
  processStartIdentity: string;
  rosterRevision: string;
  receiptAuthorityProtocolVersion: number;
  receiptAuthorityActivationEpoch: string;
}

export interface AskReceiptAuthorityDaemonDescriptor {
  larkAppId: string;
  bootInstanceId?: string;
  pid?: number;
  processStartIdentity?: string;
  rosterRevision?: string;
  receiptAuthorityProtocolVersion?: number;
  receiptAuthorityActivationEpoch?: string;
}

/**
 * Build the live authority roster while startup's own descriptor is withheld.
 * An app id is not a process identity: a rolling-restart predecessor may have
 * the same app id and must remain visible until that exact boot/pid/procStart
 * exits. Only an exact current descriptor is replaced by the local self row.
 */
export function collectAskReceiptAuthorityLiveSiblings(input: {
  discoveredDaemons: readonly AskReceiptAuthorityDaemonDescriptor[];
  self: Omit<AskReceiptAuthorityLiveSibling,
    'receiptAuthorityProtocolVersion' | 'receiptAuthorityActivationEpoch'>;
  receiptAuthorityProtocolVersion?: number;
  receiptAuthorityActivationEpoch?: string;
}): {
  liveSiblings: AskReceiptAuthorityLiveSibling[];
  protocolCompatible: boolean;
} {
  const protocolVersion = input.receiptAuthorityProtocolVersion;
  const activationEpoch = input.receiptAuthorityActivationEpoch;
  let protocolCompatible = Number.isSafeInteger(protocolVersion)
    && typeof activationEpoch === 'string'
    && activationEpoch.length > 0
    && /^[a-f0-9]{64}$/.test(input.self.rosterRevision);
  const liveSiblings: AskReceiptAuthorityLiveSibling[] = protocolCompatible
    ? [{
        ...input.self,
        receiptAuthorityProtocolVersion: protocolVersion!,
        receiptAuthorityActivationEpoch: activationEpoch!,
      }]
    : [];
  for (const daemon of input.discoveredDaemons) {
    const exactSelf = daemon.larkAppId === input.self.larkAppId
      && daemon.bootInstanceId === input.self.bootInstanceId
      && daemon.pid === input.self.pid
      && daemon.processStartIdentity === input.self.processStartIdentity;
    if (exactSelf) continue;
    if (
      !daemon.bootInstanceId
      || !daemon.processStartIdentity
      || typeof daemon.rosterRevision !== 'string'
      || daemon.rosterRevision !== input.self.rosterRevision
      || !Number.isSafeInteger(daemon.pid)
      || (daemon.pid ?? 0) <= 1
      || !Number.isSafeInteger(daemon.receiptAuthorityProtocolVersion)
      || typeof daemon.receiptAuthorityActivationEpoch !== 'string'
      || !daemon.receiptAuthorityActivationEpoch
    ) {
      protocolCompatible = false;
      continue;
    }
    liveSiblings.push({
      larkAppId: daemon.larkAppId,
      bootInstanceId: daemon.bootInstanceId,
      pid: daemon.pid!,
      processStartIdentity: daemon.processStartIdentity,
      rosterRevision: daemon.rosterRevision,
      receiptAuthorityProtocolVersion: daemon.receiptAuthorityProtocolVersion!,
      receiptAuthorityActivationEpoch: daemon.receiptAuthorityActivationEpoch,
    });
  }
  return { liveSiblings, protocolCompatible };
}

function uniqueLiveSiblingIdentities(
  liveSiblings: readonly AskReceiptAuthorityLiveSibling[],
): boolean {
  if (liveSiblings.length === 0) return false;
  const appIds = new Set<string>();
  const processGenerations = new Set<string>();
  const rosterRevision = liveSiblings[0]?.rosterRevision;
  if (!rosterRevision || !/^[a-f0-9]{64}$/.test(rosterRevision)) return false;
  for (const sibling of liveSiblings) {
    if (sibling.rosterRevision !== rosterRevision) return false;
    const processGeneration = [
      sibling.bootInstanceId,
      String(sibling.pid),
      sibling.processStartIdentity,
    ].join('\u0000');
    if (appIds.has(sibling.larkAppId) || processGenerations.has(processGeneration)) return false;
    appIds.add(sibling.larkAppId);
    processGenerations.add(processGeneration);
  }
  return true;
}

export function verifyAskReceiptAuthorityActivationRoster(input: {
  marker: DeviceIsolationMarker;
  liveSiblings: readonly AskReceiptAuthorityLiveSibling[];
}): boolean {
  const proof = input.marker.askReceiptAuthorityProof;
  if (
    !deviceCredentialIsolationMarkerEnablesAskReceiptAuthority(input.marker)
    || !proof
    || proof.protocolVersion !== ASK_RECEIPT_AUTHORITY_PROTOCOL_VERSION
  ) return false;
  if (input.liveSiblings.some(sibling =>
    sibling.receiptAuthorityProtocolVersion !== proof.protocolVersion
    || sibling.receiptAuthorityActivationEpoch !== proof.activationEpoch
  )) return false;
  // The marker's participant roster proves the one-time activation transaction
  // completed under the current protocol. Legitimate later restarts must not be
  // pinned to that historical boot/process tuple forever; startup validates the
  // CURRENT live daemon set separately and rejects only missing/old-protocol
  // siblings before enabling the signer.
  return uniqueLiveSiblingIdentities(input.liveSiblings);
}

export function decideAskReceiptAuthorityBootstrap(input: {
  marker: DeviceIsolationMarker | 'invalid' | null;
  liveSiblings?: readonly AskReceiptAuthorityLiveSibling[];
  liveSiblingProtocolCompatible?: boolean;
  inventory: {
    blockers: readonly unknown[];
    entries: ReadonlyArray<{ disposition: string; credentialIsolated?: boolean }>;
  };
}): AskReceiptAuthorityBootstrapDecision {
  if (input.marker === null) return { enabled: false, reason: 'marker_missing' };
  if (input.marker === 'invalid') return { enabled: false, reason: 'marker_invalid' };
  if (input.marker.state !== 'active') return { enabled: false, reason: 'marker_pending' };
  if (!deviceCredentialIsolationMarkerEnablesAskReceiptAuthority(input.marker)) {
    return { enabled: false, reason: 'marker_incomplete' };
  }
  if (
    input.liveSiblingProtocolCompatible === false
    || (input.liveSiblings
    && !verifyAskReceiptAuthorityActivationRoster({
      marker: input.marker,
      liveSiblings: input.liveSiblings,
    }))
  ) {
    return { enabled: false, reason: 'marker_roster_mismatch' };
  }
  if (input.inventory.blockers.length > 0) {
    return { enabled: false, reason: 'inventory_blocked' };
  }
  if (input.inventory.entries.some(entry =>
    entry.disposition === 'owned_local' && entry.credentialIsolated !== true
  )) {
    return { enabled: false, reason: 'local_session_unisolated' };
  }
  return { enabled: true };
}

/** Construct and validate the exact ACTIVE bytes before any daemon commit. */
export function prepareDeviceCredentialIsolationMarkerCompletion(
  options: DeviceIsolationMarkerCompletionOptions,
): PreparedDeviceIsolationMarkerCompletion {
  const home = options.homeDir ?? homedir();
  const path = deviceCredentialIsolationMarkerPath(home);
  const currentRaw = readSecureHostFileSync(path, MAX_MARKER_BYTES);
  if (currentRaw === null) {
    throw new DeviceIsolationActivationError('设备凭证隔离 marker 尚未创建');
  }
  const current = parseDeviceIsolationMarker(currentRaw);
  if (current.state !== 'pending') {
    throw new DeviceIsolationActivationError('设备凭证隔离 marker 不是 PENDING');
  }
  const activatedAt = (options.now ?? (() => new Date()))().toISOString();
  const activeRaw = encodeDeviceCredentialIsolationMarker({
    version: DEVICE_ISOLATION_MARKER_VERSION,
    state: 'active',
    enabledAt: current.enabledAt,
    activatedAt,
    askReceiptAuthorityVersion: ASK_RECEIPT_AUTHORITY_VERSION,
    askReceiptAuthorityProof: options.receiptAuthorityProof,
  });
  return { path, expectedCurrentRaw: currentRaw, activeRaw };
}

/** Mark a fully quiesced host ACTIVE. This is the only state that lets a later
 * enroll skip the daemon transaction. The marker itself remains one-way. */
export function completeDeviceCredentialIsolationMarker(
  options: DeviceIsolationMarkerCompletionOptions,
): { path: string; state: 'active' } {
  const home = options.homeDir ?? homedir();
  const path = deviceCredentialIsolationMarkerPath(home);
  const currentRaw = readSecureHostFileSync(path, MAX_MARKER_BYTES);
  if (currentRaw === null) {
    throw new DeviceIsolationActivationError('设备凭证隔离 marker 尚未创建');
  }
  const current = parseDeviceIsolationMarker(currentRaw);
  if (deviceCredentialIsolationMarkerEnablesAskReceiptAuthority(current)) {
    return { path, state: 'active' };
  }
  const prepared = options.preparedMarker
    ?? prepareDeviceCredentialIsolationMarkerCompletion(options);
  if (prepared.path !== path || prepared.expectedCurrentRaw !== currentRaw) {
    throw new DeviceIsolationActivationError('设备凭证隔离 marker 在 ACTIVE 写入前发生变化');
  }
  const preparedActive = parseDeviceIsolationMarker(prepared.activeRaw);
  const expectedProof = normalizeReceiptAuthorityProof(options.receiptAuthorityProof);
  if (
    encodeDeviceCredentialIsolationMarker(preparedActive) !== prepared.activeRaw
    || preparedActive.state !== 'active'
    || preparedActive.enabledAt !== current.enabledAt
    || JSON.stringify(preparedActive.askReceiptAuthorityProof) !== JSON.stringify(expectedProof)
  ) {
    throw new DeviceIsolationActivationError('设备凭证隔离 marker ACTIVE 预编码无效');
  }
  writeSecureHostFileSync(
    path,
    prepared.activeRaw,
    MAX_MARKER_BYTES,
  );
  const verified = readSecureHostFileSync(path, MAX_MARKER_BYTES);
  if (
    verified === null
    || verified !== prepared.activeRaw
    || !deviceCredentialIsolationMarkerEnablesAskReceiptAuthority(parseDeviceIsolationMarker(verified))
  ) {
    throw new DeviceIsolationActivationError('设备凭证隔离 marker ACTIVE 复验失败');
  }
  return { path, state: 'active' };
}

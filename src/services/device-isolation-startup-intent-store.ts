import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DEVICE_AUTHORITY_DIRECTORY } from '../platform/device-paths.js';
import { withSecureHostParentSync } from '../platform/secure-host-file.js';
import { readLinuxBootIdentity, readProcessStartIdentity } from '../utils/process-identity.js';

const STARTUP_INTENT_DIRECTORY = 'daemon-startup-intents';
const STARTUP_INTENT_VERSION = 1 as const;

export interface DeviceIsolationStartupIntent {
  version: typeof STARTUP_INTENT_VERSION;
  larkAppId: string;
  bootInstanceId: string;
  pid: number;
  processStartIdentity: string;
  publishedAt: string;
  bootIdentity?: string;
  phase?: 'reserved' | 'starting';
  rosterRevision?: string;
  reservationTokenSha256?: string;
  childPid?: number;
  childProcessStartIdentity?: string;
}

export interface DeviceIsolationStartupIntentOptions {
  homeDir?: string;
  now?: () => Date;
}

export class DeviceIsolationStartupIntentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceIsolationStartupIntentError';
  }
}

function deviceAuthorityLeaf(homeDir: string): string {
  return join(homeDir, '.botmux', DEVICE_AUTHORITY_DIRECTORY, '.authority');
}

function parseIntent(raw: string): DeviceIsolationStartupIntent | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      value.version !== STARTUP_INTENT_VERSION
      || typeof value.larkAppId !== 'string'
      || !value.larkAppId
      || typeof value.bootInstanceId !== 'string'
      || !value.bootInstanceId
      || typeof value.pid !== 'number'
      || !Number.isSafeInteger(value.pid)
      || value.pid <= 1
      || typeof value.processStartIdentity !== 'string'
      || !value.processStartIdentity
      || typeof value.publishedAt !== 'string'
      || new Date(value.publishedAt).toISOString() !== value.publishedAt
      || (value.bootIdentity !== undefined && (typeof value.bootIdentity !== 'string' || !value.bootIdentity))
      || (value.phase !== undefined && value.phase !== 'reserved' && value.phase !== 'starting')
      || (value.rosterRevision !== undefined && (typeof value.rosterRevision !== 'string' || !/^[a-f0-9]{64}$/.test(value.rosterRevision)))
      || (value.reservationTokenSha256 !== undefined && (typeof value.reservationTokenSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.reservationTokenSha256)))
      || ((value.childPid === undefined) !== (value.childProcessStartIdentity === undefined))
      || (value.childPid !== undefined && (!Number.isSafeInteger(value.childPid) || (value.childPid as number) <= 1))
      || (value.childProcessStartIdentity !== undefined && (typeof value.childProcessStartIdentity !== 'string' || !value.childProcessStartIdentity))
    ) return null;
    return {
      version: STARTUP_INTENT_VERSION,
      larkAppId: value.larkAppId,
      bootInstanceId: value.bootInstanceId,
      pid: value.pid,
      processStartIdentity: value.processStartIdentity,
      publishedAt: value.publishedAt,
      ...(typeof value.bootIdentity === 'string' ? { bootIdentity: value.bootIdentity } : {}),
      ...(value.phase === 'reserved' || value.phase === 'starting' ? { phase: value.phase } : {}),
      ...(typeof value.rosterRevision === 'string' ? { rosterRevision: value.rosterRevision } : {}),
      ...(typeof value.reservationTokenSha256 === 'string'
        ? { reservationTokenSha256: value.reservationTokenSha256 }
        : {}),
      ...(typeof value.childPid === 'number' ? { childPid: value.childPid } : {}),
      ...(typeof value.childProcessStartIdentity === 'string'
        ? { childProcessStartIdentity: value.childProcessStartIdentity }
        : {}),
    };
  } catch {
    return null;
  }
}

function intentFileName(intentId: string): string {
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(intentId)) {
    throw new DeviceIsolationStartupIntentError('invalid startup intent id');
  }
  return `${intentId}.json`;
}

function liveIntent(intent: DeviceIsolationStartupIntent): boolean {
  if (intent.bootIdentity) {
    const currentBoot = readLinuxBootIdentity();
    if (currentBoot !== undefined && currentBoot !== intent.bootIdentity) return false;
  }
  if (intent.childPid !== undefined && intent.childProcessStartIdentity !== undefined) {
    return readProcessStartIdentity(intent.childPid) === intent.childProcessStartIdentity;
  }
  return readProcessStartIdentity(intent.pid) === intent.processStartIdentity;
}

function startupIntentLeaf(homeDir: string): string {
  return deviceAuthorityLeaf(homeDir);
}

export function publishDeviceIsolationStartupIntent(input: {
  intentId?: string;
  larkAppId: string;
  bootInstanceId: string;
} & DeviceIsolationStartupIntentOptions): DeviceIsolationStartupIntent & { intentId: string } {
  const home = input.homeDir ?? homedir();
  const processStartIdentity = readProcessStartIdentity(process.pid);
  if (!processStartIdentity) {
    throw new DeviceIsolationStartupIntentError('cannot publish startup intent without process identity');
  }
  const intentId = input.intentId ?? randomBytes(12).toString('hex');
  const publishedAt = (input.now ?? (() => new Date()))().toISOString();
  const intent: DeviceIsolationStartupIntent = {
    version: STARTUP_INTENT_VERSION,
    larkAppId: input.larkAppId,
    bootInstanceId: input.bootInstanceId,
    pid: process.pid,
    processStartIdentity,
    publishedAt,
    ...(readLinuxBootIdentity() ? { bootIdentity: readLinuxBootIdentity() } : {}),
    phase: 'starting',
  };
  withSecureHostParentSync(startupIntentLeaf(home), (parent) => parent.withChildDirectory(
    STARTUP_INTENT_DIRECTORY,
    (dir) => dir.withNamedLeafLock(intentFileName(intentId), () => {
      dir.writeNamedLeaf(intentFileName(intentId), `${JSON.stringify(intent, null, 2)}\n`);
    }),
    { create: true, exactMode: 0o700 },
  ));
  return { intentId, ...intent };
}

function tokenSha256(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function validToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{32,128}$/.test(token);
}

function tokenMatches(intent: DeviceIsolationStartupIntent, token: string): boolean {
  if (!intent.reservationTokenSha256 || !validToken(token)) return false;
  return timingSafeEqual(
    Buffer.from(intent.reservationTokenSha256, 'hex'),
    Buffer.from(tokenSha256(token), 'hex'),
  );
}

/** Parent-side reservation. Call only while holding the host activation gate. */
export function reserveDeviceIsolationDaemonStartup(input: {
  larkAppId: string;
  rosterRevision: string;
} & DeviceIsolationStartupIntentOptions): { intentId: string; reservationToken: string } {
  const home = input.homeDir ?? homedir();
  const processStartIdentity = readProcessStartIdentity(process.pid);
  if (!processStartIdentity || !/^[a-f0-9]{64}$/.test(input.rosterRevision)) {
    throw new DeviceIsolationStartupIntentError('cannot reserve startup without exact process and roster identity');
  }
  const intentId = randomBytes(12).toString('hex');
  const reservationToken = randomBytes(32).toString('base64url');
  const intent: DeviceIsolationStartupIntent = {
    version: STARTUP_INTENT_VERSION,
    phase: 'reserved',
    larkAppId: input.larkAppId,
    bootInstanceId: `reserved-${intentId}`,
    pid: process.pid,
    processStartIdentity,
    publishedAt: (input.now ?? (() => new Date()))().toISOString(),
    rosterRevision: input.rosterRevision,
    reservationTokenSha256: tokenSha256(reservationToken),
    ...(readLinuxBootIdentity() ? { bootIdentity: readLinuxBootIdentity() } : {}),
  };
  withSecureHostParentSync(startupIntentLeaf(home), (parent) => parent.withChildDirectory(
    STARTUP_INTENT_DIRECTORY,
    (dir) => dir.withNamedLeafLock(intentFileName(intentId), () => {
      dir.writeNamedLeaf(intentFileName(intentId), `${JSON.stringify(intent, null, 2)}\n`);
    }),
    { create: true, exactMode: 0o700 },
  ));
  return { intentId, reservationToken };
}

/** Bind the pre-spawn reservation to the exact child birth identity. */
export function bindDeviceIsolationStartupReservationToChild(input: {
  intentId: string;
  reservationToken: string;
  childPid: number;
} & Pick<DeviceIsolationStartupIntentOptions, 'homeDir'>): boolean {
  const home = input.homeDir ?? homedir();
  const childProcessStartIdentity = readProcessStartIdentity(input.childPid);
  if (!childProcessStartIdentity) return false;
  const adopted = withSecureHostParentSync(startupIntentLeaf(home), (parent) => parent.withChildDirectory(
    STARTUP_INTENT_DIRECTORY,
    (dir) => dir.withNamedLeafLock(intentFileName(input.intentId), () => {
      const raw = dir.readNamedLeaf(intentFileName(input.intentId), 16 * 1024);
      const intent = raw ? parseIntent(raw) : null;
      if (!intent || !tokenMatches(intent, input.reservationToken)) return false;
      // The child can win the scheduler race and adopt before the parent binds.
      // Treat that exact child identity as an already-completed bind.
      if (intent.phase === 'starting') {
        return intent.pid === input.childPid
          && intent.processStartIdentity === childProcessStartIdentity;
      }
      if (intent.phase !== 'reserved') return false;
      dir.writeNamedLeaf(intentFileName(input.intentId), `${JSON.stringify({
        ...intent,
        childPid: input.childPid,
        childProcessStartIdentity,
      }, null, 2)}\n`);
      return true;
    }),
    { create: true, exactMode: 0o700 },
  )) ?? false;
  return adopted;
}

/** Child-side takeover. Call only while holding the host activation gate. */
export function adoptDeviceIsolationStartupReservation(input: {
  intentId: string;
  reservationToken: string;
  larkAppId: string;
  bootInstanceId: string;
  rosterRevision: string;
} & DeviceIsolationStartupIntentOptions): DeviceIsolationStartupIntent & { intentId: string } {
  const home = input.homeDir ?? homedir();
  const processStartIdentity = readProcessStartIdentity(process.pid);
  if (!processStartIdentity) throw new DeviceIsolationStartupIntentError('cannot adopt startup without process identity');
  const adopted = withSecureHostParentSync(startupIntentLeaf(home), (parent) => parent.withChildDirectory(
    STARTUP_INTENT_DIRECTORY,
    (dir) => dir.withNamedLeafLock(intentFileName(input.intentId), () => {
      const raw = dir.readNamedLeaf(intentFileName(input.intentId), 16 * 1024);
      const intent = raw ? parseIntent(raw) : null;
      if (
        !intent
        || intent.phase !== 'reserved'
        || intent.larkAppId !== input.larkAppId
        || intent.rosterRevision !== input.rosterRevision
        || !tokenMatches(intent, input.reservationToken)
        || (intent.childPid !== undefined && (
          intent.childPid !== process.pid
          || intent.childProcessStartIdentity !== processStartIdentity
        ))
      ) throw new DeviceIsolationStartupIntentError('startup reservation identity mismatch');
      const adopted: DeviceIsolationStartupIntent = {
        version: STARTUP_INTENT_VERSION,
        phase: 'starting',
        larkAppId: input.larkAppId,
        bootInstanceId: input.bootInstanceId,
        pid: process.pid,
        processStartIdentity,
        publishedAt: (input.now ?? (() => new Date()))().toISOString(),
        rosterRevision: input.rosterRevision,
        reservationTokenSha256: intent.reservationTokenSha256,
        ...(readLinuxBootIdentity() ? { bootIdentity: readLinuxBootIdentity() } : {}),
      };
      dir.writeNamedLeaf(intentFileName(input.intentId), `${JSON.stringify(adopted, null, 2)}\n`);
      return { intentId: input.intentId, ...adopted };
    }),
    { create: true, exactMode: 0o700 },
  ));
  if (!adopted) throw new DeviceIsolationStartupIntentError('startup reservation directory unavailable');
  return adopted;
}

export function clearDeviceIsolationStartupIntent(input: {
  intentId: string;
  processIdentity?: { pid: number; processStartIdentity: string };
  reservationToken?: string;
} & Pick<DeviceIsolationStartupIntentOptions, 'homeDir'>): boolean {
  const home = input.homeDir ?? homedir();
  return withSecureHostParentSync(startupIntentLeaf(home), (parent) => parent.withChildDirectory(
    STARTUP_INTENT_DIRECTORY,
    (dir) => dir.withNamedLeafLock(intentFileName(input.intentId), () => {
      const raw = dir.readNamedLeaf(intentFileName(input.intentId), 16 * 1024);
      const intent = raw ? parseIntent(raw) : null;
      if (!intent) return dir.unlinkNamedRegularFile(intentFileName(input.intentId));
      if (input.processIdentity) {
        if (
          intent.pid !== input.processIdentity.pid
          || intent.processStartIdentity !== input.processIdentity.processStartIdentity
        ) return false;
      }
      if (input.reservationToken !== undefined && !tokenMatches(intent, input.reservationToken)) return false;
      return dir.unlinkNamedLeaf(intentFileName(input.intentId), 16 * 1024);
    }),
    { create: true, exactMode: 0o700 },
  ) ?? false);
}

export function listBlockingDeviceIsolationStartupIntents(
  options: Pick<DeviceIsolationStartupIntentOptions, 'homeDir'> = {},
): Array<DeviceIsolationStartupIntent & { intentId: string }> {
  const home = options.homeDir ?? homedir();
  const blocking: Array<DeviceIsolationStartupIntent & { intentId: string }> = [];
  withSecureHostParentSync(startupIntentLeaf(home), (parent) => parent.withChildDirectory(
    STARTUP_INTENT_DIRECTORY,
    (dir) => {
      for (const name of dir.listLeafNames()) {
        if (!name.endsWith('.json')) continue;
        const intentId = name.slice(0, -'.json'.length);
        const raw = dir.readNamedLeaf(name, 16 * 1024);
        const intent = raw ? parseIntent(raw) : null;
        if (!intent) {
          dir.unlinkNamedRegularFile(name);
          continue;
        }
        if (!liveIntent(intent)) {
          dir.unlinkNamedLeaf(name, 16 * 1024);
          continue;
        }
        blocking.push({ intentId, ...intent });
      }
    },
    { create: true, exactMode: 0o700 },
  ));
  return blocking.sort((left, right) => left.intentId.localeCompare(right.intentId));
}

/** Authoritative, secret-free fingerprint of the bot fleet that should run. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseBotConfigsFromText } from '../bot-registry.js';
import { resolveBotsConfigFile, resolveCanonicalBotsConfigTarget } from '../core/config-dir.js';

const SAFE_APP_ID = /^[A-Za-z0-9._-]+$/;

export class DeviceIsolationRosterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceIsolationRosterError';
  }
}

export interface DeviceIsolationRosterSnapshot {
  /** Configured authority leaf. May be a symlink and must be retained for locking. */
  requestedConfigPath: string;
  /** Canonical regular-file target whose bytes were read. */
  configPath: string;
  members: Array<{ index: number; larkAppId: string; name?: string }>;
  appIds: string[];
  rawSha256: string;
  configSha256: string;
  rosterSha256: string;
  revision: string;
}

export interface DeviceIsolationRosterOptions {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  allowMissingDefault?: boolean;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function exactManagedMarker(value: unknown, appId: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  return marker.appId === appId && typeof marker.jobId === 'string' && marker.jobId.length > 0;
}

function shouldStart(entry: Record<string, unknown>, index: number): boolean {
  const appId = entry.larkAppId as string;
  if (entry.activationPending !== undefined && typeof entry.activationPending !== 'boolean') {
    throw new DeviceIsolationRosterError(`Bot config [${index}] has invalid activationPending`);
  }
  const deactivating = entry.activationDeactivating;
  const starting = entry.activationStarting;
  const committed = entry.activationCommitted;
  if (starting !== undefined && committed !== undefined) {
    throw new DeviceIsolationRosterError(`Bot config [${index}] has conflicting managed activation markers`);
  }
  for (const [name, marker] of [
    ['activationDeactivating', deactivating],
    ['activationStarting', starting],
    ['activationCommitted', committed],
  ] as const) {
    if (marker !== undefined && !exactManagedMarker(marker, appId)) {
      throw new DeviceIsolationRosterError(`Bot config [${index}] has invalid ${name}`);
    }
  }
  if (deactivating !== undefined && (starting !== undefined || committed !== undefined)) {
    throw new DeviceIsolationRosterError(`Bot config [${index}] has conflicting activation state`);
  }
  if (entry.activationPending === true && (starting !== undefined || committed !== undefined)) {
    throw new DeviceIsolationRosterError(`Bot config [${index}] is pending and starting`);
  }
  return entry.activationPending !== true && deactivating === undefined;
}

/**
 * Read the exact file the daemon loader would use. Any malformed/unsafe row,
 * duplicate App ID, or unreadable explicit authority is a hard failure.
 */
export function readDeviceIsolationRosterSnapshot(
  options: DeviceIsolationRosterOptions = {},
): DeviceIsolationRosterSnapshot {
  const env = options.env ?? process.env;
  const implied = options.configPath
    ? resolve(options.configPath)
    : resolveBotsConfigFile({ env, homeDir: options.homeDir });
  let requestedExists = true;
  try { lstatSync(implied); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') requestedExists = false;
    else {
      throw new DeviceIsolationRosterError(
        `cannot inspect bots config: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (!requestedExists) {
    const explicit = !!options.configPath || !!env.BOTS_CONFIG?.trim();
    if (!explicit && options.allowMissingDefault === true) {
      const appIds: string[] = [];
      const rosterSha256 = sha256(JSON.stringify(appIds));
      const configSha256 = sha256('[]');
      const rawSha256 = sha256('');
      return {
        requestedConfigPath: implied, configPath: implied, members: [], appIds,
        rawSha256, configSha256, rosterSha256,
        revision: sha256(`botmux-roster-v1\0${implied}\0${rawSha256}\0${configSha256}\0${rosterSha256}`),
      };
    }
    throw new DeviceIsolationRosterError(`bots config file not found: ${implied}`);
  }
  let configPath: string;
  let raw: string;
  try {
    configPath = resolveCanonicalBotsConfigTarget(implied).targetPath;
    raw = readFileSync(configPath, 'utf8');
  } catch (error) {
    throw new DeviceIsolationRosterError(`cannot read bots config: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new DeviceIsolationRosterError(`invalid JSON in bots config: ${configPath}`); }
  if (!Array.isArray(parsed)) {
    throw new DeviceIsolationRosterError(`bots config must contain a JSON array: ${configPath}`);
  }
  // Reuse the daemon's full parser first. It deliberately skips lifecycle-held
  // rows after validating their identity/secret; active rows are fully parsed.
  try { parseBotConfigsFromText(raw); }
  catch (error) {
    throw new DeviceIsolationRosterError(error instanceof Error ? error.message : String(error));
  }
  const seen = new Set<string>();
  const appIds: string[] = [];
  const members: DeviceIsolationRosterSnapshot['members'] = [];
  for (let index = 0; index < parsed.length; index += 1) {
    const value = parsed[index];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new DeviceIsolationRosterError(`Bot config [${index}] must be an object`);
    }
    const entry = value as Record<string, unknown>;
    const appId = entry.larkAppId;
    if (typeof appId !== 'string' || !appId || !SAFE_APP_ID.test(appId) || /^\.+$/.test(appId)) {
      throw new DeviceIsolationRosterError(`Bot config [${index}] has unsafe larkAppId`);
    }
    if (seen.has(appId)) throw new DeviceIsolationRosterError(`duplicate larkAppId: ${appId}`);
    seen.add(appId);
    // Validate every raw row, including lifecycle-held rows that the ordinary
    // fleet parser intentionally filters. Corrupt pending config must not make
    // the authoritative roster silently partial.
    const daemonEntry = { ...entry };
    delete daemonEntry.activationPending;
    delete daemonEntry.activationDeactivating;
    delete daemonEntry.activationStarting;
    delete daemonEntry.activationCommitted;
    try {
      if (parseBotConfigsFromText(JSON.stringify([daemonEntry])).length !== 1) throw new Error('not startable');
    } catch (error) {
      throw new DeviceIsolationRosterError(`Bot config [${index}] is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (shouldStart(entry, index)) {
      appIds.push(appId);
      members.push({
        index,
        larkAppId: appId,
        ...(typeof entry.name === 'string' && entry.name.trim() ? { name: entry.name.trim() } : {}),
      });
    }
  }
  appIds.sort((left, right) => left.localeCompare(right));
  const rawSha256 = sha256(raw);
  const configSha256 = sha256(canonicalJson(parsed));
  const rosterSha256 = sha256(JSON.stringify(appIds));
  return {
    requestedConfigPath: implied, configPath, members, appIds, rawSha256, configSha256, rosterSha256,
    revision: sha256(`botmux-roster-v1\0${configPath}\0${rawSha256}\0${configSha256}\0${rosterSha256}`),
  };
}

export function sameDeviceIsolationRoster(
  left: DeviceIsolationRosterSnapshot,
  right: DeviceIsolationRosterSnapshot,
): boolean {
  return left.configPath === right.configPath
    && left.rawSha256 === right.rawSha256
    && left.configSha256 === right.configSha256
    && left.rosterSha256 === right.rosterSha256
    && left.revision === right.revision
    && left.appIds.length === right.appIds.length
    && left.appIds.every((appId, index) => appId === right.appIds[index]);
}

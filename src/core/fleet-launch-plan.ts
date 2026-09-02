import { isAbsolute, resolve } from 'node:path';
import { botProcessName } from '../setup/bot-config-editor.js';
import type { DeviceIsolationRosterSnapshot } from '../services/device-isolation-roster.js';

export const FLEET_LAUNCH_PLAN_ENV = 'BOTMUX_FLEET_LAUNCH_PLAN_V1';
export const FLEET_LAUNCH_PLAN_VERSION = 1 as const;

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_APP_ID = /^[A-Za-z0-9._-]+$/;
const MAX_ENCODED_PLAN_BYTES = 1024 * 1024;

export interface FleetLaunchPlanBot {
  readonly name: string;
  readonly appId: string;
  readonly botIndex: number;
}

/** Secret-free, exact authority for one full-fleet supervisor generation. */
export interface FleetLaunchPlan {
  readonly version: typeof FLEET_LAUNCH_PLAN_VERSION;
  /** Configured authority leaf. This may intentionally be a symlink alias. */
  readonly requestedConfigPath: string;
  /** Canonical regular-file target locked while this plan was captured. */
  readonly canonicalConfigPath: string;
  readonly rosterRevision: string;
  readonly bots: readonly FleetLaunchPlanBot[];
}

export class FleetLaunchPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FleetLaunchPlanError';
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function normalizedAbsolutePath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 16_384
    && !value.includes('\0')
    && isAbsolute(value)
    && resolve(value) === value;
}

function freezePlan(plan: FleetLaunchPlan): FleetLaunchPlan {
  const bots = Object.freeze(plan.bots.map(bot => Object.freeze({ ...bot })));
  return Object.freeze({ ...plan, bots });
}

/** Strict shape/uniqueness validation for both the CLI and detached supervisor. */
export function validateFleetLaunchPlan(value: unknown): FleetLaunchPlan {
  if (!plainRecord(value)
      || !exactKeys(value, ['version', 'requestedConfigPath', 'canonicalConfigPath', 'rosterRevision', 'bots'])) {
    throw new FleetLaunchPlanError('malformed fleet launch plan');
  }
  if (value.version !== FLEET_LAUNCH_PLAN_VERSION
      || !normalizedAbsolutePath(value.requestedConfigPath)
      || !normalizedAbsolutePath(value.canonicalConfigPath)
      || typeof value.rosterRevision !== 'string'
      || !SHA256.test(value.rosterRevision)
      || !Array.isArray(value.bots)) {
    throw new FleetLaunchPlanError('invalid fleet launch plan header');
  }

  const names = new Set<string>();
  const appIds = new Set<string>();
  const indexes = new Set<number>();
  let previousIndex = -1;
  const bots: FleetLaunchPlanBot[] = value.bots.map((raw, position) => {
    if (!plainRecord(raw) || !exactKeys(raw, ['name', 'appId', 'botIndex'])) {
      throw new FleetLaunchPlanError(`malformed fleet launch plan bot at position ${position}`);
    }
    const { name, appId, botIndex } = raw;
    if (typeof name !== 'string' || !name || name.length > 512 || name.includes('\0')
        || typeof appId !== 'string' || !SAFE_APP_ID.test(appId) || /^\.+$/.test(appId)
        || !Number.isSafeInteger(botIndex) || (botIndex as number) < 0) {
      throw new FleetLaunchPlanError(`invalid fleet launch plan bot at position ${position}`);
    }
    const index = botIndex as number;
    if (index <= previousIndex) {
      throw new FleetLaunchPlanError('fleet launch plan bot indexes must be strictly increasing');
    }
    previousIndex = index;
    if (names.has(name) || appIds.has(appId) || indexes.has(index)) {
      throw new FleetLaunchPlanError('duplicate fleet launch plan bot identity');
    }
    names.add(name);
    appIds.add(appId);
    indexes.add(index);
    return { name, appId, botIndex: index };
  });

  return freezePlan({
    version: FLEET_LAUNCH_PLAN_VERSION,
    requestedConfigPath: value.requestedConfigPath,
    canonicalConfigPath: value.canonicalConfigPath,
    rosterRevision: value.rosterRevision,
    bots,
  });
}

/** Build the plan while the caller holds the canonical bots-config lock. */
export function fleetLaunchPlanFromRoster(
  roster: DeviceIsolationRosterSnapshot,
  canonicalConfigPath: string = roster.configPath,
): FleetLaunchPlan {
  return validateFleetLaunchPlan({
    version: FLEET_LAUNCH_PLAN_VERSION,
    requestedConfigPath: resolve(roster.requestedConfigPath),
    canonicalConfigPath: resolve(canonicalConfigPath),
    rosterRevision: roster.revision,
    bots: roster.members.map(member => ({
      name: botProcessName(member, member.index),
      appId: member.larkAppId,
      botIndex: member.index,
    })),
  });
}

/** Prove that a disk snapshot is exactly the generation named by the plan. */
export function assertFleetLaunchPlanMatchesRoster(
  planValue: unknown,
  roster: DeviceIsolationRosterSnapshot,
): FleetLaunchPlan {
  const plan = validateFleetLaunchPlan(planValue);
  const current = fleetLaunchPlanFromRoster(roster);
  if (plan.requestedConfigPath !== current.requestedConfigPath
      || plan.canonicalConfigPath !== current.canonicalConfigPath
      || plan.rosterRevision !== current.rosterRevision
      || plan.bots.length !== current.bots.length
      || plan.bots.some((bot, index) => {
        const candidate = current.bots[index];
        return !candidate
          || bot.name !== candidate.name
          || bot.appId !== candidate.appId
          || bot.botIndex !== candidate.botIndex;
      })) {
    throw new FleetLaunchPlanError('fleet launch plan does not match the configured roster generation');
  }
  return plan;
}

export function encodeFleetLaunchPlan(planValue: unknown): string {
  const plan = validateFleetLaunchPlan(planValue);
  return Buffer.from(JSON.stringify(plan), 'utf8').toString('base64url');
}

export function decodeFleetLaunchPlan(encoded: unknown): FleetLaunchPlan {
  if (typeof encoded !== 'string'
      || !encoded
      || encoded.length > MAX_ENCODED_PLAN_BYTES
      || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new FleetLaunchPlanError('missing or oversized fleet launch plan');
  }
  let parsed: unknown;
  try {
    const raw = Buffer.from(encoded, 'base64url');
    if (raw.length === 0 || raw.length > MAX_ENCODED_PLAN_BYTES) throw new Error('invalid size');
    if (raw.toString('base64url') !== encoded) throw new Error('non-canonical base64url');
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new FleetLaunchPlanError('malformed encoded fleet launch plan');
  }
  return validateFleetLaunchPlan(parsed);
}

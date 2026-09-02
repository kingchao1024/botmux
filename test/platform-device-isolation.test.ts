import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ASK_RECEIPT_AUTHORITY_VERSION,
  completeDeviceCredentialIsolationMarker,
  collectAskReceiptAuthorityLiveSiblings,
  decideAskReceiptAuthorityBootstrap,
  deviceCredentialIsolationMarkerEnablesAskReceiptAuthority,
  deviceCredentialIsolationSupported,
  encodeDeviceCredentialIsolationMarker,
  ensureDeviceCredentialIsolationMarker,
  MAX_BOOT_INSTANCE_ID_BYTES,
  MAX_LARK_APP_ID_BYTES,
  MAX_MARKER_BYTES,
  MAX_PARTICIPANTS,
  MAX_PROC_START_BYTES,
  readDeviceCredentialIsolationMarker,
  verifyAskReceiptAuthorityActivationRoster,
} from '../src/platform/device-isolation.js';

const roots: string[] = [];
function tempHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'botmux-device-isolation-'));
  roots.push(root);
  return root;
}

function receiptAuthorityProof(overrides: Partial<{
  activationEpoch: string;
  participants: Array<{
    larkAppId: string;
    bootInstanceId: string;
    pid: number;
    procStart: string;
  }>;
}> = {}) {
  return {
    activationEpoch: overrides.activationEpoch ?? 'a'.repeat(43),
    protocolVersion: 1 as const,
    participants: overrides.participants ?? [{
      larkAppId: 'cli_test',
      bootInstanceId: 'boot-1',
      pid: 321,
      procStart: 'proc-321',
    }],
  };
}

function activeReceiptAuthorityMarker() {
  return {
    version: 1 as const,
    state: 'active' as const,
    enabledAt: '2030-01-02T03:04:05.000Z',
    activatedAt: '2030-01-02T03:04:06.000Z',
    askReceiptAuthorityVersion: ASK_RECEIPT_AUTHORITY_VERSION,
    askReceiptAuthorityProof: receiptAuthorityProof(),
  };
}

function liveReceiptAuthoritySibling(overrides: Partial<{
  larkAppId: string;
  bootInstanceId: string;
  pid: number;
  processStartIdentity: string;
}> = {}) {
  return {
    larkAppId: overrides.larkAppId ?? 'cli_a',
    bootInstanceId: overrides.bootInstanceId ?? 'boot-a',
    pid: overrides.pid ?? 101,
    processStartIdentity: overrides.processStartIdentity ?? 'proc-a',
    rosterRevision: 'a'.repeat(64),
    receiptAuthorityProtocolVersion: 1,
    receiptAuthorityActivationEpoch: 'a'.repeat(43),
  };
}

function maximalParticipants(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const suffix = String(index).padStart(3, '0');
    return {
      larkAppId: `cli_${suffix}${'a'.repeat(125)}`,
      bootInstanceId: `boot${suffix}${'b'.repeat(121)}`,
      pid: 10_000 + index,
      // Backslashes take two bytes in JSON, exercising the worst-case escaped
      // representation allowed by the printable-ASCII procStart contract.
      procStart: `${suffix}${'\\'.repeat(253)}`,
    };
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('device credential isolation activation', () => {
  it('writes a durable one-way marker and leaves it in place on repeat', () => {
    const homeDir = tempHome();
    const first = ensureDeviceCredentialIsolationMarker({
      homeDir,
      now: () => new Date('2030-01-02T03:04:05.000Z'),
    });
    expect(first.created).toBe(true);
    expect(first.state).toBe('pending');
    if (process.platform !== 'win32') expect(lstatSync(first.path).mode & 0o777).toBe(0o600);
    expect(ensureDeviceCredentialIsolationMarker({ homeDir })).toMatchObject({
      created: false,
      state: 'pending',
    });
    completeDeviceCredentialIsolationMarker({
      homeDir,
      now: () => new Date('2030-01-02T03:04:06.000Z'),
      receiptAuthorityProof: receiptAuthorityProof(),
    });
    expect(readDeviceCredentialIsolationMarker({ homeDir })).toMatchObject({
      state: 'active',
      enabledAt: '2030-01-02T03:04:05.000Z',
      activatedAt: '2030-01-02T03:04:06.000Z',
      askReceiptAuthorityVersion: ASK_RECEIPT_AUTHORITY_VERSION,
      askReceiptAuthorityProof: receiptAuthorityProof(),
    });
    expect(ensureDeviceCredentialIsolationMarker({ homeDir }).state).toBe('active');
  });

  it('rejects unsupported hosts without probing a local mechanism', () => {
    expect(deviceCredentialIsolationSupported('win32')).toBe(false);
    expect(deviceCredentialIsolationSupported('freebsd')).toBe(false);
  });

  it('treats a legacy active marker without the receipt epoch as incomplete and re-pends it only during explicit activation', () => {
    const homeDir = tempHome();
    const first = ensureDeviceCredentialIsolationMarker({
      homeDir,
      now: () => new Date('2030-01-02T03:04:05.000Z'),
    });
    completeDeviceCredentialIsolationMarker({
      homeDir,
      now: () => new Date('2030-01-02T03:04:06.000Z'),
      receiptAuthorityProof: receiptAuthorityProof(),
    });
    const legacyActive = JSON.stringify({
      version: 1,
      state: 'active',
      enabledAt: '2030-01-02T03:04:05.000Z',
      activatedAt: '2030-01-02T03:04:06.000Z',
    }, null, 2);
    // simulate an older active marker written before the receipt epoch existed
    const path = first.path;
    writeFileSync(path, `${legacyActive}\n`, { mode: 0o600 });

    const marker = readDeviceCredentialIsolationMarker({ homeDir });
    expect(marker?.state).toBe('active');
    expect(deviceCredentialIsolationMarkerEnablesAskReceiptAuthority(marker)).toBe(false);
    expect(ensureDeviceCredentialIsolationMarker({ homeDir }).state).toBe('pending');
    expect(readDeviceCredentialIsolationMarker({ homeDir })?.state).toBe('pending');
  });

  it.each([20, 100, MAX_PARTICIPANTS])(
    'round-trips a %i-participant ACTIVE marker under the shared byte contract',
    (participantCount) => {
      const homeDir = tempHome();
      const pending = ensureDeviceCredentialIsolationMarker({
        homeDir,
        now: () => new Date('2030-01-02T03:04:05.000Z'),
      });
      completeDeviceCredentialIsolationMarker({
        homeDir,
        now: () => new Date('2030-01-02T03:04:06.000Z'),
        receiptAuthorityProof: receiptAuthorityProof({
          participants: maximalParticipants(participantCount),
        }),
      });

      const marker = readDeviceCredentialIsolationMarker({ homeDir });
      const raw = readFileSync(pending.path, 'utf8');
      expect(marker?.askReceiptAuthorityProof?.participants).toHaveLength(participantCount);
      expect(raw).toBe(encodeDeviceCredentialIsolationMarker(marker!));
      expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(MAX_MARKER_BYTES);
      expect(Buffer.byteLength(raw, 'utf8')).toBeGreaterThan(4 * 1024);
    },
  );

  it('proves maximum field widths fit while participant and field overflow preserve PENDING', () => {
    const maxParticipants = maximalParticipants(MAX_PARTICIPANTS);
    expect(Buffer.byteLength(maxParticipants[0]!.larkAppId, 'utf8'))
      .toBe(MAX_LARK_APP_ID_BYTES);
    expect(Buffer.byteLength(maxParticipants[0]!.bootInstanceId, 'utf8'))
      .toBe(MAX_BOOT_INSTANCE_ID_BYTES);
    expect(Buffer.byteLength(maxParticipants[0]!.procStart, 'utf8'))
      .toBe(MAX_PROC_START_BYTES);

    const invalidParticipants = [
      maximalParticipants(MAX_PARTICIPANTS + 1),
      [{ ...maxParticipants[0]!, larkAppId: `cli_${'a'.repeat(129)}` }],
      [{ ...maxParticipants[0]!, bootInstanceId: 'b'.repeat(MAX_BOOT_INSTANCE_ID_BYTES + 1) }],
      [{ ...maxParticipants[0]!, procStart: 'p'.repeat(MAX_PROC_START_BYTES + 1) }],
      [maxParticipants[0]!, { ...maxParticipants[1]!, larkAppId: maxParticipants[0]!.larkAppId }],
      [maxParticipants[0]!, { ...maxParticipants[0]! }],
      [maxParticipants[0]!, { ...maxParticipants[0]!, larkAppId: 'cli_distinct_app' }],
    ];

    for (const participants of invalidParticipants) {
      const homeDir = tempHome();
      const pending = ensureDeviceCredentialIsolationMarker({
        homeDir,
        now: () => new Date('2030-01-02T03:04:05.000Z'),
      });
      const pendingRaw = readFileSync(pending.path, 'utf8');
      expect(() => completeDeviceCredentialIsolationMarker({
        homeDir,
        now: () => new Date('2030-01-02T03:04:06.000Z'),
        receiptAuthorityProof: receiptAuthorityProof({ participants }),
      })).toThrow();
      expect(readFileSync(pending.path, 'utf8')).toBe(pendingRaw);
      expect(readDeviceCredentialIsolationMarker({ homeDir })?.state).toBe('pending');
    }
  });

  it('accepts a marker at the byte cap and rejects cap plus one', () => {
    const homeDir = tempHome();
    const pending = ensureDeviceCredentialIsolationMarker({ homeDir });
    const raw = readFileSync(pending.path, 'utf8');
    const atCap = raw + ' '.repeat(MAX_MARKER_BYTES - Buffer.byteLength(raw, 'utf8'));
    expect(Buffer.byteLength(atCap, 'utf8')).toBe(MAX_MARKER_BYTES);
    writeFileSync(pending.path, atCap, { mode: 0o600 });
    expect(readDeviceCredentialIsolationMarker({ homeDir })?.state).toBe('pending');

    writeFileSync(pending.path, `${atCap} `, { mode: 0o600 });
    expect(() => readDeviceCredentialIsolationMarker({ homeDir })).toThrow(/大小异常/);
  });
});

describe('ask receipt authority bootstrap decision', () => {
  it('accepts distinct Apps backed by distinct live process generations', () => {
    expect(verifyAskReceiptAuthorityActivationRoster({
      marker: activeReceiptAuthorityMarker(),
      liveSiblings: [
        liveReceiptAuthoritySibling(),
        liveReceiptAuthoritySibling({
          larkAppId: 'cli_b',
          bootInstanceId: 'boot-b',
          pid: 202,
          processStartIdentity: 'proc-b',
        }),
      ],
    })).toBe(true);
  });

  it('rejects different Apps that claim the same live process generation', () => {
    expect(verifyAskReceiptAuthorityActivationRoster({
      marker: activeReceiptAuthorityMarker(),
      liveSiblings: [
        liveReceiptAuthoritySibling(),
        liveReceiptAuthoritySibling({ larkAppId: 'cli_b' }),
      ],
    })).toBe(false);
  });

  it('rejects a duplicate App even when its live process generation differs', () => {
    expect(verifyAskReceiptAuthorityActivationRoster({
      marker: activeReceiptAuthorityMarker(),
      liveSiblings: [
        liveReceiptAuthoritySibling(),
        liveReceiptAuthoritySibling({
          bootInstanceId: 'boot-b',
          pid: 202,
          processStartIdentity: 'proc-b',
        }),
      ],
    })).toBe(false);
  });

  it('excludes only exact self and keeps a distinct same-App predecessor fail-closed', () => {
    const self = {
      larkAppId: 'cli_same', bootInstanceId: 'boot-new', pid: 200,
      processStartIdentity: 'proc-new',
      rosterRevision: 'a'.repeat(64),
    };
    const invalid = collectAskReceiptAuthorityLiveSiblings({
      self, receiptAuthorityProtocolVersion: 1,
      receiptAuthorityActivationEpoch: 'a'.repeat(43),
      discoveredDaemons: [
        { ...self, receiptAuthorityProtocolVersion: 1, receiptAuthorityActivationEpoch: 'a'.repeat(43) },
        {
          larkAppId: 'cli_same', bootInstanceId: 'boot-old', pid: 100,
          processStartIdentity: 'proc-old', rosterRevision: 'a'.repeat(64),
        },
      ],
    });
    expect(invalid.liveSiblings).toEqual([expect.objectContaining({ bootInstanceId: 'boot-new' })]);
    expect(invalid.protocolCompatible).toBe(false);

    const compatible = collectAskReceiptAuthorityLiveSiblings({
      self, receiptAuthorityProtocolVersion: 1,
      receiptAuthorityActivationEpoch: 'a'.repeat(43),
      discoveredDaemons: [
        { ...self, receiptAuthorityProtocolVersion: 1, receiptAuthorityActivationEpoch: 'a'.repeat(43) },
        {
          larkAppId: 'cli_same', bootInstanceId: 'boot-old', pid: 100,
          processStartIdentity: 'proc-old', rosterRevision: 'a'.repeat(64),
          receiptAuthorityProtocolVersion: 1,
          receiptAuthorityActivationEpoch: 'a'.repeat(43),
        },
      ],
    });
    expect(compatible.protocolCompatible).toBe(true);
    expect(compatible.liveSiblings.map(item => item.bootInstanceId)).toEqual(['boot-new', 'boot-old']);
  });

  it('fails closed for missing, invalid, pending, incomplete, blocked, and unisolated states', () => {
    expect(decideAskReceiptAuthorityBootstrap({
      marker: null,
      inventory: { blockers: [], entries: [] },
    })).toEqual({ enabled: false, reason: 'marker_missing' });
    expect(decideAskReceiptAuthorityBootstrap({
      marker: 'invalid',
      inventory: { blockers: [], entries: [] },
    })).toEqual({ enabled: false, reason: 'marker_invalid' });
    expect(decideAskReceiptAuthorityBootstrap({
      marker: {
        version: 1,
        state: 'pending',
        enabledAt: '2030-01-02T03:04:05.000Z',
      },
      inventory: { blockers: [], entries: [] },
    })).toEqual({ enabled: false, reason: 'marker_pending' });
    expect(decideAskReceiptAuthorityBootstrap({
      marker: {
        version: 1,
        state: 'active',
        enabledAt: '2030-01-02T03:04:05.000Z',
        activatedAt: '2030-01-02T03:04:06.000Z',
      },
      inventory: { blockers: [], entries: [] },
    })).toEqual({ enabled: false, reason: 'marker_incomplete' });
    expect(decideAskReceiptAuthorityBootstrap({
      marker: {
        version: 1,
        state: 'active',
        enabledAt: '2030-01-02T03:04:05.000Z',
        activatedAt: '2030-01-02T03:04:06.000Z',
        askReceiptAuthorityVersion: ASK_RECEIPT_AUTHORITY_VERSION,
        askReceiptAuthorityProof: receiptAuthorityProof(),
      },
      liveSiblings: [],
      inventory: { blockers: [], entries: [] },
    })).toEqual({ enabled: false, reason: 'marker_roster_mismatch' });
    expect(decideAskReceiptAuthorityBootstrap({
      marker: {
        version: 1,
        state: 'active',
        enabledAt: '2030-01-02T03:04:05.000Z',
        activatedAt: '2030-01-02T03:04:06.000Z',
        askReceiptAuthorityVersion: ASK_RECEIPT_AUTHORITY_VERSION,
        askReceiptAuthorityProof: receiptAuthorityProof(),
      },
      liveSiblings: [{
        larkAppId: 'cli_test',
        bootInstanceId: 'boot-1',
        pid: 321,
        processStartIdentity: 'proc-321',
        rosterRevision: 'a'.repeat(64),
        receiptAuthorityProtocolVersion: 1,
        receiptAuthorityActivationEpoch: 'a'.repeat(43),
      }],
      liveSiblingProtocolCompatible: false,
      inventory: { blockers: [], entries: [] },
    })).toEqual({ enabled: false, reason: 'marker_roster_mismatch' });
    expect(decideAskReceiptAuthorityBootstrap({
      marker: {
        version: 1,
        state: 'active',
        enabledAt: '2030-01-02T03:04:05.000Z',
        activatedAt: '2030-01-02T03:04:06.000Z',
        askReceiptAuthorityVersion: ASK_RECEIPT_AUTHORITY_VERSION,
        askReceiptAuthorityProof: receiptAuthorityProof(),
      },
      inventory: { blockers: [{ sessionId: 's1' }], entries: [] },
    })).toEqual({ enabled: false, reason: 'inventory_blocked' });
    expect(decideAskReceiptAuthorityBootstrap({
      marker: {
        version: 1,
        state: 'active',
        enabledAt: '2030-01-02T03:04:05.000Z',
        activatedAt: '2030-01-02T03:04:06.000Z',
        askReceiptAuthorityVersion: ASK_RECEIPT_AUTHORITY_VERSION,
        askReceiptAuthorityProof: receiptAuthorityProof(),
      },
      inventory: {
        blockers: [],
        entries: [{ disposition: 'owned_local', credentialIsolated: false }],
      },
    })).toEqual({ enabled: false, reason: 'local_session_unisolated' });
  });

  it('enables bootstrap only for current shared active marker and clean isolated inventory', () => {
    expect(decideAskReceiptAuthorityBootstrap({
      marker: {
        version: 1,
        state: 'active',
        enabledAt: '2030-01-02T03:04:05.000Z',
        activatedAt: '2030-01-02T03:04:06.000Z',
        askReceiptAuthorityVersion: ASK_RECEIPT_AUTHORITY_VERSION,
        askReceiptAuthorityProof: receiptAuthorityProof(),
      },
      liveSiblings: [{
        larkAppId: 'cli_test',
        bootInstanceId: 'boot-1',
        pid: 321,
        processStartIdentity: 'proc-321',
        rosterRevision: 'a'.repeat(64),
        receiptAuthorityProtocolVersion: 1,
        receiptAuthorityActivationEpoch: 'a'.repeat(43),
      }],
      inventory: {
        blockers: [],
        entries: [
          { disposition: 'quiescent' },
          { disposition: 'safe_remote' },
          { disposition: 'owned_local', credentialIsolated: true },
        ],
      },
    })).toEqual({ enabled: true });
  });

  it('fails closed when the active marker omits or forges its receipt proof', () => {
    expect(deviceCredentialIsolationMarkerEnablesAskReceiptAuthority({
      version: 1,
      state: 'active',
      enabledAt: '2030-01-02T03:04:05.000Z',
      activatedAt: '2030-01-02T03:04:06.000Z',
      askReceiptAuthorityVersion: ASK_RECEIPT_AUTHORITY_VERSION,
    })).toBe(false);

    expect(deviceCredentialIsolationMarkerEnablesAskReceiptAuthority({
      version: 1,
      state: 'active',
      enabledAt: '2030-01-02T03:04:05.000Z',
      activatedAt: '2030-01-02T03:04:06.000Z',
      askReceiptAuthorityVersion: ASK_RECEIPT_AUTHORITY_VERSION,
      askReceiptAuthorityProof: receiptAuthorityProof({ activationEpoch: 'short' }),
    })).toBe(false);
  });

  it('accepts legitimate restart liveness while still rejecting empty or forged current live sibling sets', () => {
    const marker = {
      version: 1 as const,
      state: 'active' as const,
      enabledAt: '2030-01-02T03:04:05.000Z',
      activatedAt: '2030-01-02T03:04:06.000Z',
      askReceiptAuthorityVersion: ASK_RECEIPT_AUTHORITY_VERSION,
      askReceiptAuthorityProof: receiptAuthorityProof({
        participants: [
          {
            larkAppId: 'cli_b',
            bootInstanceId: 'boot-b-activation',
            pid: 222,
            procStart: 'proc-b-activation',
          },
          {
            larkAppId: 'cli_a',
            bootInstanceId: 'boot-a-activation',
            pid: 111,
            procStart: 'proc-a-activation',
          },
        ],
      }),
    };

    expect(verifyAskReceiptAuthorityActivationRoster({
      marker,
      liveSiblings: [
        {
          larkAppId: 'cli_a',
          bootInstanceId: 'boot-a-restart-1',
          pid: 311,
          processStartIdentity: 'proc-a-restart-1',
          rosterRevision: 'a'.repeat(64),
          receiptAuthorityProtocolVersion: 1,
          receiptAuthorityActivationEpoch: 'a'.repeat(43),
        },
        {
          larkAppId: 'cli_b',
          bootInstanceId: 'boot-b-restart-1',
          pid: 322,
          processStartIdentity: 'proc-b-restart-1',
          rosterRevision: 'a'.repeat(64),
          receiptAuthorityProtocolVersion: 1,
          receiptAuthorityActivationEpoch: 'a'.repeat(43),
        },
      ],
    })).toBe(true);

    expect(verifyAskReceiptAuthorityActivationRoster({
      marker,
      liveSiblings: [
        {
          larkAppId: 'cli_a',
          bootInstanceId: 'boot-a-restart-2',
          pid: 411,
          processStartIdentity: 'proc-a-restart-2',
          rosterRevision: 'a'.repeat(64),
          receiptAuthorityProtocolVersion: 1,
          receiptAuthorityActivationEpoch: 'a'.repeat(43),
        },
        {
          larkAppId: 'cli_b',
          bootInstanceId: 'boot-b-restart-2',
          pid: 422,
          processStartIdentity: 'proc-b-restart-2',
          rosterRevision: 'a'.repeat(64),
          receiptAuthorityProtocolVersion: 1,
          receiptAuthorityActivationEpoch: 'a'.repeat(43),
        },
      ],
    })).toBe(true);

    expect(verifyAskReceiptAuthorityActivationRoster({
      marker,
      liveSiblings: [],
    })).toBe(false);

    expect(verifyAskReceiptAuthorityActivationRoster({
      marker,
      liveSiblings: [
        {
          larkAppId: 'cli_a',
          bootInstanceId: 'boot-a-restart-1',
          pid: 111,
          processStartIdentity: 'proc-a-restart-1',
          rosterRevision: 'a'.repeat(64),
          receiptAuthorityProtocolVersion: 1,
          receiptAuthorityActivationEpoch: 'a'.repeat(43),
        },
        {
          larkAppId: 'cli_a',
          bootInstanceId: 'boot-a-restart-1',
          pid: 111,
          processStartIdentity: 'proc-a-restart-1',
          rosterRevision: 'a'.repeat(64),
          receiptAuthorityProtocolVersion: 1,
          receiptAuthorityActivationEpoch: 'a'.repeat(43),
        },
      ],
    })).toBe(false);

    expect(verifyAskReceiptAuthorityActivationRoster({
      marker,
      liveSiblings: [
        {
          larkAppId: 'cli_a',
          bootInstanceId: 'boot-a-restart-3',
          pid: 511,
          processStartIdentity: 'proc-a-restart-3',
          rosterRevision: 'a'.repeat(64),
          receiptAuthorityProtocolVersion: 0,
          receiptAuthorityActivationEpoch: 'a'.repeat(43),
        },
        {
          larkAppId: 'cli_b',
          bootInstanceId: 'boot-b-restart-3',
          pid: 522,
          processStartIdentity: 'proc-b-restart-3',
          rosterRevision: 'a'.repeat(64),
          receiptAuthorityProtocolVersion: 1,
          receiptAuthorityActivationEpoch: 'a'.repeat(43),
        },
      ],
    })).toBe(false);

    expect(verifyAskReceiptAuthorityActivationRoster({
      marker,
      liveSiblings: [
        {
          larkAppId: 'cli_a',
          bootInstanceId: 'boot-a-restart-4',
          pid: 611,
          processStartIdentity: 'proc-a-restart-4',
          rosterRevision: 'a'.repeat(64),
          receiptAuthorityProtocolVersion: 1,
          receiptAuthorityActivationEpoch: 'b'.repeat(43),
        },
        {
          larkAppId: 'cli_b',
          bootInstanceId: 'boot-b-restart-4',
          pid: 622,
          processStartIdentity: 'proc-b-restart-4',
          rosterRevision: 'a'.repeat(64),
          receiptAuthorityProtocolVersion: 1,
          receiptAuthorityActivationEpoch: 'a'.repeat(43),
        },
      ],
    })).toBe(false);
  });
});

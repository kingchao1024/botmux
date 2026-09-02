import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectAskReceiptAuthorityLiveSiblings } from '../src/platform/device-isolation.js';
import {
  DaemonDescriptorValidationError,
  cleanupStaleDaemonDescriptorFiles,
  daemonDescriptorFileName,
  findOnlineDaemon,
  listOnlineDaemons,
  parseDaemonIpcPort,
  publishDaemonDescriptor,
  removeDaemonDescriptorPublication,
  resolveDaemonIpcPort,
} from '../src/utils/daemon-discovery.js';

const ROSTER_REVISION = 'a'.repeat(64);

function modernDescriptor(overrides: Record<string, unknown> = {}) {
  return {
    larkAppId: 'cli_agent',
    ipcPort: 7956,
    bootInstanceId: 'A'.repeat(43),
    processStartIdentity: 'proc-old',
    rosterRevision: ROSTER_REVISION,
    workflowIpcProtocol: 'v1',
    botName: 'codex-loopy',
    cliId: 'codex',
    pid: 123,
    startedAt: 100,
    lastHeartbeat: 1_000,
    resolvedAllowedUsers: [],
    ...overrides,
  };
}

function makeFileStale(filePath: string): void {
  const stale = new Date(1_000);
  utimesSync(filePath, stale, stale);
}

describe('daemon IPC port fallback', () => {
  it('prefers a discovered port and otherwise accepts a valid injected port', () => {
    expect(resolveDaemonIpcPort(4310, '9999')).toBe(4310);
    expect(resolveDaemonIpcPort(undefined, '9999')).toBe(9999);
  });

  it.each([undefined, '', '0', '-1', '65536', '12.5', 'not-a-port'])(
    'rejects invalid injected port %s',
    (raw) => {
      expect(parseDaemonIpcPort(raw)).toBeUndefined();
    },
  );
});

describe('daemon discovery', () => {
  let dir: string;
  let priorDataDir: string | undefined;
  let priorHome: string | undefined;

  beforeEach(() => {
    priorDataDir = process.env.SESSION_DATA_DIR;
    priorHome = process.env.HOME;
    dir = join(tmpdir(), `botmux-daemon-discovery-${process.pid}-${Date.now()}`);
    mkdirSync(join(dir, 'dashboard-daemons'), { recursive: true });
    process.env.SESSION_DATA_DIR = dir;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (priorDataDir === undefined) delete process.env.SESSION_DATA_DIR;
    else process.env.SESSION_DATA_DIR = priorDataDir;
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps friendly bot labels from daemon descriptors', () => {
    const bootInstanceId = 'A'.repeat(43);
    writeFileSync(join(dir, 'dashboard-daemons', 'cli_agent.json'), JSON.stringify({
      larkAppId: 'cli_agent',
      ipcPort: 7956,
      bootInstanceId,
      workflowIpcProtocol: 'v1',
      receiptAuthorityProtocolVersion: 1,
      receiptAuthorityActivationEpoch: 'e'.repeat(43),
      botName: 'codex-loopy',
      cliId: 'codex',
      pid: 123,
      lastHeartbeat: Date.now(),
    }));

    expect(listOnlineDaemons()).toEqual([expect.objectContaining({
      larkAppId: 'cli_agent',
      ipcPort: 7956,
      bootInstanceId,
      workflowIpcProtocol: 'v1',
      receiptAuthorityProtocolVersion: 1,
      receiptAuthorityActivationEpoch: 'e'.repeat(43),
      botName: 'codex-loopy',
      cliId: 'codex',
    })]);
  });

  it('does not invent a Workflow IPC boot identity for an old descriptor', () => {
    writeFileSync(join(dir, 'dashboard-daemons', 'legacy.json'), JSON.stringify({
      larkAppId: 'legacy',
      ipcPort: 7957,
      lastHeartbeat: Date.now(),
    }));

    expect(listOnlineDaemons()).toEqual([expect.objectContaining({
      larkAppId: 'legacy',
      ipcPort: 7957,
    })]);
    expect(listOnlineDaemons()[0]).not.toHaveProperty('bootInstanceId');
    expect(listOnlineDaemons()[0]).not.toHaveProperty('workflowIpcProtocol');
    expect(listOnlineDaemons()[0]).not.toHaveProperty('receiptAuthorityProtocolVersion');
    expect(listOnlineDaemons()[0]).not.toHaveProperty('receiptAuthorityActivationEpoch');
  });

  it('follows the canonical data-dir breadcrumb when SESSION_DATA_DIR is absent', () => {
    const home = join(dir, 'home');
    mkdirSync(join(home, '.botmux'), { recursive: true });
    writeFileSync(join(home, '.botmux', '.data-dir'), dir);
    process.env.HOME = home;
    delete process.env.SESSION_DATA_DIR;

    writeFileSync(join(dir, 'dashboard-daemons', 'breadcrumb.json'), JSON.stringify({
      larkAppId: 'breadcrumb',
      ipcPort: 7958,
      bootInstanceId: 'B'.repeat(43),
      workflowIpcProtocol: 'v1',
      lastHeartbeat: Date.now(),
    }));

    expect(listOnlineDaemons()).toEqual([expect.objectContaining({
      larkAppId: 'breadcrumb',
      ipcPort: 7958,
      workflowIpcProtocol: 'v1',
    })]);
  });

  it('keeps old and new generations of the same App visible while selecting the newest', () => {
    const registryDir = join(dir, 'dashboard-daemons');
    const oldDescriptor = modernDescriptor();
    const newDescriptor = modernDescriptor({
      ipcPort: 7957,
      bootInstanceId: 'B'.repeat(43),
      processStartIdentity: 'proc-new',
      pid: 124,
      startedAt: 200,
      lastHeartbeat: 2_000,
    });
    Object.assign(oldDescriptor, {
      receiptAuthorityProtocolVersion: 1,
      receiptAuthorityActivationEpoch: 'e'.repeat(43),
    });
    Object.assign(newDescriptor, {
      receiptAuthorityProtocolVersion: 1,
      receiptAuthorityActivationEpoch: 'e'.repeat(43),
    });
    const oldPublication = publishDaemonDescriptor(registryDir, oldDescriptor);
    const newPublication = publishDaemonDescriptor(registryDir, newDescriptor);

    const processStarts = new Map([[123, 'proc-old'], [124, 'proc-new']]);
    const options = { registryDir, now: 2_000, processStart: (pid: number) => processStarts.get(pid) };
    expect(listOnlineDaemons(options).map(daemon => daemon.bootInstanceId)).toEqual([
      newDescriptor.bootInstanceId,
      oldDescriptor.bootInstanceId,
    ]);
    expect(findOnlineDaemon('cli_agent', options)?.bootInstanceId).toBe(newDescriptor.bootInstanceId);

    const collected = collectAskReceiptAuthorityLiveSiblings({
      discoveredDaemons: listOnlineDaemons(options),
      self: {
        larkAppId: newDescriptor.larkAppId,
        bootInstanceId: newDescriptor.bootInstanceId,
        pid: newDescriptor.pid,
        processStartIdentity: newDescriptor.processStartIdentity,
        rosterRevision: newDescriptor.rosterRevision,
      },
      receiptAuthorityProtocolVersion: 1,
      receiptAuthorityActivationEpoch: 'e'.repeat(43),
    });
    expect(collected.protocolCompatible).toBe(true);
    expect(collected.liveSiblings.map(daemon => daemon.bootInstanceId)).toEqual([
      newDescriptor.bootInstanceId,
      oldDescriptor.bootInstanceId,
    ]);
    expect(daemonDescriptorFileName(oldDescriptor)).toMatch(/^daemon-[a-f0-9]{64}\.json$/);
    expect(daemonDescriptorFileName(oldDescriptor)).not.toContain(oldDescriptor.larkAppId);

    expect(removeDaemonDescriptorPublication(oldPublication)).toBe(true);
    expect(existsSync(newPublication.filePath)).toBe(true);
    expect(listOnlineDaemons(options).map(daemon => daemon.bootInstanceId)).toEqual([
      newDescriptor.bootInstanceId,
    ]);
  });

  it('retains a heartbeat-stale modern descriptor while its exact process is alive', () => {
    const registryDir = join(dir, 'dashboard-daemons');
    const descriptor = modernDescriptor({ lastHeartbeat: 1_000 });
    const publication = publishDaemonDescriptor(registryDir, descriptor);

    expect(listOnlineDaemons({
      registryDir,
      now: 200_000,
      processStart: () => descriptor.processStartIdentity,
    })).toEqual([expect.objectContaining({ bootInstanceId: descriptor.bootInstanceId })]);
    expect(existsSync(publication.filePath)).toBe(true);
  });

  it('cleanup retains an mtime-stale modern descriptor while its exact process is alive', () => {
    const registryDir = join(dir, 'dashboard-daemons');
    const descriptor = modernDescriptor({ lastHeartbeat: 1_000 });
    const publication = publishDaemonDescriptor(registryDir, descriptor);
    makeFileStale(publication.filePath);

    expect(cleanupStaleDaemonDescriptorFiles(registryDir, 5_000, 200_000, {
      processStart: () => descriptor.processStartIdentity,
    })).toBe(0);
    expect(existsSync(publication.filePath)).toBe(true);
  });

  it('cleanup retains a paused same-App predecessor so authority stays blocked', () => {
    const registryDir = join(dir, 'dashboard-daemons');
    const predecessor = modernDescriptor({
      lastHeartbeat: 1_000,
      receiptAuthorityProtocolVersion: undefined,
      receiptAuthorityActivationEpoch: undefined,
    });
    const successor = modernDescriptor({
      bootInstanceId: 'B'.repeat(43),
      processStartIdentity: 'proc-new',
      pid: 124,
      lastHeartbeat: 200_000,
      receiptAuthorityProtocolVersion: 1,
      receiptAuthorityActivationEpoch: 'e'.repeat(43),
    });
    const predecessorPublication = publishDaemonDescriptor(registryDir, predecessor);
    publishDaemonDescriptor(registryDir, successor);
    makeFileStale(predecessorPublication.filePath);
    const starts = new Map([[123, 'proc-old'], [124, 'proc-new']]);

    expect(cleanupStaleDaemonDescriptorFiles(registryDir, 5_000, 200_000, {
      processStart: pid => starts.get(pid),
    })).toBe(0);
    const discovered = listOnlineDaemons({
      registryDir,
      now: 200_000,
      processStart: pid => starts.get(pid),
    });
    const collected = collectAskReceiptAuthorityLiveSiblings({
      discoveredDaemons: discovered,
      self: {
        larkAppId: successor.larkAppId,
        bootInstanceId: successor.bootInstanceId,
        pid: successor.pid,
        processStartIdentity: successor.processStartIdentity,
        rosterRevision: successor.rosterRevision,
      },
      receiptAuthorityProtocolVersion: 1,
      receiptAuthorityActivationEpoch: 'e'.repeat(43),
    });

    expect(discovered.map(item => item.bootInstanceId)).toContain(predecessor.bootInstanceId);
    expect(collected.protocolCompatible).toBe(false);
  });

  it('keeps a paused same-App predecessor visible so authority fails closed', () => {
    const registryDir = join(dir, 'dashboard-daemons');
    const predecessor = modernDescriptor({
      lastHeartbeat: 1_000,
      receiptAuthorityProtocolVersion: undefined,
      receiptAuthorityActivationEpoch: undefined,
    });
    const successor = modernDescriptor({
      bootInstanceId: 'B'.repeat(43),
      processStartIdentity: 'proc-new',
      pid: 124,
      lastHeartbeat: 200_000,
      receiptAuthorityProtocolVersion: 1,
      receiptAuthorityActivationEpoch: 'e'.repeat(43),
    });
    publishDaemonDescriptor(registryDir, predecessor);
    publishDaemonDescriptor(registryDir, successor);
    const starts = new Map([[123, 'proc-old'], [124, 'proc-new']]);
    const discovered = listOnlineDaemons({
      registryDir, now: 200_000, processStart: pid => starts.get(pid),
    });

    const collected = collectAskReceiptAuthorityLiveSiblings({
      discoveredDaemons: discovered,
      self: {
        larkAppId: successor.larkAppId,
        bootInstanceId: successor.bootInstanceId,
        pid: successor.pid,
        processStartIdentity: successor.processStartIdentity,
        rosterRevision: successor.rosterRevision,
      },
      receiptAuthorityProtocolVersion: 1,
      receiptAuthorityActivationEpoch: 'e'.repeat(43),
    });

    expect(discovered.map(item => item.bootInstanceId)).toEqual([
      successor.bootInstanceId, predecessor.bootInstanceId,
    ]);
    expect(collected.protocolCompatible).toBe(false);
  });

  it.each([
    ['dead', undefined, false],
    ['pid reused', 'different-proc-start', true],
  ])('CAS-cleans a heartbeat-stale modern descriptor after proving %s', (
    _label,
    liveStart,
    pidExists,
  ) => {
    const registryDir = join(dir, 'dashboard-daemons');
    const descriptor = modernDescriptor({ lastHeartbeat: 1_000 });
    const publication = publishDaemonDescriptor(registryDir, descriptor);

    expect(listOnlineDaemons({
      registryDir,
      now: 200_000,
      processStart: () => liveStart,
      processExists: () => pidExists,
    })).toEqual([]);
    expect(existsSync(publication.filePath)).toBe(false);
  });

  it.each([
    ['dead', undefined, false],
    ['pid reused', 'different-proc-start', true],
  ])('cleanup CAS-removes an mtime-stale modern descriptor after proving %s', (
    _label,
    liveStart,
    pidExists,
  ) => {
    const registryDir = join(dir, 'dashboard-daemons');
    const publication = publishDaemonDescriptor(registryDir, modernDescriptor());
    makeFileStale(publication.filePath);

    expect(cleanupStaleDaemonDescriptorFiles(registryDir, 5_000, 200_000, {
      processStart: () => liveStart,
      processExists: () => pidExists,
    })).toBe(1);
    expect(existsSync(publication.filePath)).toBe(false);
  });

  it('cleanup retains a modern descriptor when its live process identity is unavailable', () => {
    const registryDir = join(dir, 'dashboard-daemons');
    const publication = publishDaemonDescriptor(registryDir, modernDescriptor());
    makeFileStale(publication.filePath);

    expect(cleanupStaleDaemonDescriptorFiles(registryDir, 5_000, 200_000, {
      processStart: () => undefined,
      processExists: () => true,
    })).toBe(0);
    expect(existsSync(publication.filePath)).toBe(true);
  });

  it.each([
    ['ESRCH', 'proven absent', 1, false],
    ['EPERM', 'still present', 0, true],
    ['EIO', 'unknown', 0, true],
  ])('cleanup classifies process probe error %s as %s', (
    errorCode,
    _status,
    removed,
    retained,
  ) => {
    const registryDir = join(dir, 'dashboard-daemons');
    const publication = publishDaemonDescriptor(registryDir, modernDescriptor());
    makeFileStale(publication.filePath);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error(`process probe failed: ${errorCode}`), { code: errorCode });
    });

    expect(cleanupStaleDaemonDescriptorFiles(registryDir, 5_000, 200_000, {
      processStart: () => undefined,
    })).toBe(removed);
    expect(existsSync(publication.filePath)).toBe(retained);
  });

  it('cleanup exact-CAS does not delete a modern descriptor rewritten after liveness proof', () => {
    const registryDir = join(dir, 'dashboard-daemons');
    const descriptor = modernDescriptor();
    const publication = publishDaemonDescriptor(registryDir, descriptor);
    makeFileStale(publication.filePath);
    const replacement = { ...descriptor, ipcPort: 7959, lastHeartbeat: 200_000 };
    let replacementPublication: ReturnType<typeof publishDaemonDescriptor> | undefined;

    expect(cleanupStaleDaemonDescriptorFiles(registryDir, 5_000, 200_000, {
      processStart: () => {
        replacementPublication = publishDaemonDescriptor(registryDir, replacement);
        return undefined;
      },
      processExists: () => false,
    })).toBe(0);
    expect(replacementPublication).toBeDefined();
    expect(replacementPublication!.inode).not.toBe(publication.inode);
    expect(readFileSync(publication.filePath, 'utf8')).toBe(replacementPublication!.raw);
  });

  it('cleanup preserves legacy mtime-only behavior', () => {
    const registryDir = join(dir, 'dashboard-daemons');
    const legacyPath = join(registryDir, 'cli_agent.json');
    writeFileSync(legacyPath, JSON.stringify({
      larkAppId: 'cli_agent',
      ipcPort: 7955,
      pid: 123,
      lastHeartbeat: 200_000,
    }));
    makeFileStale(legacyPath);

    expect(cleanupStaleDaemonDescriptorFiles(registryDir, 5_000, 200_000, {
      processStart: () => 'proc-old',
      processExists: () => true,
    })).toBe(1);
    expect(existsSync(legacyPath)).toBe(false);
  });

  it('cleanup fails closed on an invalid modern descriptor', () => {
    const registryDir = join(dir, 'dashboard-daemons');
    const descriptor = modernDescriptor();
    const publication = publishDaemonDescriptor(registryDir, descriptor);
    writeFileSync(publication.filePath, '{ malformed');
    makeFileStale(publication.filePath);

    expect(() => cleanupStaleDaemonDescriptorFiles(
      registryDir,
      5_000,
      200_000,
    )).toThrow(DaemonDescriptorValidationError);
    expect(existsSync(publication.filePath)).toBe(true);
  });

  it('selects a live stale modern generation over a fresher legacy descriptor', () => {
    const registryDir = join(dir, 'dashboard-daemons');
    const descriptor = modernDescriptor({ lastHeartbeat: 1_000 });
    publishDaemonDescriptor(registryDir, descriptor);
    writeFileSync(join(registryDir, 'cli_agent.json'), JSON.stringify({
      larkAppId: 'cli_agent', ipcPort: 7999, lastHeartbeat: 200_000,
    }));

    expect(findOnlineDaemon('cli_agent', {
      registryDir,
      now: 200_000,
      processStart: () => descriptor.processStartIdentity,
    })).toMatchObject({
      bootInstanceId: descriptor.bootInstanceId,
      processStartIdentity: descriptor.processStartIdentity,
    });
  });

  it('removes only the exact publication and cannot delete a rewritten generation file', () => {
    const registryDir = join(dir, 'dashboard-daemons');
    const descriptor = modernDescriptor();
    const oldPublication = publishDaemonDescriptor(registryDir, descriptor);
    const successorPublication = publishDaemonDescriptor(registryDir, {
      ...descriptor,
      ipcPort: 7959,
      lastHeartbeat: 2_000,
    });

    expect(removeDaemonDescriptorPublication(oldPublication)).toBe(false);
    expect(readFileSync(successorPublication.filePath, 'utf8')).toBe(successorPublication.raw);
    expect(removeDaemonDescriptorPublication(successorPublication)).toBe(true);
    expect(existsSync(successorPublication.filePath)).toBe(false);
  });

  it('reads legacy descriptors without letting modern cleanup address their path', () => {
    const registryDir = join(dir, 'dashboard-daemons');
    const legacyPath = join(registryDir, 'cli_agent.json');
    writeFileSync(legacyPath, JSON.stringify({
      larkAppId: 'cli_agent',
      ipcPort: 7955,
      lastHeartbeat: 1_000,
    }));
    const publication = publishDaemonDescriptor(registryDir, modernDescriptor());

    expect(listOnlineDaemons({
      registryDir, now: 1_000, processStart: () => 'proc-old',
    })).toHaveLength(2);
    expect(removeDaemonDescriptorPublication(publication)).toBe(true);
    expect(existsSync(legacyPath)).toBe(true);
  });

  it('cleans an exact stale generation but fails closed on fresh filename tampering', () => {
    const registryDir = join(dir, 'dashboard-daemons');
    const stale = modernDescriptor({ lastHeartbeat: 1_000 });
    const stalePublication = publishDaemonDescriptor(registryDir, stale);
    expect(listOnlineDaemons({
      registryDir,
      now: 100_000,
      processStart: () => undefined,
      processExists: () => false,
    })).toEqual([]);
    expect(existsSync(stalePublication.filePath)).toBe(false);

    const tampered = modernDescriptor({ lastHeartbeat: 100_000 });
    const wrongIdentity = { ...tampered, bootInstanceId: 'Z'.repeat(43) };
    writeFileSync(
      join(registryDir, daemonDescriptorFileName(tampered)),
      JSON.stringify(wrongIdentity),
    );
    expect(() => listOnlineDaemons({
      registryDir, now: 100_000, processStart: () => 'proc-old',
    })).toThrow(DaemonDescriptorValidationError);
  });
});

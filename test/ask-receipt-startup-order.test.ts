import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const daemonSource = readFileSync(resolve('src/daemon.ts'), 'utf8');
const supervisorSource = readFileSync(resolve('src/core/fleet-supervisor.ts'), 'utf8');

function region(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start, `${startMarker} not found`).toBeGreaterThan(-1);
  expect(end, `${endMarker} not found after ${startMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('ask receipt authority startup ordering (source lock)', () => {
  it('defers signer load until after restoreActiveSessions reconciles legacy panes', () => {
    const helper = region(
      daemonSource,
      'async function restoreSessionsAndScheduleStartupRecovery(opts: {',
      '\n}\n/** Once-per-daemon guard for the mojo containment boot reconciliation.',
    );
    const restoreAt = helper.indexOf('await opts.restoreSessions();');
    const activateAt = helper.indexOf('await opts.afterRestore();');
    const restoredFlagAt = helper.indexOf('opts.markSessionsRestored();');
    const block = region(
      daemonSource,
      'const activateAskReceiptAuthorityAfterRestore = async (): Promise<void> => {',
      '\n\n  writePidFile();',
    );

    expect(restoreAt).toBeGreaterThan(0);
    expect(activateAt).toBeGreaterThan(restoreAt);
    expect(block).toContain('loadOrCreateAskReceiptSigner(');
    expect(restoredFlagAt).toBeGreaterThan(activateAt);
  });

  it('keeps authority disabled until post-restore activation publishes it', () => {
    const block = region(
      daemonSource,
      'const activateAskReceiptAuthorityAfterRestore = async (): Promise<void> => {',
      '\n\n  writePidFile();',
    );
    expect(block).toContain('askReceiptProvenanceIssuer = undefined;');
    expect(block).toContain('setAskReceiptRedeemer(null);');
    expect(block).toContain("setAskPersistStoreBroker(createAskPersistStore(join(config.session.dataDir, 'asks')));");
    expect(block.indexOf('setAskReceiptRedeemer(null);'))
      .toBeLessThan(block.indexOf('loadOrCreateAskReceiptSigner('));
    expect(block.indexOf("setAskPersistStoreBroker(createAskPersistStore(join(config.session.dataDir, 'asks')));"))
      .toBeLessThan(block.indexOf('loadOrCreateAskReceiptSigner('));
  });

  it('releases the ask restore fence only after post-restore authority activation', () => {
    const startup = region(
      daemonSource,
      'await withBotsJsonLock(startupRoster.requestedConfigPath, (lockedConfigPath, assertTargetStable) =>',
      '\n  } catch (error) {',
    );
    const restoreAt = startup.indexOf('restoreSessions: () => restoreActiveSessions(');
    const activateAt = startup.indexOf('afterRestore: activateAskReceiptAuthorityAfterRestore,');
    const restoredFlagAt = startup.indexOf('sessionsRestored = true;');
    const readyAt = startup.indexOf('markIpcReady();');

    expect(restoreAt).toBeGreaterThan(0);
    expect(activateAt).toBeGreaterThan(restoreAt);
    expect(restoredFlagAt).toBeGreaterThan(activateAt);
    expect(readyAt).toBeGreaterThan(restoredFlagAt);
  });

  it('adopts the parent reservation inside the lock and publishes the ready descriptor only after restore', () => {
    const startup = region(
      daemonSource,
      'const ipcHandle = await startIpcServer({',
      '\n  for (const startDispatcher of startEventDispatchers) startDispatcher();',
    );
    const intentAt = startup.indexOf('startupIntent = reservationId && reservationToken');
    const configLockAt = startup.indexOf(
      'await withBotsJsonLock(startupRoster.requestedConfigPath, (lockedConfigPath, assertTargetStable) =>',
    );
    const lockAt = startup.indexOf('withDeviceCredentialIsolationActivationLock(async () => {');
    const publishAt = startup.indexOf('writeDaemonDescriptor(desc, { publish: true });');
    const restoreAt = startup.indexOf('restoreSessions: () => restoreActiveSessions(');
    const markerAt = startup.indexOf('const startupIsolationMarker = readDeviceCredentialIsolationMarker();');
    const isolationAt = startup.indexOf('deviceCredentialIsolationSupported()');
    const activateAt = startup.indexOf('afterRestore: activateAskReceiptAuthorityAfterRestore,');
    const stableAt = startup.indexOf('assertTargetStable();');
    const publishStableAt = startup.lastIndexOf('assertTargetStable();');
    const readyAt = startup.indexOf('markIpcReady();');

    const clearIntentAt = startup.indexOf('clearDeviceIsolationStartupIntent({');

    expect(configLockAt).toBeGreaterThanOrEqual(0);
    expect(lockAt).toBeGreaterThan(configLockAt);
    expect(intentAt).toBeGreaterThanOrEqual(0);
    expect(intentAt).toBeGreaterThan(lockAt);
    expect(markerAt).toBeGreaterThan(intentAt);
    expect(isolationAt).toBeGreaterThan(markerAt);
    expect(restoreAt).toBeGreaterThan(isolationAt);
    expect(activateAt).toBeGreaterThan(restoreAt);
    expect(stableAt).toBeGreaterThan(activateAt);
    expect(readyAt).toBeGreaterThan(stableAt);
    expect(clearIntentAt).toBeGreaterThan(readyAt);
    expect(publishStableAt).toBeGreaterThan(clearIntentAt);
    expect(publishAt).toBeGreaterThan(clearIntentAt);
    expect(publishAt).toBeGreaterThan(publishStableAt);
    expect(startup.slice(0, lockAt)).not.toContain('writeDaemonDescriptor(desc, { publish: true });');
  });

  it('reserves startup under the host gate before spawn and binds the exact child afterwards', () => {
    const block = region(
      supervisorSource,
      "if (entry === 'daemon' && spec.rosterRevision && spec.appId) {",
      '\n    if (!child) return;',
    );
    const gateAt = block.indexOf('withDeviceCredentialIsolationActivationLockSync');
    const reserveAt = block.indexOf('reserveDeviceIsolationDaemonStartup');
    const spawnAt = block.indexOf('spawned = spawnChild();');
    const bindAt = block.indexOf('bindDeviceIsolationStartupReservationToChild');
    expect(gateAt).toBeGreaterThanOrEqual(0);
    expect(reserveAt).toBeGreaterThan(gateAt);
    expect(spawnAt).toBeGreaterThan(reserveAt);
    expect(bindAt).toBeGreaterThan(spawnAt);
  });

  it('removes a descriptor if startup fails after publication', () => {
    const startup = region(
      daemonSource,
      'try {\n    // Fixed order shared with activation and fleet start:',
      '\n  // Restore complete',
    );
    expect(startup).toContain('const descriptorPublishedByThisStartup = selfDaemonDescriptorPublished;');
    expect(startup).toContain('selfDaemonDescriptorPublished = false;');
    expect(startup).toContain('if (descriptorPublishedByThisStartup) removeDaemonDescriptor();');
    expect(startup).toContain('throw error;');
  });

  it('holds config then activation locks through roster read, restore, readiness, and publication', () => {
    const startup = region(
      daemonSource,
      'await withBotsJsonLock(startupRoster.requestedConfigPath, (lockedConfigPath, assertTargetStable) =>',
      '\n  } catch (error) {',
    );
    const activationAt = startup.indexOf('withDeviceCredentialIsolationActivationLock');
    const rosterAt = startup.indexOf('const lockedRoster = readDeviceIsolationRosterSnapshot');
    const restoreAt = startup.indexOf('restoreSessions: () => restoreActiveSessions(');
    const authorityAt = startup.indexOf('afterRestore: activateAskReceiptAuthorityAfterRestore,');
    const stableAt = startup.indexOf('assertTargetStable();');
    const readyAt = startup.indexOf('markIpcReady();');
    const clearAt = startup.indexOf('clearDeviceIsolationStartupIntent({');
    const publishStableAt = startup.lastIndexOf('assertTargetStable();');
    const publishAt = startup.indexOf('writeDaemonDescriptor(desc, { publish: true });');

    expect(activationAt).toBeGreaterThanOrEqual(0);
    expect(rosterAt).toBeGreaterThan(activationAt);
    expect(restoreAt).toBeGreaterThan(rosterAt);
    expect(authorityAt).toBeGreaterThan(restoreAt);
    expect(stableAt).toBeGreaterThan(authorityAt);
    expect(readyAt).toBeGreaterThan(stableAt);
    expect(clearAt).toBeGreaterThan(readyAt);
    expect(publishStableAt).toBeGreaterThan(clearAt);
    expect(publishAt).toBeGreaterThan(clearAt);
    expect(publishAt).toBeGreaterThan(publishStableAt);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
const daemonSource = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');

describe('Codex RPC overlap wiring', () => {
  it('keeps ordinary RPC type-ahead behind the native terminal', () => {
    const start = workerSource.indexOf('if (rpcLifecycleFailClosedOwners.size > 0) break;');
    const end = workerSource.indexOf("if (item.trustedCaller && lastInitConfig?.cliId === 'codex') break;", start);
    const tail = workerSource.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(tail).toContain('if (directRpcTurnBlocksTypeAhead()) break;');
  });

  it('uses turn/steer only for an authenticated bot control with an exact native id', () => {
    const start = workerSource.indexOf('if (isTrustedRpcSteer) {');
    const end = workerSource.indexOf('if (item.taskContinuation', start);
    const rpcBranch = workerSource.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(workerSource).toContain("item.trustedCaller?.senderType === 'bot'");
    expect(rpcBranch).toContain('const expectedTurnId = writeRpcEngine.activeNativeTurnId;');
    expect(rpcBranch).toContain('pendingMessages.unshift(item);');
    expect(rpcBranch).toContain('await writeRpcEngine.steerTurn(msg, expectedTurnId);');
    expect(rpcBranch).not.toContain('await writeRpcEngine.sendTurn(msg, rpcTurnIdentity!);');
  });

  it('requeues a definitely-not-sent RPC turn before the ambiguous-owner path', () => {
    const rpcSend = workerSource.indexOf('writeRpcEngine.sendTurn(');
    const catchStart = workerSource.indexOf('} catch (err: any) {', rpcSend);
    const ambiguousStart = workerSource.indexOf(
      'if (rpcTurnIdentity && rpcTurnGeneration && writeRpcEngine) {',
      catchStart,
    );
    const catchPrefix = workerSource.slice(catchStart, ambiguousStart);

    expect(rpcSend).toBeGreaterThanOrEqual(0);
    expect(catchStart).toBeGreaterThan(rpcSend);
    expect(ambiguousStart).toBeGreaterThan(catchStart);
    expect(catchPrefix).toContain('err instanceof CodexRpcDeliveryError');
    expect(catchPrefix).toContain("err.deliveryDisposition === 'not_sent'");
    expect(catchPrefix).toContain('clearAwaitingRpcActivation(rpcTurnIdentity, rpcTurnGeneration);');
    expect(catchPrefix).toContain('pendingMessages.unshift(item);');
    expect(catchPrefix).not.toContain('installRpcLifecycleFailClosedOwner');
    expect(catchPrefix).not.toContain('restartCliProcess');
  });

  it('binds every ordinary TraeX RPC follow-up builder to the latest native-thread receipt', () => {
    expect(daemonSource).toContain('function traexRpcContextForSession(');
    expect(daemonSource.match(/traexRpcContextForSession\(ds,/g) ?? []).toHaveLength(5);
  });
});

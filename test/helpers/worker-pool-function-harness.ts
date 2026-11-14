/** Execute a production closure with explicit host dependencies, matching the
 * worker-function harness while the pool still has no importable host seam. */
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { controllerForSession } from '../../src/core/session-controller.js';
import { isCodexAppCliId } from '../../src/adapters/cli/types.js';
import { executionObserverSupported } from '../../src/services/session-contract.js';
import * as replyTargetModule from '../../src/core/reply-target.js';

/** Names of top-level function declarations in worker-pool.ts, so a closure
 * executed through the `with (scope)` proxy can lazily resolve any pool-local
 * helper it references (the same perimeter the module itself would have). */
let poolFunctionNames: Set<string> | undefined;
function poolFunctionExists(name: string): boolean {
  if (!poolFunctionNames) {
    const source = ts.createSourceFile('worker-pool.ts',
      readFileSync('src/core/worker-pool.ts', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    poolFunctionNames = new Set(source.statements
      .filter(ts.isFunctionDeclaration)
      .map(node => node.name?.text ?? '')
      .filter(Boolean));
  }
  return poolFunctionNames.has(name);
}

export function loadWorkerPoolFunction<T extends (...args: any[]) => any>(
  name: string, scope: Record<string, any>,
): T {
  const source = ts.createSourceFile('worker-pool.ts',
    readFileSync('src/core/worker-pool.ts', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!declaration) throw new Error(`Missing pool function: ${name}`);
  const compiled = ts.transpileModule(declaration.getText(source).replace(/^export\s+/, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const proxy = new Proxy(scope, {
    has: (_target, key) => key !== Symbol.unscopables,
    get: (target, key) => key in target ? target[key as string] : key === 'controllerForSession' ? controllerForSession : key === 'isCodexAppCliId' ? isCodexAppCliId : key === 'executionObserverSupported' ? executionObserverSupported : key === 'ownsCodexAppFinalDelivery' ? loadWorkerPoolFunction('ownsCodexAppFinalDelivery', scope) : typeof key === 'string' && poolFunctionExists(key) ? loadWorkerPoolFunction(key, scope) : typeof key === 'string' && Object.hasOwn(replyTargetModule, key) ? (replyTargetModule as any)[key] : (globalThis as any)[key],
    set: (target, key, value) => { target[key as string] = value; return true; },
  });
  return new Function('scope', `with (scope) { ${compiled}; return ${name}; }`)(proxy) as T;
}

/** Transitional seam for a production handler closure while its host lifetime
 * still belongs to setupWorkerHandlers. Execute its body, not source assertions. */
export function loadWorkerPoolClosure<T extends (...args: any[]) => any>(name: string, scope: Record<string, any>): T {
  const source = ts.createSourceFile('worker-pool.ts', readFileSync('src/core/worker-pool.ts', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let declaration: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) declaration = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!declaration) throw new Error(`Missing pool closure: ${name}`);
  const compiled = ts.transpileModule(`const ${declaration.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const proxy = new Proxy(scope, {
    has: (_target, key) => key !== Symbol.unscopables,
    get: (target, key) => key in target ? target[key as string] : key === 'controllerForSession' ? controllerForSession : key === 'isCodexAppCliId' ? isCodexAppCliId : key === 'executionObserverSupported' ? executionObserverSupported : key === 'ownsCodexAppFinalDelivery' ? loadWorkerPoolFunction('ownsCodexAppFinalDelivery', scope) : typeof key === 'string' && poolFunctionExists(key) ? loadWorkerPoolFunction(key, scope) : typeof key === 'string' && Object.hasOwn(replyTargetModule, key) ? (replyTargetModule as any)[key] : (globalThis as any)[key],
    set: (target, key, value) => { target[key as string] = value; return true; },
  });
  return new Function('scope', `with (scope) { ${compiled}; return ${name}; }`)(proxy) as T;
}

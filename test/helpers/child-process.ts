import type { ChildProcess } from 'node:child_process';

export function waitForChildExit(
  child: ChildProcess,
  options: {
    description: string;
    logs?: readonly string[];
    timeoutMs?: number;
  },
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const timeoutMs = options.timeoutMs ?? 5_000;
  return new Promise((resolvePromise, rejectPromise) => {
    const onExit = (): void => finish();
    const onError = (error: Error): void => finish(error);
    const timer = setTimeout(() => {
      finish(new Error(
        options.description + ' pid ' + (child.pid ?? 'unknown')
        + ' did not exit within ' + timeoutMs + 'ms'
        + (options.logs?.length ? '\n' + options.logs.join('') : ''),
      ));
    }, timeoutMs);
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

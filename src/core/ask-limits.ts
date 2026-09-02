/** Shared lifetime boundary for every Botmux Ask ingress.
 *
 * The durable Lark callback replay fence retains claims for this full window
 * plus the receipt TTL, so no caller may create a longer-lived Ask.
 */
export const ASK_MIN_TIMEOUT_MS = 1_000;
export const ASK_MAX_TIMEOUT_MS = 24 * 60 * 60 * 1_000;

export function isSupportedAskTimeoutMs(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= ASK_MIN_TIMEOUT_MS
    && value <= ASK_MAX_TIMEOUT_MS;
}

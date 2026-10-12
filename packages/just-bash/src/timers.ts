/**
 * Timer helpers for the interpreter and commands, including finite deadlines
 * longer than the host timer allows.
 */

const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);

export const _setTimeout: typeof globalThis.setTimeout = ((
  callback: Parameters<typeof globalThis.setTimeout>[0],
  delay?: number,
  ...args: unknown[]
) => {
  return nativeSetTimeout(callback, delay, ...args);
}) as typeof globalThis.setTimeout;

export const _clearTimeout: typeof globalThis.clearTimeout = nativeClearTimeout;

const MAX_NATIVE_TIMEOUT_MS = 2_147_483_647;

export interface FiniteTimeoutHandle {
  cleared: boolean;
  remainingMs: number;
  timer: ReturnType<typeof globalThis.setTimeout> | undefined;
}

/**
 * Schedule a configured deadline without overflowing the host timer. Positive
 * Infinity means no deadline; longer finite delays are advanced in native-safe
 * chunks so they retain their actual duration.
 */
export function _setTimeoutIfFinite(
  callback: Parameters<typeof globalThis.setTimeout>[0],
  delay: number,
): FiniteTimeoutHandle | undefined {
  if (delay === Number.POSITIVE_INFINITY) return undefined;
  const run = callback as () => void;
  const handle: FiniteTimeoutHandle = {
    cleared: false,
    remainingMs: Math.max(0, delay),
    timer: undefined,
  };
  const schedule = (): void => {
    if (handle.cleared) return;
    const chunk = Math.min(handle.remainingMs, MAX_NATIVE_TIMEOUT_MS);
    handle.timer = nativeSetTimeout(() => {
      if (handle.cleared) return;
      handle.remainingMs -= chunk;
      if (handle.remainingMs > 0) schedule();
      else run();
    }, chunk);
  };
  schedule();
  return handle;
}

export function _clearFiniteTimeout(
  handle: FiniteTimeoutHandle | undefined,
): void {
  if (!handle) return;
  handle.cleared = true;
  if (handle.timer !== undefined) nativeClearTimeout(handle.timer);
}

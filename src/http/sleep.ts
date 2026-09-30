// sleep.ts — an abortable delay, the one timer the limiter and the refresh runner wait on (plan 01
// §5.7 retries with jitter; §6 per-source limiters). Injected everywhere so tests use fake timers.

/** Waits `ms`; rejects with the signal's reason (an AbortError) as soon as `signal` aborts. */
export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

/** The real sleep, over setTimeout. A non-finite or negative `ms` waits 0 ms. */
export const abortableSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    const abortError = (): Error =>
      signal.reason instanceof Error
        ? signal.reason
        : new DOMException("The operation was aborted", "AbortError");
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      Number.isFinite(ms) && ms > 0 ? ms : 0,
    );
    signal.addEventListener("abort", onAbort, { once: true });
  });

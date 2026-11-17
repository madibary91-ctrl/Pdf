/**
 * مسابقهٔ «کار ⟷ مهلت ⟷ لغو». تایمر از بیرون تزریق می‌شود (تست قطعی)، همیشه پاک می‌شود، و رد شدنِ دیرهنگامِ کار
 * هرگز «rejection کنترل‌نشده» نمی‌سازد.
 */
import type { Timers } from "./types";

export type Settled<T> =
  | Readonly<{ kind: "value"; value: T }>
  | Readonly<{ kind: "threw"; error: unknown }>
  | Readonly<{ kind: "timeout" }>
  | Readonly<{ kind: "aborted" }>;

export const DEFAULT_TIMERS: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>),
};

export function raceDeadline<T>(work: Promise<T>, ms: number, timers: Timers, signal?: AbortSignal): Promise<Settled<T>> {
  return new Promise<Settled<T>>((resolve) => {
    let done = false;
    let onAbort: (() => void) | null = null;
    const handle = timers.setTimeout(() => finish({ kind: "timeout" }), ms);
    function finish(s: Settled<T>): void {
      if (done) return;
      done = true;
      timers.clearTimeout(handle);
      if (signal !== undefined && onAbort !== null) signal.removeEventListener("abort", onAbort);
      resolve(s);
    }
    if (signal !== undefined) {
      if (signal.aborted) {
        finish({ kind: "aborted" });
      } else {
        onAbort = () => finish({ kind: "aborted" });
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }
    work.then(
      (value) => finish({ kind: "value", value }),
      (error: unknown) => finish({ kind: "threw", error }),
    );
  });
}

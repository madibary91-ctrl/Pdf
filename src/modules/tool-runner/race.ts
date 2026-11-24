/**
 * مسابقهٔ «کار ⟷ مهلت ⟷ لغو». تایمر تزریق می‌شود، همیشه پاک می‌شود و رد شدنِ دیرهنگامِ کارِ رهاشده هرگز
 * «rejection کنترل‌نشده» نمی‌سازد. کار فقط پس از بررسیِ لغو شروع می‌شود (لغوشده ⇒ هیچ کاری شروع نمی‌شود).
 */
import type { Timers } from "@/modules/ai-gateway";

export type Raced<T> =
  | Readonly<{ kind: "value"; value: T }>
  | Readonly<{ kind: "threw" }>
  | Readonly<{ kind: "timeout" }>
  | Readonly<{ kind: "aborted" }>;

/** `ms = Infinity` یعنی بی‌مهلت (فقط لغو). علتِ پرتاب عمداً دور ریخته می‌شود (ممکن است داده/کلید باشد). */
export function race<T>(start: () => Promise<T> | T, ms: number, timers: Timers, signal?: AbortSignal): Promise<Raced<T>> {
  return new Promise<Raced<T>>((resolve) => {
    if (signal?.aborted === true) return resolve({ kind: "aborted" });
    let done = false;
    let handle: unknown = null;
    let onAbort: (() => void) | null = null;
    const finish = (r: Raced<T>): void => {
      if (done) return;
      done = true;
      if (handle !== null) timers.clearTimeout(handle);
      if (signal !== undefined && onAbort !== null) signal.removeEventListener("abort", onAbort);
      resolve(r);
    };
    if (Number.isFinite(ms)) handle = timers.setTimeout(() => finish({ kind: "timeout" }), ms);
    if (signal !== undefined) {
      onAbort = () => finish({ kind: "aborted" });
      signal.addEventListener("abort", onAbort, { once: true });
    }
    new Promise<T>((res) => res(start())).then(
      (value) => finish({ kind: "value", value }),
      () => finish({ kind: "threw" }),
    );
  });
}

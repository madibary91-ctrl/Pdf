/** مهلتِ کران‌دار با زمان‌سنجِ تزریقی (داخلی). هرگز نمی‌پرتابد؛ زمان‌سنجِ خراب ⇒ `error` و `work` اصلاً صدا زده نمی‌شود (بی‌مهلت اجرا نمی‌کنیم). */
import type { MigrateTimer } from "./types";

export type Bounded<T> = Readonly<{ kind: "done"; value: T }> | Readonly<{ kind: "timeout" }> | Readonly<{ kind: "error" }>;

export function bounded<T>(timer: MigrateTimer, ms: number, work: () => T | Promise<T>): Promise<Bounded<T>> {
  return new Promise<Bounded<T>>((resolve) => {
    let done = false;
    let armed = false;
    let handle: unknown;
    const finish = (r: Bounded<T>): void => {
      if (done) return;
      done = true;
      if (armed) {
        try {
          timer.cancel(handle);
        } catch {
          // لغوِ ناموفق بی‌خطر است.
        }
      }
      resolve(r);
    };
    try {
      armed = true;
      const h = timer.after(() => finish({ kind: "timeout" }), ms);
      if (!done) handle = h;
    } catch {
      armed = false;
      finish({ kind: "error" });
    }
    if (done) return;
    try {
      Promise.resolve(work()).then(
        (value) => finish({ kind: "done", value }),
        () => finish({ kind: "error" }),
      );
    } catch {
      finish({ kind: "error" });
    }
  });
}

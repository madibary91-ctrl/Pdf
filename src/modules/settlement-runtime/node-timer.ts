/**
 * آداپتورِ زمان‌سنجِ Node برای `LoopTimer` (ADR-0031). تنها فایلی که `setTimeout` را می‌شناسد.
 *
 * قرارداد (ADR-0023): `after(fn, ms)` پس از `ms` **یک بار** `fn` را صدا بزند و دستگیره‌ای بدهد که `cancel` بفهمد.
 *  - **شکستِ بسته:** `ms` غیرعددِ متناهی، منفی یا بیش از سقفِ `setTimeout` (۲³¹−۱) **می‌پرتابد**. `setTimeout` خودش در این حالت
 *    بی‌صدا به ۱ms برمی‌گردد (حلقهٔ داغ)؛ حلقه پرتاب را `SCHEDULE_FAILED` می‌کند و بی‌صدا خاموش نمی‌شود.
 *  - **بی‌پرتاب در بازگشت:** `fn` پرتاب کند فرایند با استثنای مدیریت‌نشده نمی‌میرد (حلقه خودش بی‌پرتاب است؛ این فقط کمربندِ دوم).
 *  - **لغو بی‌خطر:** `cancel` دستگیرهٔ ناشناخته، تکراری یا `undefined` را بی‌اثر می‌گیرد و فقط دستگیره‌های ساختهٔ همین زمان‌سنج را لغو می‌کند.
 *  - `unref` (پیش‌فرض روشن): تایمر فرایند را زنده نگه نمی‌دارد.
 * `scheduler` فقط برای آزمون تزریق می‌شود.
 */
import type { LoopTimer } from "@/modules/settlement";
import type { NodeTimerOptions } from "./types";

export const MAX_TIMEOUT_MS = 2_147_483_647;

export type Scheduler = Readonly<{
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}>;

const REAL: Scheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function createNodeTimer(options: NodeTimerOptions = {}, scheduler: Scheduler = REAL): LoopTimer {
  const unref = options.unref !== false;
  const live = new WeakSet<object>();
  return Object.freeze({
    after(fn: () => void, ms: number): unknown {
      if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0 || ms > MAX_TIMEOUT_MS) throw new RangeError("ms باید عددی متناهی در بازهٔ ۰ تا ۲^۳۱−۱ باشد.");
      if (typeof fn !== "function") throw new TypeError("fn باید تابع باشد.");
      const handle = scheduler.setTimeout(() => {
        try {
          fn();
        } catch {
          // قرارداد: fn نمی‌پرتابد؛ پرتابِ خطا نباید فرایند را بکشد.
        }
      }, ms);
      if (unref && typeof handle === "object" && handle !== null && typeof (handle as { unref?: unknown }).unref === "function") (handle as { unref(): unknown }).unref();
      if (typeof handle === "object" && handle !== null) live.add(handle);
      return handle;
    },
    cancel(handle: unknown): void {
      if (typeof handle !== "object" || handle === null || !live.has(handle)) return;
      live.delete(handle);
      scheduler.clearTimeout(handle);
    },
  });
}

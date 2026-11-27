/**
 * نگهبانِ رویدادِ `error` برای استخرِ مشترکِ برنامه (ADR-0084؛ بستنِ یافتهٔ ۰۰۸۲ بند ۴-۱).
 * مسئله: `EventEmitter` بدونِ شنوندهٔ `error` با رویدادِ کنترل‌نشده فرایند را می‌اندازد. دو مسیرِ واقعی در `pg`:
 *  1. **اتصالِ بی‌کار** (ری‌استارتِ PostgreSQL، `pg_terminate_backend`، قطعِ شبکه): `pg-pool` خودش شنونده‌ای روی کلاینت دارد و آن را
 *     به `pool.emit("error")` می‌رساند ⇒ بدونِ `pool.on("error")` فرایند می‌افتد.
 *  2. **اتصالِ اجاره‌شده بینِ دو دستور** (مثلاً وسطِ تراکنش): `pg-pool` هنگامِ اجاره شنوندهٔ خودش را برمی‌دارد؛ اگر در آن لحظه پرسشی در جریان
 *     نباشد، خطای کلاینت شنونده ندارد ⇒ باز هم فرایند می‌افتد. شنوندهٔ کلاینتیِ ما این را می‌گیرد؛ دستورِ بعدیِ همان اجاره‌دار با خطای خودش
 *     شکست می‌خورد (کلاینت «قابلِ‌پرسش نیست») ⇒ اجاره‌دار شکست را می‌بیند؛ ما فقط «فرایند نمی‌افتد» را تضمین می‌کنیم، نه نبودِ خطا را.
 * قواعد:
 *  - **فقط ثبت، نه بلعیدنِ بی‌اثر:** رویدادِ بسته با کدِ کوتاهِ خطا لاگ می‌شود. هرگز `message`/`stack`/رشتهٔ اتصال (ممکن است نشانی، کاربر یا رمز داشته باشد).
 *  - **هر خطا یک‌بار لاگ می‌شود:** خطای بی‌کار هم به شنوندهٔ کلاینت می‌رسد و هم به شنوندهٔ استخر (همان شیء)؛ با `WeakSet` تکرار نمی‌شود.
 *  - **نصبِ یک‌باره روی هر استخر:** نشانه روی خودِ شیءِ استخر است (`Symbol.for`)، نه حافظهٔ ماژول؛ چون در توسعه استخر روی `globalThis` می‌ماند و
 *    HMR ماژول را دوباره ارزیابی می‌کند (شنوندهٔ دوم ⇒ لاگِ دوبل و هشدارِ MaxListeners).
 *  - **لاگِ خراب (پرتاب/رد) فرایند را نمی‌اندازد** (شنوندهٔ `error` خودش نباید منبعِ خطای کنترل‌نشده باشد).
 *  - هیچ تصمیمِ بازتلاش/بستن/جایگزینی نمی‌گیرد؛ `pg-pool` خودش کلاینتِ خراب را از استخر بیرون می‌اندازد و اتصالِ بعدی تازه می‌سازد.
 * این‌جا فقط سیم‌کشی است (فقط `console` پیش‌فرضِ لاگ). رفتار با PostgreSQL واقعی در `tooling/db-pool-error-guard.pg.test.ts` سنجیده می‌شود.
 */
import type { EventEmitter } from "node:events";

/**
 * یک نوعِ رویداد برای هر دو مسیر: خطای کلاینتِ بی‌کار هم به شنوندهٔ کلاینت و هم به شنوندهٔ استخر می‌رسد و ترتیبِ آن دو جزئیاتِ `pg-pool` است؛
 * برچسبِ «بی‌کار/اجاره‌شده» از بیرون قابلِ‌اتکا نیست و برچسبِ نادرست گمراه‌کننده‌تر از نبودِ برچسب است.
 */
export type DbPoolEvent = Readonly<{ type: "db.pool.error"; code: string }>;

export type DbPoolLog = (event: DbPoolEvent) => unknown;

/** نشانهٔ نصب روی خودِ استخر؛ از دوباره‌ارزیابیِ ماژول (HMR) جان به‌در می‌برد. */
export const POOL_ERROR_GUARD_MARK = Symbol.for("legal-platform.db.pool-error-guard");

/** کد فقط اگر کوتاه و از حروفِ لاتین/رقم/خط‌زیر باشد؛ وگرنه ثابت. هرگز `message`. */
export function safePoolErrorCode(e: unknown): string {
  const c = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof c === "string" && /^[A-Za-z0-9_]{1,16}$/.test(c) ? c : "UNKNOWN";
}

/** لاگِ پیش‌فرضِ تولید: یک خطِ JSON با دامنهٔ `db`؛ همان قالبِ بقیهٔ گلو (`scope`). */
export const defaultDbPoolLog: DbPoolLog = (event) => console.error(JSON.stringify({ scope: "db", ...event }));

const safeLog = (log: DbPoolLog, event: DbPoolEvent): void => {
  try {
    const r = log(event);
    if (typeof r === "object" && r !== null && typeof (r as { then?: unknown }).then === "function") Promise.resolve(r).then(undefined, () => undefined);
  } catch {
    // لاگِ خراب نباید خودش رویدادِ کنترل‌نشده شود.
  }
};

export type PoolErrorGuardResult = Readonly<{ installed: boolean }>;

/**
 * `pool` باید `EventEmitter` باشد (`pg.Pool`). دوباره‌نصب روی همان استخر بی‌اثر است و `installed: false` برمی‌گرداند.
 * ورودیِ نامعتبر می‌پرتابد (خطای برنامه‌نویس در لحظهٔ بارگذاریِ ماژول، نه خطای زمانِ اجرا).
 */
export function installPoolErrorGuard(pool: EventEmitter, log: DbPoolLog = defaultDbPoolLog): PoolErrorGuardResult {
  if ((typeof pool !== "object" && typeof pool !== "function") || pool === null || typeof pool.on !== "function") throw new TypeError("pool");
  const marked = pool as unknown as Record<symbol, unknown>;
  if (marked[POOL_ERROR_GUARD_MARK] === true) return { installed: false };
  Object.defineProperty(pool, POOL_ERROR_GUARD_MARK, { value: true, enumerable: false, configurable: false, writable: false });

  const seen = new WeakSet<object>();
  const report = (error: unknown): void => {
    if (typeof error === "object" && error !== null) {
      if (seen.has(error)) return;
      seen.add(error);
    }
    safeLog(log, { type: "db.pool.error", code: safePoolErrorCode(error) });
  };

  // مسیرِ ۱: اتصالِ بی‌کار (pg-pool آن را به استخر می‌رساند).
  pool.on("error", (error: unknown) => report(error));
  // مسیرِ ۲: اتصالِ اجاره‌شده؛ هر کلاینتِ تازه یک شنوندهٔ دائمی می‌گیرد.
  pool.on("connect", (client: unknown) => {
    if (typeof client === "object" && client !== null && typeof (client as EventEmitter).on === "function") {
      (client as EventEmitter).on("error", (error: unknown) => report(error));
    }
  });
  return { installed: true };
}

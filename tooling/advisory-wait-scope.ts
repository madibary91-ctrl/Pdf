/**
 * «دامنهٔ انتظارِ قفلِ مشورتی» در آزمون‌های PostgreSQL (ADR-0052) — خالص: بی‌پایگاه، بی‌ساعت.
 *
 * چرا؟ `pg_locks` **سراسریِ پایگاه** است. آزمونی که می‌پرسد «کسی پشتِ قفلِ مشورتی مانده؟» با
 * `SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted` انتظارِ **فایل‌های آزمونِ دیگر** را هم می‌بیند
 * (Vitest فایل‌ها را موازی اجرا می‌کند و `regclass.pg.test.ts`، `lock-wait.pg.test.ts` و … عمداً پشتِ قفل می‌مانند).
 * نتیجه: ادعای «بک‌اندِ زامبی پس از آزادیِ قفل رفت» (`waiting === false`) فقط وقتی قرمز می‌شد که فایلِ دیگری همان لحظه
 * منتظر بود ⇒ ناپایداریِ دروازه‌ای که به کدِ محصول ربطی ندارد (ADR-0052؛ نشانهٔ «ناپایداریِ process.pg.test.ts» در تحویل ۰۰۵۱).
 * راه‌حل: فقط انتظار روی **کلیدهای همان آزمون** (`'<نام>:<شِمای یک‌بارمصرف>'`) شمرده شود. کلیدِ bigint = `classid<<32 | objid`
 * (`pg_advisory_lock(bigint)` ⇒ `objsubid = 1`).
 *
 * این فایل دو چیز می‌دهد: (۱) متنِ SQLِ دامنه‌دار (پارامتر `$1` = آرایهٔ متنیِ کلیدها)؛ (۲) `findUnscopedAdvisoryWaits` که نگهبانِ
 * منبعِ آزمون‌هاست (`tooling/advisory-wait-scope.guard.test.ts`).
 */

/** پارامتر `$1`: آرایهٔ متنیِ کلیدها (مثلاً `['settlement:migrate:pd_ab12cd34ef']`). */
export const SCOPED_ADVISORY_WAITERS_SQL =
  "SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1 AND ((classid::bigint << 32) | objid::bigint) = ANY (SELECT hashtextextended(k, 0) FROM unnest($1::text[]) AS k)";

/**
 * شمارهٔ خط‌های (۱‑مبنا) که «انتظارِ قفلِ مشورتی» را بی‌دامنه می‌پرسند. دامنه یعنی همان خط یکی از این‌ها را داشته باشد:
 * `pid =` (یک بک‌اندِ مشخص) یا `hashtextextended` (کلیدِ مشخص). قاعدهٔ خط‌به‌خط است: پرسشِ چندخطی با شرطِ «NOT granted» در خطِ
 * جدا باید شرطِ دامنه را در **همان خط** بیاورد (عمداً ساده و سخت‌گیر).
 */
export function findUnscopedAdvisoryWaits(source: string): number[] {
  const bad: number[] = [];
  source.split("\n").forEach((line, i) => {
    if (!/\bNOT\s+granted\b/i.test(line)) return;
    if (/\bpid\s*=/.test(line) || /hashtextextended/.test(line)) return;
    bad.push(i + 1);
  });
  return bad;
}

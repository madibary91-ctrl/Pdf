/**
 * فرایندِ فرزندِ آزمونِ `db-pool-error-guard.pg.test.ts` (ADR-0084) — خودش آزمون نیست (پسوندِ `.test.ts` ندارد).
 * `CHILD_MODE=guarded`: استخرِ مشترکِ واقعیِ برنامه (`@/db`)؛ `CHILD_MODE=bare`: یک `pg.Pool` بدونِ هیچ شنونده (کنترلِ منفی).
 * جریان: یک اتصالِ بی‌کار می‌سازد ⇒ `READY` چاپ می‌کند ⇒ ۱٫۵ ثانیه صبر (آزمون در این فاصله backendها را می‌کُشد) ⇒ دوباره می‌پرسد.
 * اگر فرایند تا آن‌جا زنده بماند `RECOVERED` چاپ می‌شود؛ وگرنه رویدادِ `error`ِ کنترل‌نشده آن را با کدِ خروجِ غیرصفر می‌اندازد.
 */
export {};

const mode = process.env["CHILD_MODE"];
const url = process.env["DATABASE_URL"];
if (url === undefined || (mode !== "guarded" && mode !== "bare")) {
  console.error("CHILD_BAD_ENV");
  process.exit(2);
}

const pool =
  mode === "guarded"
    ? (await import("@/db")).pool
    : new (await import("pg")).default.Pool({ connectionString: url });

await pool.query("SELECT 1");
console.log("READY");
await new Promise((r) => setTimeout(r, 1500));
const r = await pool.query("SELECT 1 AS ok");
console.log(r.rows[0]?.ok === 1 ? "RECOVERED" : "WRONG");
await pool.end();

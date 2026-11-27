/**
 * پورت‌های PostgreSQLِ واقعیِ tool-policy-grants (ADR-0081) — گلوی بی‌منطق؛ هم CLI و هم آزمون‌های PostgreSQLِ واقعی از همین‌جا می‌گیرند
 * (تا آنچه آزموده می‌شود دقیقاً همان چیزی باشد که اجرا می‌شود). ماژول SQLِ اجرایی ندارد: متنِ پرس‌وجوها و دستورها را خودش می‌سازد و اینجا فقط اجرا می‌شوند.
 *  - `query`: تراکنشِ `BEGIN READ ONLY` ← پرس‌وجو ← `ROLLBACK` (حتی اگر خودِ پرس‌وجو بنویسد، پایگاه رد می‌کند).
 *  - `transact`: `BEGIN` ← همهٔ دستورها ← `COMMIT`؛ خطا ⇒ `ROLLBACK` (همه یا هیچ) و اتصالِ مشکوک دور ریخته می‌شود.
 * `DATABASE_URL` فقط به `pg.Pool` می‌رسد و هرگز چاپ نمی‌شود.
 */
import pg from "pg";

/** سقفِ ساختنِ اتصال؛ مهلتِ کلِ فرمان جداست (`--timeout-ms`). */
export const CONNECT_TIMEOUT_MS = 10_000;
/**
 * سقفِ سمتِ سرور (≥ بیشینهٔ `--timeout-ms` = ۶۰۰٬۰۰۰): PostgreSQL مردنِ کلاینت را تا بیدارشدنِ بک‌اندِ منتظرِ قفل نمی‌فهمد؛
 * بدونِ این، پس از مهلت/SIGTERM بک‌اندِ «زامبی» تا آزادشدنِ قفل در صف می‌ماند.
 */
export const SERVER_TIMEOUT_MS = 600_000;

export type GrantsPool = pg.Pool;

export function openGrantsDatabase(connectionString: string | undefined, idleTimeoutMillis?: number): { db: GrantsPool; close: () => Promise<void> } {
  const pool = new pg.Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    ...(idleTimeoutMillis === undefined ? {} : { idleTimeoutMillis }),
    application_name: "tool-policy-grants",
    options: `-c lock_timeout=${SERVER_TIMEOUT_MS} -c statement_timeout=${SERVER_TIMEOUT_MS}`,
  });
  pool.on("error", () => undefined); // خطای اتصالِ بیکار نباید فرایند را با استثنای رسیدگی‌نشده بکُشد.
  return { db: pool, close: () => pool.end() };
}

export async function grantsQuery(db: unknown, text: string, params: readonly string[]): Promise<{ rows: unknown[] }> {
  const client = await (db as GrantsPool).connect();
  let failure: unknown;
  try {
    await client.query("BEGIN READ ONLY");
    const res = await client.query(text, [...params]);
    await client.query("ROLLBACK");
    return { rows: res.rows };
  } catch (e) {
    failure = e ?? new Error("query failed");
    throw e;
  } finally {
    client.release(failure === undefined ? undefined : true);
  }
}

export async function grantsTransact(db: unknown, statements: readonly string[]): Promise<void> {
  const client = await (db as GrantsPool).connect();
  let failure: unknown;
  try {
    await client.query("BEGIN");
    for (const s of statements) await client.query(s);
    await client.query("COMMIT");
  } catch (e) {
    failure = e ?? new Error("transaction failed");
    try {
      await client.query("ROLLBACK");
    } catch {
      // اتصال دور ریخته می‌شود؛ پایگاه خودش تراکنشِ بی‌پایان را برمی‌گرداند.
    }
    throw e;
  } finally {
    client.release(failure === undefined ? undefined : true);
  }
}

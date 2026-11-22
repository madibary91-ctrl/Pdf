/**
 * گلوی CLIِ نمایهٔ «مرده‌های در انتظارِ تأیید» (ADR-0047) — تنها جایی که `process`، `pg` و drizzle کنار هم می‌آیند؛ هیچ منطقی ندارد:
 * آرگومان‌ها، سیاستِ env، ترتیبِ مهاجرت، مهلت، کدهای خروج و گزارش همه در `src/modules/settlement-pending-migrate` (آزموده) است.
 *
 * اجرا (از ریشهٔ مخزن؛ بدون وابستگیِ تازه، Node ≥ 22.18؛ پیش‌نیاز: `npm run settlement:migrate -- up`):
 *   DATABASE_URL=… npm run settlement:pending -- status
 *   DATABASE_URL=… npm run settlement:pending -- up --timeout-ms=120000
 *   DATABASE_URL=… npm run settlement:pending -- verify
 *   DATABASE_URL=… npm run settlement:pending -- down --yes     (برگشتِ رسمی؛ ADR-0049؛ بی‌--yes خطای آرگومان)
 * یا مستقیم:  node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tooling/cli/register.mjs tooling/cli/settlement-pending-migrate.ts status
 *
 * stdout: دقیقاً یک خطِ JSON (گزارشِ بسته)؛ stderr خالی است. `DATABASE_URL` فقط از محیطِ فرایند خوانده می‌شود (فایل `.env` را این ابزار نمی‌خواند؛
 * با `node --env-file=.env` یا orchestrator بدهید) و هرگز چاپ نمی‌شود. پایانِ فرایند همیشه صریح است (اتصالِ آویزان نباید استقرار را نگه دارد).
 */
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { runPendingMigrate } from "@/modules/settlement-pending-migrate";
import { createNodeTimer } from "@/modules/settlement-runtime";

/** سقفِ ساختنِ اتصال؛ مهلتِ کلِ فرمان جداست (`--timeout-ms`). */
const CONNECT_TIMEOUT_MS = 10_000;
/**
 * سقفِ سمتِ سرور (≥ بیشینهٔ `--timeout-ms` = ۶۰۰٬۰۰۰) برای انتظارِ قفلِ مشورتی و هر دستور: PostgreSQL مردنِ کلاینت را تا بیدار‌شدنِ بک‌اندِ منتظر نمی‌فهمد؛
 * بدونِ این، پس از مهلت/SIGTERM بک‌اندِ «زامبی» می‌ماند. (`lock_timeout` ی ۱۵ثانیه‌ایِ backfill خودش درونِ مهاجرت `SET LOCAL` می‌شود و بر این غالب است.)
 */
const SERVER_TIMEOUT_MS = 600_000;

const flushes: Promise<void>[] = [];

function openDatabase(): { db: unknown; close: () => Promise<void> } {
  const pool = new pg.Pool({
    connectionString: process.env["DATABASE_URL"],
    max: 1,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    application_name: "settlement-pending-migrate",
    options: `-c lock_timeout=${SERVER_TIMEOUT_MS} -c statement_timeout=${SERVER_TIMEOUT_MS}`,
  });
  pool.on("error", () => undefined); // خطای اتصالِ بیکار نباید فرایند را با استثنای رسیدگی‌نشده بکُشد.
  return { db: drizzle(pool), close: () => pool.end() };
}

async function main(): Promise<number> {
  const outcome = await runPendingMigrate({
    argv: process.argv.slice(2),
    env: process.env,
    ports: {
      open: openDatabase,
      timer: createNodeTimer({ unref: false }),
      write: (line: string) => {
        flushes.push(new Promise<void>((resolve) => process.stdout.write(line, () => resolve())));
      },
    },
  });
  await Promise.all(flushes);
  return outcome.exitCode;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(1),
);

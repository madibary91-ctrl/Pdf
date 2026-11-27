/**
 * گلوی CLIِ رسمیِ مهاجرتِ شِمای نسخه‌های سیاستِ ابزار (ADR-0080) — تنها جایی که `process`، `pg` و drizzle کنار هم می‌آیند؛ هیچ منطقی ندارد:
 * آرگومان‌ها، سیاستِ env، ترتیبِ کارها، مهلت، کدهای خروج و گزارش همه در `src/modules/tool-policy-migrate` (آزموده) است.
 *
 * اجرا (از ریشهٔ مخزن؛ بدون وابستگیِ تازه، Node ≥ 22.18):
 *   DATABASE_URL=… npm run policy:migrate -- status
 *   DATABASE_URL=… npm run policy:migrate -- up --create-schema --timeout-ms=120000
 * یا مستقیم:  node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tooling/cli/register.mjs tooling/cli/tool-policy-migrate.ts up
 *
 * **نقشِ مهاجرت جداست:** `DATABASE_URL` اینجا باید رشتهٔ اتصالِ نقشِ مدیر/مهاجرت (حقِ DDL و در صورت نیاز `CREATE` روی پایگاه) باشد، نه نقشِ زمانِ اجرای برنامه؛
 * برنامه (`tool-policy-bootstrap`) هرگز DDL نمی‌زند. stdout: دقیقاً یک خطِ JSON (گزارشِ بسته)؛ stderr خالی است. `DATABASE_URL` فقط از محیطِ فرایند خوانده می‌شود
 * (فایل `.env` را این ابزار نمی‌خواند) و هرگز چاپ نمی‌شود. پایانِ فرایند همیشه صریح است (اتصالِ آویزان نباید استقرار را نگه دارد).
 */
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { runToolPolicyMigrate } from "@/modules/tool-policy-migrate";
import { createNodeTimer } from "@/modules/settlement-runtime";

/** سقفِ ساختنِ اتصال؛ مهلتِ کلِ فرمان جداست (`--timeout-ms`). */
const CONNECT_TIMEOUT_MS = 10_000;
/**
 * سقفِ سمتِ سرور برای انتظارِ قفل (≥ بیشینهٔ `--timeout-ms` = ۶۰۰٬۰۰۰): PostgreSQL مردنِ کلاینت را تا بیدار‌شدنِ بک‌اندِ منتظرِ قفل نمی‌فهمد؛
 * بدونِ این، پس از مهلت/SIGTERM بک‌اندِ «زامبی» تا آزادشدنِ قفلِ مهاجرتِ دیگر در صف می‌ماند.
 */
const SERVER_LOCK_TIMEOUT_MS = 600_000;

const flushes: Promise<void>[] = [];

function openDatabase(): { db: unknown; close: () => Promise<void> } {
  const pool = new pg.Pool({ connectionString: process.env["DATABASE_URL"], max: 1, connectionTimeoutMillis: CONNECT_TIMEOUT_MS, application_name: "tool-policy-migrate", options: `-c lock_timeout=${SERVER_LOCK_TIMEOUT_MS}` });
  pool.on("error", () => undefined); // خطای اتصالِ بیکار نباید فرایند را با استثنای رسیدگی‌نشده بکُشد.
  return { db: drizzle(pool), close: () => pool.end() };
}

/**
 * تنها DDLِ ابزار (ADR-0080 تصمیم ۳): ماژول SQL ندارد. `schema` را ذخیره‌سازِ سیاست پیش‌تر با فهرست‌سفید اعتبارسنجی کرده است و اینجا فقط با
 * `sql.identifier` نقل‌قول می‌شود؛ پیمانِ `schema-ensure-key-parity` (ADR-0037) فقط `src/` را می‌پوید و این گلو بیرون از آن است.
 * مسابقهٔ هم‌زمانِ دو CLI روی یک شِما (`23505`) را `execute` با بازتلاشِ کران‌دار می‌پذیرد.
 */
const createSchema = (db: unknown, schema: string): unknown => (db as { execute(query: ReturnType<typeof sql>): PromiseLike<unknown> }).execute(sql`CREATE SCHEMA IF NOT EXISTS ${sql.identifier(schema)}`);

async function main(): Promise<number> {
  const outcome = await runToolPolicyMigrate({
    argv: process.argv.slice(2),
    env: process.env,
    ports: {
      open: openDatabase,
      createSchema,
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

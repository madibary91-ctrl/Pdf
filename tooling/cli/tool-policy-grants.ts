/**
 * گلوی CLIِ حقوقِ نقشِ زمانِ اجرای سیاستِ ابزار (ADR-0081) — تنها جایی که `process` و `pg` کنار هم می‌آیند؛ هیچ منطقی ندارد:
 * آرگومان‌ها، سیاستِ env، طرحِ GRANT/REVOKE، سنجشِ حقوقِ مؤثر، مهلت، کدهای خروج و گزارش همه در `src/modules/tool-policy-grants` (آزموده) است.
 *
 * اجرا (از ریشهٔ مخزن؛ بدون وابستگیِ تازه، Node ≥ 22.18):
 *   npm run policy:grants -- plan --role=policy_runtime
 *   DATABASE_URL=… npm run policy:grants -- verify --role=policy_runtime
 *   DATABASE_URL=… npm run policy:grants -- apply  --role=policy_runtime --timeout-ms=120000
 *
 * **نقشِ مدیر جداست:** `DATABASE_URL` اینجا رشتهٔ اتصالِ نقشِ مدیر/مهاجرت (مالکِ شِما یا دارندهٔ GRANT OPTION) است، نه نقشِ زمانِ اجرا؛ نقشِ زمانِ اجرا
 * با `--role` نام برده می‌شود و باید از پیش (با `CREATE ROLE`، کارِ مدیر) وجود داشته باشد؛ این ابزار نقش نمی‌سازد و رمز نمی‌گذارد.
 * stdout: دقیقاً یک خطِ JSON (گزارشِ بسته)؛ stderr خالی است. `DATABASE_URL` فقط از محیطِ فرایند خوانده می‌شود (فایل `.env` خوانده نمی‌شود)
 * و هرگز چاپ نمی‌شود. پایانِ فرایند همیشه صریح است.
 */
import { createNodeTimer } from "@/modules/settlement-runtime";
import { runToolPolicyGrants } from "@/modules/tool-policy-grants";
import { grantsQuery, grantsTransact, openGrantsDatabase } from "./grants-pg";

const flushes: Promise<void>[] = [];

async function main(): Promise<number> {
  const outcome = await runToolPolicyGrants({
    argv: process.argv.slice(2),
    env: process.env,
    ports: {
      open: () => openGrantsDatabase(process.env["DATABASE_URL"]),
      query: grantsQuery,
      transact: grantsTransact,
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

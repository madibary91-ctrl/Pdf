/**
 * گلوی CLIِ اندازه‌گیریِ هزینهٔ پایشِ پسماند (ADR-0044) — تنها جایی که `process` و `pg` کنار هم می‌آیند؛ منطق در
 * `tooling/backlog-cost.ts` (خالص، آزموده) و `tooling/backlog-cost-measure.ts` (آزمودهٔ روی PostgreSQLِ واقعی) است.
 *
 * اجرا (از ریشهٔ مخزن؛ Node ≥ 22.18؛ پایگاهِ **غیرتولیدی**، چون چند صد هزار ردیفِ موقت می‌نویسد، هرچند فقط در شِمای یک‌بارمصرف):
 *   DATABASE_URL=… node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tooling/cli/register.mjs tooling/cli/backlog-cost.ts --scales=1000,10000,100000 --format=text
 *
 * stdout: گزارش (یک خطِ JSON یا متنِ جدولی)؛ stderr: فقط یک کدِ بسته در خطا. `DATABASE_URL` فقط از محیط خوانده و هرگز چاپ نمی‌شود.
 * کدِ خروج: ۰ حکمِ ok/warn؛ ۱ حکمِ fail (خواندن از مهلتِ پایش گذشته)؛ ۲ آرگومانِ نامعتبر؛ ۳ خطای اندازه‌گیری/پایگاه.
 * پایانِ فرایند همیشه صریح است (اتصالِ آویزان نباید ابزار را نگه دارد).
 */
import pg from "pg";
import { measureBacklogCost } from "../backlog-cost-measure";
import { parseCostArgs, renderText } from "../backlog-cost";

const EXIT = Object.freeze({ ok: 0, fail: 1, usage: 2, error: 3 });

const writes: Promise<void>[] = [];
const write = (stream: NodeJS.WriteStream, text: string): void => {
  writes.push(new Promise<void>((resolve) => stream.write(text, () => resolve())));
};

async function main(): Promise<number> {
  const args = parseCostArgs(process.argv.slice(2));
  if (!args.ok) {
    write(process.stderr, `${JSON.stringify({ ok: false, code: args.error.code, flag: args.error.flag })}\n`);
    return EXIT.usage;
  }
  const url = process.env["DATABASE_URL"];
  if (typeof url !== "string" || url === "") {
    write(process.stderr, `${JSON.stringify({ ok: false, code: "DATABASE_URL_MISSING" })}\n`);
    return EXIT.usage;
  }
  const pool = new pg.Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 10_000, application_name: "backlog-cost" });
  pool.on("error", () => undefined);
  try {
    const out = await measureBacklogCost({ pool }, args.value);
    if (!out.ok) {
      write(process.stderr, `${JSON.stringify({ ok: false, code: out.error.code })}\n`);
      return EXIT.error;
    }
    write(process.stdout, args.value.format === "text" ? renderText(out.value) : `${JSON.stringify(out.value)}\n`);
    return out.value.verdict.status === "fail" ? EXIT.fail : EXIT.ok;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().then(
  async (code) => {
    await Promise.all(writes);
    process.exit(code);
  },
  () => process.exit(EXIT.error),
);

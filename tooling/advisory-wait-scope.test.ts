/**
 * نگهبانِ «دامنهٔ انتظارِ قفلِ مشورتی» (ADR-0052) — بی‌پایگاه، همیشه اجرا می‌شود.
 * بخشِ ۱: رفتارِ تابعِ خالص؛ بخشِ ۲: هیچ آزمونِ مخزن انتظارِ مشورتی را بی‌دامنه نمی‌پرسد؛ بخشِ ۳: سه فایلِ اصلاح‌شده دقیقاً SQLِ مشترک را دارند.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { findUnscopedAdvisoryWaits, SCOPED_ADVISORY_WAITERS_SQL } from "./advisory-wait-scope";

const ROOT = join(__dirname, "..");
const SELF = new Set(["tooling/advisory-wait-scope.test.ts", "tooling/advisory-wait-scope.pg.test.ts"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

describe("findUnscopedAdvisoryWaits · رفتار", () => {
  it("پرسشِ سراسری ⇒ شمارهٔ خط", () => {
    const src = ["a", "q(\"SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted\")", "b"].join("\n");
    expect(findUnscopedAdvisoryWaits(src)).toEqual([2]);
  });
  it("حروفِ کوچک/فاصلهٔ چندگانه هم گرفته می‌شود", () => {
    expect(findUnscopedAdvisoryWaits("x not   GRANTED y")).toEqual([1]);
  });
  it("دامنه با pid یا با کلیدِ هش ⇒ پاک", () => {
    expect(findUnscopedAdvisoryWaits("WHERE pid = $1 AND locktype = 'advisory' AND NOT granted")).toEqual([]);
    expect(findUnscopedAdvisoryWaits("NOT granted AND objid = hashtextextended($1, 0)")).toEqual([]);
  });
  it("SQLِ مشترک خودش دامنه‌دار است و دو کلیدِ ناهمنام را نمی‌پذیرد مگر با آرایه", () => {
    expect(findUnscopedAdvisoryWaits(SCOPED_ADVISORY_WAITERS_SQL)).toEqual([]);
    expect(SCOPED_ADVISORY_WAITERS_SQL).toContain("$1::text[]");
  });
  it("هر خطِ بی‌دامنه جدا گزارش می‌شود و شمارشِ خط‌ها دقیق است", () => {
    const src = "NOT granted\nok pid = 1 NOT granted\nNOT granted";
    expect(findUnscopedAdvisoryWaits(src)).toEqual([1, 3]);
  });
});

describe("نگهبانِ مخزن (ADR-0052)", () => {
  const files = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "tooling"))].map((p) => relative(ROOT, p).split("\\").join("/")).filter((p) => !SELF.has(p));

  it("فهرستِ فایل‌ها تهی نیست (نگهبانِ پوچ نیست)", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("هیچ آزمونی انتظارِ قفلِ مشورتی را بی‌دامنه (سراسریِ پایگاه) نمی‌پرسد", () => {
    const offenders = files.flatMap((f) => findUnscopedAdvisoryWaits(readFileSync(join(ROOT, f), "utf8")).map((line) => `${f}:${line}`));
    expect(offenders).toEqual([]);
  });

  it("سه فایلِ فرایندِ واقعی دقیقاً SQLِ دامنه‌دارِ مشترک را به‌کار می‌برند (نه نسخهٔ دست‌کاری‌شده)", () => {
    const expected: Record<string, number> = {
      "src/modules/settlement-migrate/process.pg.test.ts": 2,
      "src/modules/settlement-pending-migrate/process.pg.test.ts": 2,
      "src/modules/settlement-pending-migrate/down.process.pg.test.ts": 2,
    };
    for (const [file, count] of Object.entries(expected)) {
      const source = readFileSync(join(ROOT, file), "utf8");
      expect(source.split(JSON.stringify(SCOPED_ADVISORY_WAITERS_SQL)).length - 1, file).toBe(count);
    }
  });
});

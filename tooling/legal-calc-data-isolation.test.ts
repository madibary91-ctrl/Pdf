import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * قاعدهٔ «فقط فایل داده برای اعداد»: در ماژول legal-calc هیچ فایلی جز فایل‌های داده (`*-tariffs.ts` برای نرخ‌ها،
 * `*-indices.ts` برای شاخص‌ها و قاعده‌های تأخیر تأدیه، `*-shares.ts` برای کسرهای ارث) نباید عدد حقوقی (نرخ، آستانه، مبلغ ثابت، شاخص) را در کد داشته باشد.
 * تغییر قانون یا جدول باید فقط فایل داده را عوض کند. هر فایل داده باید هشدار «تأیید حقوقدان» را بالای خود داشته باشد.
 *
 * عددهای مجاز در کد: ۰، ۱، ۲ (شمارندهٔ فنی/نصف) و ۱۰۰۰۰ (مخرج تبدیل نقطهٔ مبنا).
 * اضافه‌کردن هر عدد دیگر به این فهرست = تصمیم آگاهانه و بازبینی حقوقدان.
 */
const ALLOWED = new Set(["0", "1", "2", "10000"]);
const DIR = join(__dirname, "..", "src", "modules", "legal-calc");
const DATA_FILE_RE = /-(tariffs|indices|shares)\.ts$/;
const DATA_FILES = ["court-fee-tariffs.ts", "late-payment-indices.ts", "inheritance-shares.ts"] as const;

function stripNoise(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ") // کامنت بلوکی
    .replace(/(^|[^:])\/\/.*$/gm, "$1") // کامنت خطی
    .replace(/`(?:\\.|[^`\\])*`/g, "``") // قالب‌های رشته‌ای
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''");
}

// lookbehind با target=ES2017 مجاز نیست (known-pitfalls)؛ پس نویسهٔ قبلی را در گروه می‌گیریم.
const NUMBER_RE = "(^|[^\\w.$])(\\d[\\d_]*(?:\\.\\d+)?)(?![\\w$])";

function numericLiterals(code: string): string[] {
  return Array.from(code.matchAll(new RegExp(NUMBER_RE, "g")), (m) => (m[2] as string).replace(/_/g, ""));
}

describe("tooling: جداسازی اعداد حقوقی legal-calc", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !DATA_FILE_RE.test(f));

  it.each(DATA_FILES)("%s: وجود دارد و کامنت هشدار تأیید حقوقدان در بالای آن است", (file) => {
    const text = readFileSync(join(DIR, file), "utf8");
    const head = text.slice(0, 1200);
    expect(head).toContain("باید توسط حقوقدان تأیید شوند");
    expect(head).toContain("MUST BE VERIFIED BY A QUALIFIED LAWYER");
  });

  it("هر فایل داده در پوشه (با الگوی *-tariffs.ts یا *-indices.ts) در فهرست بالا هست — فایل داده‌ای بی‌هشدار جا نمی‌ماند", () => {
    const onDisk = readdirSync(DIR).filter((f) => DATA_FILE_RE.test(f));
    expect([...onDisk].sort()).toEqual([...DATA_FILES].sort());
  });

  it("فایل‌های کد پیدا شدند", () => {
    expect(files).toContain("court-fee.ts");
    expect(files).toContain("late-payment.ts");
    expect(files).not.toContain("court-fee-tariffs.ts");
    expect(files).not.toContain("late-payment-indices.ts");
    expect(files).toContain("inheritance.ts");
    expect(files).not.toContain("inheritance-shares.ts");
  });

  it.each(files)("%s: بدون عدد حقوقیِ سخت‌کد", (file) => {
    const code = stripNoise(readFileSync(join(DIR, file), "utf8"));
    const bad = numericLiterals(code).filter((n) => !ALLOWED.has(n));
    expect(bad, `عددهای غیرمجاز در ${file}`).toEqual([]);
  });

  it("خودِ بررسی‌گر کار می‌کند: عدد سخت‌کد را می‌گیرد و کامنت/رشته را نادیده می‌گیرد", () => {
    const sample = stripNoise('const a = 350; // 999\n/* 777 */ const s = "88"; const t = `55`; const b = 0;');
    expect(numericLiterals(sample)).toEqual(["350", "0"]);
  });
});

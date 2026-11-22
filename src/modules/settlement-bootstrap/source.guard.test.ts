/**
 * نگهبانِ منبعِ سیم‌کشیِ منبعِ خواندنِ پایش (ADR-0051): ناورداهایی که رفتارِ زمان‌اجرا به آن‌ها تکیه دارد و جهشی/بازبین باید قرمزشان کند.
 * فایلِ تازه؛ `purity.test.ts` و `backlog-source.test.ts` همچنان فرمانروای کلیِ ماژول‌اند.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const strip = (c: string): string => c.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
const src = (n: string): string => strip(readFileSync(join(__dirname, n), "utf8"));
const bootstrap = src("bootstrap.ts");
const env = src("env.ts");
const count = (code: string, re: RegExp): number => (code.match(re) ?? []).length;

describe("settlement-bootstrap · نگهبانِ منبع · منبعِ پایش (ADR-0051)", () => {
  it("منبع فقط با یک سه‌تاییِ صریح انتخاب می‌شود؛ نمایه و outbox هر کدام فقط یک‌جا ساخته می‌شوند (بی‌مسیرِ بازگشتِ پنهان)", () => {
    expect(count(bootstrap, /createPendingDeadIndex\(/g)).toBe(1);
    expect(count(bootstrap, /createPgSettlementOutbox\(/g)).toBe(1);
    expect(bootstrap).toMatch(
      /const outbox =\s*settings\.backlog\.source === "pending"\s*\? createPendingDeadIndex\(opened\.db as never, readOptions\)\s*: createPgSettlementOutbox\(opened\.db as never, readOptions\);/,
    );
    expect(bootstrap).toMatch(/if \(!outbox\.ok\) \{\s*await closeQuietly\(opened\);\s*return failure\("BACKLOG_INVALID"/);
  });

  it("هر دو منبع یک `readOptions` (شِما + سقفِ سمتِ پایگاه) می‌گیرند؛ سقف فقط از backlogReadStatementTimeoutMs می‌آید", () => {
    expect(bootstrap).toMatch(/const readOptions = \{\s*schema: settings\.settlementSchema \?\? SETTLEMENT_DEFAULT_SCHEMA,\s*\.\.\.\(readTimeoutMs === undefined \? \{\} : \{ readStatementTimeoutMs: readTimeoutMs \}\),\s*\};/);
    expect(count(bootstrap, /backlogReadStatementTimeoutMs\(settings\.backlog\.overrides\)/g)).toBe(1);
  });

  it("bootstrap هرگز نمایه را نصب/برنمی‌گرداند/راستی‌آزمایی نمی‌کند و وضعیتِ مهاجرتش را نمی‌خواند (نصب = CLIِ صریح؛ بوت فقط می‌خواند)", () => {
    for (const re of [/\.migrate\s*\(/, /\.down\s*\(/, /\.verify\s*\(/, /\.status\s*\(/]) expect(bootstrap).not.toMatch(re);
  });

  it("نتیجهٔ بوتِ رفتگر به منبع وابسته نیست: `source` فقط در ساختنِ outbox و در sourceTag لاگ خوانده می‌شود", () => {
    expect(count(bootstrap, /\.source\b/g)).toBe(2);
    expect(bootstrap).toMatch(/const sourceTag: \{ source\?: "pending" \} = settings\.backlog\?\.source === "pending" \? \{ source: "pending" \} : \{\};/);
    expect(count(bootstrap, /\.\.\.sourceTag/g)).toBe(3);
  });

  it("env: نامِ متغیر سخت‌کدِ یک‌جا؛ مقدارِ نامعتبر و بی‌پایش هر دو خطا؛ خروجی فقط برای pending کلیدِ source می‌گیرد", () => {
    expect(env).toMatch(/export const ENV_BACKLOG_SOURCE = "SETTLEMENT_BACKLOG_SOURCE";/);
    expect(env).toMatch(/sourceRaw !== "outbox" && sourceRaw !== "pending"/);
    expect(env).toMatch(/else if \(!watchOn\) issues\.push/);
    expect(env).toMatch(/else if \(sourceRaw === "pending" && backlog !== undefined\) backlog = Object\.freeze\(\{ \.\.\.backlog, source: "pending" as const \}\);/);
    expect(env).not.toMatch(/source: "outbox"/); // پیش‌فرض بی‌کلید می‌ماند
  });

  it("index.ts نه منبع را صادر می‌کند نه ماژولِ settlement-pending را", () => {
    expect(src("index.ts")).not.toMatch(/settlement-pending|BACKLOG_SOURCE|ENV_BACKLOG_SOURCE/);
  });
});

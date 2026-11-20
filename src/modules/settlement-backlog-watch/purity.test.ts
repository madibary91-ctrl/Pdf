/**
 * نگهبان منبع settlement-backlog-watch (ADR-0042): فقط رابطِ عمومیِ `settlement` و `settlement-backlog`؛ بی‌ساعت/تایمرِ سراسری/تصادف/محیط/شبکه/فایل؛
 * بی‌پایگاهِ مستقیم؛ بی‌اسرار؛ فقط‌خواندنی (به هیچ متدِ outbox مستقیم دست نمی‌زند)؛ `catch` بی‌متغیر (نشتِ پیام ممکن نیست).
 * فقط فایل‌های محصول (نه *.test.ts و کمک‌تست‌ها).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as api from "./index";

const DIR = __dirname;
const NON_PRODUCT = new Set(["test-kit.ts"]);
const strip = (c: string): string => c.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
const sources = readdirSync(DIR)
  .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && !NON_PRODUCT.has(n))
  .map((n) => ({ name: n, code: strip(readFileSync(join(DIR, n), "utf8")) }));

describe("settlement-backlog-watch · نگهبان منبع", () => {
  it("فهرست فایل‌های منبع شناخته‌شده است (فایل تازه باید آگاهانه اضافه شود)", () => {
    expect(sources.map((s) => s.name).sort()).toEqual(["config.ts", "env.ts", "index.ts", "probe.ts", "types.ts", "view.ts", "watch.ts"]);
  });

  it("هیچ فایلی از Date، Math.random، fetch، process، تایمرِ سراسری، performance، require، eval، console، crypto یا import() استفاده نمی‌کند", () => {
    const forbidden: [string, RegExp][] = [
      ["Date", /\bDate\b/],
      ["Math.random", /Math\s*\.\s*random/],
      ["fetch", /\bfetch\s*\(/],
      ["process", /(?<![\w-])process(?![\w-])/],
      ["globalThis", /\bglobalThis\b/],
      ["setTimeout/Interval", /\b(set|clear)(Timeout|Interval|Immediate)\b/],
      ["performance", /\bperformance\b/],
      ["require", /\brequire\s*\(/],
      ["eval/Function", /\b(eval|new\s+Function)\b/],
      ["console", /\bconsole\b/],
      ["crypto", /\bcrypto\b/],
      ["import()", /import\s*\(/],
    ];
    for (const s of sources) for (const [label, re] of forbidden) expect(s.code, `${s.name}: ${label}`).not.toMatch(re);
  });

  it("importها فقط: رابط عمومیِ settlement و settlement-backlog و فایل‌های نسبیِ همین ماژول (بی‌deep import، بی‌پایگاه، بی‌node:)", () => {
    for (const s of sources) {
      for (const m of s.code.matchAll(/from\s+["']([^"']+)["']/g)) {
        const spec = m[1] as string;
        expect(spec === "@/modules/settlement" || spec === "@/modules/settlement-backlog" || /^\.\/[a-z-]+$/.test(spec), `${s.name}: ${spec}`).toBe(true);
      }
      expect(s.code, s.name).not.toMatch(/\b(pg|drizzle-orm|@\/db)\b/);
    }
  });

  it("به هیچ متدِ outbox مستقیم دست نمی‌زند (خواندن فقط از راهِ createDeadLetterBacklogMonitor)", () => {
    for (const s of sources) {
      expect(s.code, s.name).not.toMatch(/\boutbox\s*\.\s*[A-Za-z]+/);
      expect(s.code, s.name).not.toMatch(/\.\s*(begin|recordCharge|recordClose|resolveClose|finish|recordFailure|bury|acknowledgeDead|claimDue|listUnacknowledgedDead|migrate)\s*\(/);
    }
  });

  it("catch همیشه بی‌متغیر است (پیامِ خطا هرگز خوانده نمی‌شود، پس نمی‌تواند نشت کند)", () => {
    for (const s of sources) {
      expect(s.code, s.name).not.toMatch(/catch\s*\(/);
      expect(s.code, s.name).not.toMatch(/\.\s*(message|stack)\b/);
    }
  });

  it("رشتهٔ اتصال، کلید یا اسرار در کد نیست", () => {
    for (const s of sources) expect(s.code, s.name).not.toMatch(/postgres(ql)?:\/\/|sk-[A-Za-z0-9]{10,}|api[_-]?key|password/i);
  });

  it("رابط عمومی فقط نام‌های اعلام‌شده را صادر می‌کند", () => {
    expect(Object.keys(api).sort()).toEqual([
      "SETTLEMENT_BACKLOG_WATCH_DEFAULTS",
      "SETTLEMENT_BACKLOG_WATCH_ENV",
      "SETTLEMENT_BACKLOG_WATCH_LIMITS",
      "createBacklogWatch",
      "parseBacklogWatchEnv",
      "projectBacklogForProbe",
    ]);
  });

  it("هیچ تستی در این ماژول .skip/.only/xit/todo ندارد", () => {
    for (const n of readdirSync(DIR).filter((f) => f.endsWith(".test.ts") && f !== "purity.test.ts")) {
      expect(readFileSync(join(DIR, n), "utf8"), n).not.toMatch(/\.(skip|only|todo)\s*\(|\bxit\s*\(|\bxdescribe\s*\(/);
    }
  });
});

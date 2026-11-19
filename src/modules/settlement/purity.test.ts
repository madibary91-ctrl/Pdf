/**
 * نگهبان منبع settlement (ADR-0021): فقط `@/modules/ledger` و `@/modules/metering` (رابط عمومی)؛ بی‌ساعت/تصادف/محیط/شبکه/ورودی‌خروجیِ مستقیم؛
 * بی‌پایگاه (outbox و دفتر تزریق می‌شوند)؛ بی‌اسرار. فقط فایل‌های محصول (نه *.test.ts و کمک‌تست‌ها).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as api from "./index";

const DIR = __dirname;
const NON_PRODUCT = new Set(["test-kit.ts", "test-db.ts", "outbox-contract.ts"]);
const strip = (c: string): string => c.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
const sources = readdirSync(DIR)
  .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && !NON_PRODUCT.has(n))
  .map((n) => ({ name: n, code: strip(readFileSync(join(DIR, n), "utf8")) }));

describe("settlement · نگهبان منبع", () => {
  it("فهرست فایل‌های منبع شناخته‌شده است (فایل تازه باید آگاهانه اضافه شود)", () => {
    expect(sources.map((s) => s.name).sort()).toEqual(["config.ts", "decorated.ts", "durable-gateway.ts", "durable-ledger.ts", "health.ts", "index.ts", "loop-policy.ts", "memory-outbox.ts", "ports.ts", "sweep-loop.ts", "sweeper.ts", "types.ts", "validate.ts"]);
  });
  it("هیچ فایلی از Date، Math.random، fetch، process، تایمر، performance، require، eval، console یا crypto استفاده نمی‌کند", () => {
    const forbidden: [string, RegExp][] = [
      ["Date", /\bDate\b/],
      ["Math.random", /Math\s*\.\s*random/],
      ["fetch", /\bfetch\s*\(/],
      ["process", /\bprocess\b/],
      ["setTimeout/Interval", /\bset(Timeout|Interval|Immediate)\b/],
      ["performance", /\bperformance\b/],
      ["require", /\brequire\s*\(/],
      ["eval/Function", /\b(eval|new\s+Function)\b/],
      ["console", /\bconsole\b/],
      ["crypto", /\bcrypto\b/],
    ];
    for (const s of sources) for (const [label, re] of forbidden) expect(s.code, `${s.name}: ${label}`).not.toMatch(re);
  });
  it("importها فقط: رابط عمومی ledger و metering و فایل‌های نسبیِ همین ماژول (بی‌deep import، بی‌پایگاه، بی‌node:)", () => {
    for (const s of sources) {
      for (const m of s.code.matchAll(/from\s+["']([^"']+)["']/g)) {
        const spec = m[1] as string;
        expect(spec === "@/modules/ledger" || spec === "@/modules/metering" || /^\.\/[a-z-]+$/.test(spec), `${s.name}: ${spec}`).toBe(true);
      }
      expect(s.code, s.name).not.toMatch(/import\s*\(/);
      // ADR-0022: تنها استثنا بازصادرِ آداپتور `./pg` در index.ts است (پوشهٔ pg/ را settlement/pg/guard.test.ts نگهبانی می‌کند).
      const body = s.name === "index.ts" ? s.code.replace(/from\s+["']\.\/pg["']/g, "") : s.code;
      expect(body, s.name).not.toMatch(/\b(pg|drizzle-orm|@\/db)\b/);
    }
  });
  it("رشتهٔ اتصال، کلید یا اسرار در کد نیست", () => {
    for (const s of sources) expect(s.code, s.name).not.toMatch(/postgres(ql)?:\/\/|sk-[A-Za-z0-9]{10,}|api[_-]?key|password/i);
  });
  it("رابط عمومی فقط نام‌های اعلام‌شده را صادر می‌کند", () => {
    expect(Object.keys(api).sort()).toEqual(["SETTLEMENT_DEFAULT_SCHEMA", "SETTLEMENT_LIMITS", "createDurableLedger", "createDurableMeteredGateway", "createMemoryOutbox", "createPgSettlementOutbox", "createSettlementSweeper", "createSweepHealthCheck", "createSweepLoop", "sweepHealthHttpStatus"]);
  });
  it("هیچ تستی در این ماژول .skip/.only/xit/todo ندارد", () => {
    for (const n of readdirSync(DIR).filter((f) => f.endsWith(".test.ts") && f !== "purity.test.ts")) {
      expect(readFileSync(join(DIR, n), "utf8"), n).not.toMatch(/\.(skip|only|todo)\s*\(|\bxit\s*\(|\bxdescribe\s*\(/);
    }
  });
});

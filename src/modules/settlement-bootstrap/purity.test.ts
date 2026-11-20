/**
 * نگهبان منبع settlement-bootstrap (ADR-0033): ماژول `process`، `globalThis`، `console`، پایگاه و ساعتِ سیستم را مستقیم نمی‌شناسد؛
 * همه تزریقی است. فقط رابط عمومیِ settlement-host و settlement-runtime. فقط فایل‌های محصول.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as api from "./index";

const DIR = __dirname;
/** ADR-0043: `settlement` (فقط برای ساختنِ outboxِ PostgreSQL) و `settlement-backlog-watch` افزوده شدند؛ هیچ مسیرِ داخلی و هیچ ماژولِ دیگری مجاز نشد. */
const ALLOWED_IMPORTS: readonly string[] = ["@/modules/settlement-host", "@/modules/settlement-runtime", "@/modules/settlement", "@/modules/settlement-backlog-watch"];
const NON_PRODUCT = new Set(["test-kit.ts"]);
const strip = (c: string): string => c.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
const sources = readdirSync(DIR)
  .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && !NON_PRODUCT.has(n))
  .map((n) => ({ name: n, code: strip(readFileSync(join(DIR, n), "utf8")) }));
const tests = () => readdirSync(DIR).filter((f) => f.endsWith(".test.ts") && f !== "purity.test.ts");

describe("settlement-bootstrap · نگهبان منبع", () => {
  it("فهرست فایل‌های منبع شناخته‌شده است (فایل تازه باید آگاهانه اضافه شود)", () => {
    expect(sources.map((s) => s.name).sort()).toEqual(["bootstrap.ts", "env.ts", "http.ts", "index.ts", "types.ts"]);
  });

  it("process (و process.env)، globalThis، global، console، fetch، eval، require و import() در هیچ فایلی نیست", () => {
    const forbidden: [string, RegExp][] = [
      ["process", /(?<![\w-])process(?![\w-])/],
      ["globalThis", /\bglobalThis\b/],
      ["global", /\bglobal\b/],
      ["console", /\bconsole\b/],
      ["fetch", /\bfetch\s*\(/],
      ["eval/Function", /\b(eval|new\s+Function)\b/],
      ["require", /\brequire\s*\(/],
      ["import()", /import\s*\(/],
      ["crypto", /\bcrypto\b/],
      ["Math.random", /Math\s*\.\s*random/],
    ];
    for (const s of sources) for (const [label, re] of forbidden) expect(s.code, `${s.name}: ${label}`).not.toMatch(re);
  });

  it("Date، setTimeout، setInterval و setImmediate نیست (زمان‌سنج تزریقی یا از settlement-runtime)", () => {
    for (const s of sources) expect(s.code, s.name).not.toMatch(/\b(Date|setTimeout|clearTimeout|setInterval|setImmediate|queueMicrotask)\b/);
  });

  it("importها فقط: رابط عمومیِ settlement-host، settlement-runtime، settlement و settlement-backlog-watch و فایل‌های نسبیِ همین ماژول", () => {
    for (const s of sources) {
      for (const m of s.code.matchAll(/from\s+["']([^"']+)["']/g)) {
        const spec = m[1] as string;
        expect(ALLOWED_IMPORTS.includes(spec) || /^\.\/[a-z-]+$/.test(spec), `${s.name}: ${spec}`).toBe(true);
      }
      expect(s.code, s.name).not.toMatch(/\b(drizzle-orm|@\/db|node:)/);
      expect(s.code, s.name).not.toMatch(/from\s+["']pg["']/);
    }
  });

  it("خودش اتصال نمی‌سازد، مهاجرت نمی‌کند، استخر را نمی‌بندد و process.exit را صدا نمی‌زند", () => {
    for (const s of sources) {
      expect(s.code, s.name).not.toMatch(/\bnew\s+Pool\b/);
      expect(s.code, s.name).not.toMatch(/\bdrizzle\s*\(/);
      expect(s.code, s.name).not.toMatch(/\.end\s*\(/);
      expect(s.code, s.name).not.toMatch(/\.migrate\s*\(/);
    }
  });

  it("رشتهٔ اتصال، کلید یا اسرار در کد نیست", () => {
    for (const s of sources) expect(s.code, s.name).not.toMatch(/postgres(ql)?:\/\/|sk-[A-Za-z0-9]{10,}|api[_-]?key|password/i);
  });

  it("پیام‌های خطا هرگز متنِ استثنا را نمی‌گیرند (catch بی‌پارامتر): هیچ `catch (e)` یا `.message`ی نیست", () => {
    for (const s of sources) {
      expect(s.code, s.name).not.toMatch(/catch\s*\(/);
      expect(s.code, s.name).not.toMatch(/\.(message|stack)\b/);
    }
  });

  it("رابط عمومی فقط نام‌های اعلام‌شده را صادر می‌کند", () => {
    expect(Object.keys(api).sort()).toEqual(["SETTLEMENT_BOOTSTRAP_ENV", "parseBootstrapEnv", "probeHttpResponse", "startSettlementBootstrap"]);
  });

  it("نام‌های متغیرِ محیط با فهرستِ شناخته‌شده و پیشوندِ رزرو یکی است", () => {
    expect(api.SETTLEMENT_BOOTSTRAP_ENV).toEqual({
      host: "SETTLEMENT_HOST",
      graceMs: "SETTLEMENT_GRACE_MS",
      shutdownTimeoutMs: "SETTLEMENT_SHUTDOWN_TIMEOUT_MS",
      bootAttempts: "SETTLEMENT_BOOT_ATTEMPTS",
      bootRetryDelayMs: "SETTLEMENT_BOOT_RETRY_DELAY_MS",
      ledgerSchema: "SETTLEMENT_LEDGER_SCHEMA",
      outboxSchema: "SETTLEMENT_OUTBOX_SCHEMA",
    });
    for (const v of Object.values(api.SETTLEMENT_BOOTSTRAP_ENV)) expect(v.startsWith("SETTLEMENT_")).toBe(true);
  });

  it("پیش‌فرضِ شکست‌بسته: deadLetters و graceMs هرگز سخت‌کد نمی‌شوند؛ deadLetters صریحاً false است", () => {
    const code = sources.find((s) => s.name === "bootstrap.ts")?.code ?? "";
    expect(code).toMatch(/deadLetters: false/);
    expect(code).toMatch(/graceMs: settings\.graceMs/);
    expect(code).not.toMatch(/graceMs:\s*\d/);
  });

  it("exit فقط وقتی processOwner===host به host داده می‌شود", () => {
    const code = sources.find((s) => s.name === "bootstrap.ts")?.code ?? "";
    expect(code).toMatch(/if \(cfg\.processOwner === "host"\) hostConfig\["exit"\]/);
    expect(code.match(/hostConfig\["exit"\]/g)).toHaveLength(1);
  });

  it("هیچ تستی در این ماژول .skip/.only/xit/todo ندارد", () => {
    for (const n of tests()) expect(readFileSync(join(DIR, n), "utf8"), n).not.toMatch(/\.(skip|only|todo)\s*\(|\bxit\s*\(|\bxdescribe\s*\(/);
  });

  it("سیگنالِ واقعی فقط در یک آزمونِ صریح و فقط SIGTERM به process خودش فرستاده می‌شود", () => {
    for (const n of tests()) {
      const code = readFileSync(join(DIR, n), "utf8");
      expect(code, n).not.toMatch(/process\s*\.\s*(emit|exit)\s*\(/);
      const kills = [...code.matchAll(/process\s*\.\s*kill\s*\(([^)]*)\)/g)].map((m) => m[1]);
      if (n === "bootstrap.test.ts") expect(kills).toEqual(["process.pid, \"SIGTERM\""]);
      else expect(kills, n).toEqual([]);
    }
  });
});

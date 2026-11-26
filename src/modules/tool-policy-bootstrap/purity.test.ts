/**
 * نگهبان منبع tool-policy-bootstrap (ADR-0076): فقط رابط عمومیِ ماژول‌های مجاز؛ بی‌`process`/`globalThis`/`console`/`@/db`/`pg`/`Date`/`setTimeout`/`.env`؛
 * همه‌چیز تزریقی است (گلوی `src/instrumentation-policy.ts` آن‌ها را می‌دهد). بی‌`catch (e)`/`.message` (متنِ خطا نشت نکند). فقط فایل‌های محصول.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as api from "./index";

const DIR = __dirname;
const strip = (c: string): string => c.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
const sources = readdirSync(DIR)
  .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))
  .map((n) => ({ name: n, code: strip(readFileSync(join(DIR, n), "utf8")) }));

describe("tool-policy-bootstrap · نگهبان منبع", () => {
  it("فهرست فایل‌های منبع شناخته‌شده است (فایل تازه باید آگاهانه اضافه شود)", () => {
    expect(sources.map((s) => s.name).sort()).toEqual(["bootstrap.ts", "env.ts", "http.ts", "index.ts", "types.ts"]);
  });

  it("هیچ فایلی از globalThis، console، fetch، eval، require، crypto، Math.random، performance، setInterval یا import() پویا استفاده نمی‌کند", () => {
    const forbidden: [string, RegExp][] = [
      ["globalThis", /\bglobalThis\b/],
      ["global", /\bglobal\b/],
      ["console", /\bconsole\b/],
      ["fetch", /\bfetch\s*\(/],
      ["eval/Function", /\b(eval|new\s+Function)\b/],
      ["require", /\brequire\s*\(/],
      ["crypto", /\bcrypto\b/],
      ["Math.random", /Math\s*\.\s*random/],
      ["performance", /\bperformance\b/],
      ["setInterval", /\bsetInterval\b/],
      ["import()", /import\s*\(/],
    ];
    for (const s of sources) for (const [label, re] of forbidden) expect(s.code, `${s.name}: ${label}`).not.toMatch(re);
  });

  it("process، process.env، Date، setTimeout در هیچ فایلی نیست (محیط/زمان‌سنج تزریقی؛ آداپتورِ process در settlement-host)", () => {
    for (const s of sources) {
      expect(s.code, `${s.name}: process`).not.toMatch(/(?<![\w-])process(?![\w-])/);
      expect(s.code, `${s.name}: process.env/dotenv`).not.toMatch(/\bprocess\s*\.\s*env\b|\bdotenv\b/);
      expect(s.code, `${s.name}: Date`).not.toMatch(/\bDate\b/);
      expect(s.code, `${s.name}: setTimeout`).not.toMatch(/\b(setTimeout|clearTimeout)\b/);
    }
  });

  it("importها فقط: رابط عمومیِ ماژول‌های مجاز و فایل‌های نسبیِ همین ماژول (بی‌deep import، بی‌پایگاه، بی‌node:)", () => {
    const allowed = new Set(["@/modules/settlement-host", "@/modules/settlement-runtime", "@/modules/tool-policy-host", "@/modules/tool-policy-runtime"]);
    for (const s of sources) {
      for (const m of s.code.matchAll(/from\s+["']([^"']+)["']/g)) {
        const spec = m[1] as string;
        expect(allowed.has(spec) || /^\.\/[a-z-]+$/.test(spec), `${s.name}: ${spec}`).toBe(true);
      }
      expect(s.code, s.name).not.toMatch(/\b(drizzle-orm|@\/db|node:)/);
      expect(s.code, s.name).not.toMatch(/from\s+["']pg["']/);
    }
  });

  it("خطا هرگز خوانده نمی‌شود: بی‌`catch (e)` و بی‌`.message`/`.stack`", () => {
    for (const s of sources) {
      expect(s.code, `${s.name}: catch(e)`).not.toMatch(/catch\s*\(/);
      expect(s.code, `${s.name}: .message`).not.toMatch(/\.(message|stack)\b/);
    }
  });

  it("migrate/DDL/DROP/CREATE در منبع نیست (بوت هرگز مهاجرت نمی‌کند)", () => {
    for (const s of sources) {
      expect(s.code, s.name).not.toMatch(/\b(migrate|CREATE\s+(TABLE|SCHEMA)|DROP\s+(TABLE|SCHEMA)|ALTER\s+TABLE)\b/i);
    }
  });

  it("اسرار و رشتهٔ اتصال در منبع نیست", () => {
    for (const s of sources) {
      expect(s.code, s.name).not.toMatch(/postgres(ql)?:\/\//i);
      expect(s.code, s.name).not.toMatch(/\b(password|secret|api[_-]?key|token)\b/i);
    }
  });

  it("رابط عمومی دقیقاً همین‌هاست", () => {
    expect(Object.keys(api).sort()).toEqual(["TOOL_POLICY_BOOTSTRAP_ENV", "parseBootstrapEnv", "probeHttpResponse", "startToolPolicyBootstrap"]);
  });
});

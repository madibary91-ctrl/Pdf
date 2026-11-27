/**
 * نگهبان منبع tool-policy-preflight (ADR-0078): فقط رابط عمومیِ `tool-policy`، `tool-policy-binding` و `tool-policy-admin`؛
 * بی‌I/O، بی‌ساعت، بی‌`process`، بی‌متنِ خطا؛ همه‌چیز تزریقی است. فقط فایل‌های محصول.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as api from "@/modules/tool-policy-preflight";

// در tooling چون ماژولِ خالص نباید node:fs را import کند (tooling/boundaries.test.ts).
const DIR = join(__dirname, "..", "src", "modules", "tool-policy-preflight");
const strip = (c: string): string => c.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
const sources = readdirSync(DIR)
  .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && n !== "test-kit.ts")
  .map((n) => ({ name: n, code: strip(readFileSync(join(DIR, n), "utf8")) }));

describe("tool-policy-preflight · نگهبان منبع", () => {
  it("فهرست فایل‌های منبع شناخته‌شده است (فایل تازه باید آگاهانه اضافه شود)", () => {
    expect(sources.map((s) => s.name).sort()).toEqual(["guarded-admin.ts", "index.ts", "preflight.ts", "types.ts"]);
  });

  it("globalThis، console، fetch، eval، require، crypto، Math.random، performance، setInterval، import() پویا نیست", () => {
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

  it("process، Date، setTimeout، setImmediate، queueMicrotask در هیچ فایلی نیست", () => {
    for (const s of sources) {
      expect(s.code, `${s.name}: process`).not.toMatch(/(?<![\w-])process(?![\w-])/);
      expect(s.code, `${s.name}: Date`).not.toMatch(/\bDate\b/);
      expect(s.code, `${s.name}: timers`).not.toMatch(/\b(setTimeout|clearTimeout|setImmediate|queueMicrotask)\b/);
    }
  });

  it("importها فقط: سه رابطِ عمومیِ مجاز و فایل‌های نسبیِ همین ماژول (بی‌deep import، بی‌پایگاه، بی‌node:)", () => {
    const allowed = new Set(["@/modules/tool-policy", "@/modules/tool-policy-binding", "@/modules/tool-policy-admin"]);
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

  it("اسرار و رشتهٔ اتصال و واژهٔ قیمت/ارز/حساب در منبع نیست", () => {
    for (const s of sources) {
      expect(s.code, s.name).not.toMatch(/postgres(ql)?:\/\//i);
      expect(s.code, s.name).not.toMatch(/\b(password|secret|api[_-]?key|token)\b/i);
      expect(s.code, s.name).not.toMatch(/\b(price|currency|account|budget|micros)\b/i);
    }
  });

  it("مدیر فقط از رابطِ عمومی (نه ذخیره‌ساز) می‌خواند: بی‌`store`/`append`/`latest`", () => {
    for (const s of sources) expect(s.code, s.name).not.toMatch(/\b(store|append|latest)\b/);
  });

  it("رابط عمومی دقیقاً همین است", () => {
    expect(Object.keys(api).sort()).toEqual(["createPreflightedAdmin", "preflightToolPolicy"]);
  });
});

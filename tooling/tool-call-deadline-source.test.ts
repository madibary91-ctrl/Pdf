/**
 * نگهبانِ کد منبعِ tool-call-deadline (ADR-0066؛ در tooling چون ماژول نباید node:fs را import کند): فقط به ai-gateway وابسته، تایمرِ محیطی فقط
 * در یک نقطه (`DEFAULT_TIMERS` در config.ts)، بی‌ساعت/تصادف/محیط/شبکه، هرگز نمی‌پرتابد، متنِ استثنا را نمی‌گیرد، بی‌حالتِ سطحِ ماژول،
 * هیچ عدد/ارز/نام مدلِ پولی ندارد و رابطه‌های زمانی در یک فایل (`relations.ts`) می‌مانند.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MODULES } from "../src/modules/registry";

const DIR = join(__dirname, "..", "src", "modules", "tool-call-deadline");
const strip = (c: string): string => c.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
const all = readdirSync(DIR).filter((n) => n.endsWith(".ts"));
const sources = all.filter((n) => !n.endsWith(".test.ts") && n !== "test-kit.ts").map((n) => ({ name: n, code: strip(readFileSync(join(DIR, n), "utf8")) }));
const code = (name: string): string => sources.find((s) => s.name === name)!.code;

describe("tool-call-deadline · مرزهای کد منبع", () => {
  it("فهرست فایل‌های منبع شناخته‌شده است (فایل تازه باید آگاهانه اضافه شود)", () => {
    expect(sources.map((s) => s.name).sort()).toEqual(["config.ts", "deadline.ts", "index.ts", "relations.ts", "types.ts"]);
  });

  it("هیچ فایلی از process، Date، Math.random، fetch، crypto، console، eval، require یا performance استفاده نمی‌کند", () => {
    const forbidden: [string, RegExp][] = [
      ["process", /\bprocess\b/],
      ["Date", /\bDate\b/],
      ["Math.random", /Math\s*\.\s*random/],
      ["fetch", /\bfetch\s*\(/],
      ["setInterval/setImmediate", /\bset(Interval|Immediate)\s*\(/],
      ["performance", /\bperformance\b/],
      ["crypto", /\bcrypto\b/],
      ["require", /\brequire\s*\(/],
      ["eval/Function", /\b(eval|new\s+Function)\b/],
      ["console", /\bconsole\b/],
    ];
    for (const s of sources) for (const [label, re] of forbidden) expect(s.code, `${s.name}: ${label}`).not.toMatch(re);
  });

  it("تایمرِ محیطی (globalThis) فقط در تعریفِ DEFAULT_TIMERS در config.ts (سه ارجاع)؛ بقیه فقط از timers تزریقی", () => {
    for (const s of sources) {
      const n = (s.code.match(/\bglobalThis\b/g) ?? []).length;
      expect(n, s.name).toBe(s.name === "config.ts" ? 3 : 0);
      if (s.name !== "config.ts") expect(s.code, s.name).not.toMatch(/(^|[^.\w])set(Timeout)\s*\(|(^|[^.\w])clearTimeout\s*\(/);
    }
    expect(code("config.ts")).toMatch(/export const DEFAULT_TIMERS/);
  });

  it("importها فقط از رابطِ عمومیِ ai-gateway و فایل‌های نسبی؛ بی‌import پویا، بی‌node:، بی‌پایگاه", () => {
    for (const s of sources) {
      expect(s.code, s.name).not.toMatch(/\bimport\s*\(/);
      expect(s.code, s.name).not.toMatch(/\b(pg|drizzle-orm|@\/db)\b/);
      for (const m of s.code.matchAll(/from\s+"([^"]+)"/g)) {
        const spec = m[1]!;
        if (spec.startsWith("./")) continue;
        expect(spec, `${s.name}: ${spec}`).toBe("@/modules/ai-gateway");
      }
    }
  });

  it("ثبت در registry: لایهٔ ۴، humanReview، ناخالص، و dependsOn دقیقاً [ai-gateway]", () => {
    const m = MODULES.find((x) => x.name === "tool-call-deadline");
    expect(m).toBeDefined();
    expect(m).toMatchObject({ layer: 4, humanReview: true, pure: false });
    expect([...m!.dependsOn]).toEqual(["ai-gateway"]);
  });

  it("هرگز نمی‌پرتابد و متنِ استثنا را نمی‌گیرد؛ هر catch بی‌پارامتر است", () => {
    for (const s of sources) {
      expect(s.code, s.name).not.toMatch(/\bthrow\b/);
      expect(s.code, s.name).not.toMatch(/catch\s*\(/);
      expect(s.code, s.name).not.toMatch(/\.message\b/);
    }
  });

  it("بی‌حالتِ سطحِ ماژول: هیچ let/var/Map/Set/آرایهٔ سطحِ فایل", () => {
    for (const s of sources) {
      expect(s.code, s.name).not.toMatch(/^(let|var)\s/m);
      expect(s.code, s.name).not.toMatch(/^(export\s+)?const\s+\w+\s*=\s*(new\s+(Map|WeakMap|Set)|\[\s*\])/m);
    }
  });

  it("رابطه‌های زمانی فقط در relations.ts‌اند و به‌صورتِ ساختاری (< graceMs و ≥ ۲×graceMs) نوشته شده‌اند", () => {
    const r = code("relations.ts");
    expect(r).toMatch(/maxCallMs\s*>=\s*graceMs/);
    expect(r).toMatch(/reservationTtlMs\s*<\s*2\s*\*\s*graceMs/);
    for (const s of sources.filter((x) => x.name !== "relations.ts" && x.name !== "types.ts")) expect(s.code, s.name).not.toMatch(/graceMs|reservationTtlMs/);
  });

  it("کدهای شکستِ ساخته‌شده هرگز «پیش از ارائه‌دهنده» نیستند (INVALID_REQUEST/UNKNOWN_MODEL/INVALID_CONFIG ⇒ هزینهٔ صفر)", () => {
    const d = code("deadline.ts");
    expect(d).not.toMatch(/failure\(\s*"(INVALID_REQUEST|UNKNOWN_MODEL|INVALID_CONFIG)"/);
    expect(d).toMatch(/failure\("TIMEOUT"\)/);
    expect(d).toMatch(/failure\("INTERNAL_ERROR"\)/);
  });

  it("هیچ عدد/قیمت/ارز/نام مدلِ ثابتی در کد نیست (جز سقفِ ۶۰۰٬۰۰۰ و کرانِ ۱ در CALL_DEADLINE_LIMITS، ضریبِ ۲، صفر، یک و برش‌های ثابت)", () => {
    const allowed = new Set(["0", "1", "2", "8", "20", "40", "600_000"]);
    for (const s of sources) {
      const nums = [...s.code.matchAll(/(?<![\w.$])(\d[\d_]*(?:\.\d+)?)(?![\w])/g)].map((m) => m[1]!);
      expect(nums.filter((n) => !allowed.has(n)), s.name).toEqual([]);
      expect(s.code, s.name).not.toMatch(/\b(IRR|USD|IRR_MICROS|gpt|claude)\b/i);
    }
  });

  it("هیچ آزمونی skip/only/todo نیست", () => {
    for (const n of all.filter((f) => f.endsWith(".test.ts"))) {
      const c = readFileSync(join(DIR, n), "utf8");
      expect(c, n).not.toMatch(/\b(it|test|describe)\.(skip|only|todo)\b|\bxit\b|\bxdescribe\b/);
    }
  });
});

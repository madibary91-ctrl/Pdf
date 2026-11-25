/**
 * نگهبانِ کد منبعِ tool-policy (ADR-0067؛ در tooling چون ماژول نباید node:fs را import کند): ماژولِ خالص: بی‌I/O، بی‌process.env، بی‌ساعت،
 * بی‌تایمر، بی‌تصادف؛ فقط به شش ماژولِ اعلام‌شده وابسته؛ هرگز نمی‌پرتابد و متنِ استثنا را نمی‌گیرد؛ هیچ عددِ قیمت/ارز/حساب ندارد.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MODULES } from "../src/modules/registry";
import { HIGH_RISK_MODULES } from "./git-discipline";

const DIR = join(__dirname, "..", "src", "modules", "tool-policy");
const strip = (c: string): string => c.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
const sources = readdirSync(DIR)
  .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && n !== "test-kit.ts")
  .map((n) => ({ name: n, code: strip(readFileSync(join(DIR, n), "utf8")) }));
const DEPS = ["tool-call-deadline", "tool-loop", "calc-answer-cards", "tool-runner", "metering", "ledger"];

describe("tool-policy · مرزهای کد منبع", () => {
  it("فهرست فایل‌های منبع شناخته‌شده است (فایل تازه باید آگاهانه اضافه شود)", () => {
    expect(sources.map((s) => s.name).sort()).toEqual(["derive.ts", "index.ts", "policy.ts", "project.ts", "relations.ts", "resolve.ts", "scope.ts", "types.ts"]);
  });

  it("هیچ فایلی از process، Date، Math.random، fetch، تایمر، performance، crypto، require، eval، console یا globalThis استفاده نمی‌کند", () => {
    const forbidden: [string, RegExp][] = [
      ["process", /\bprocess\b/],
      ["Date", /\bDate\b/],
      ["Math.random", /Math\s*\.\s*random/],
      ["fetch", /\bfetch\s*\(/],
      ["timers", /\bset(Timeout|Interval|Immediate)\s*\(/],
      ["performance", /\bperformance\b/],
      ["crypto", /\bcrypto\b/],
      ["require", /\brequire\s*\(/],
      ["eval/Function", /\b(eval|new\s+Function)\b/],
      ["console", /\bconsole\b/],
      ["globalThis", /\bglobalThis\b/],
    ];
    for (const s of sources) for (const [label, re] of forbidden) expect(s.code, `${s.name}: ${label}`).not.toMatch(re);
  });

  it("importها فقط از شش ماژولِ اعلام‌شده و فایل‌های نسبی؛ بی‌import پویا و بی‌node:", () => {
    for (const s of sources) {
      expect(s.code, s.name).not.toMatch(/\bimport\s*\(/);
      for (const m of s.code.matchAll(/from\s+"([^"]+)"/g)) {
        const spec = m[1]!;
        if (spec.startsWith("./")) continue;
        const mod = /^@\/modules\/([a-z-]+)$/.exec(spec)?.[1];
        expect(mod !== undefined && DEPS.includes(mod), `${s.name}: ${spec}`).toBe(true);
      }
    }
  });

  it("ثبت در registry: لایهٔ ۵، خالص، humanReview، dependsOn دقیقاً همان شش ماژول؛ و در HIGH_RISK_MODULES", () => {
    const m = MODULES.find((x) => x.name === "tool-policy");
    expect(m).toBeDefined();
    expect(m).toMatchObject({ layer: 5, humanReview: true, pure: true });
    expect([...m!.dependsOn].sort()).toEqual([...DEPS].sort());
    expect(HIGH_RISK_MODULES).toContain("tool-policy");
  });

  it("هرگز throw؛ هر catch بی‌متغیر است (متنِ استثنا گرفته نمی‌شود)", () => {
    for (const s of sources) {
      expect(s.code, `${s.name}: throw`).not.toMatch(/\bthrow\b/);
      expect(s.code, `${s.name}: catch(e)`).not.toMatch(/\bcatch\s*\(/);
    }
  });

  it("ماژول هیچ مقدارِ پول (قیمت، ارز، حساب، کلید) در کد ندارد", () => {
    for (const s of sources) {
      const code = s.code.replace(/"[^"]*"/g, '""');
      for (const re of [/\bprice\b/i, /\bcurrency\b/i, /\btenantId\b/, /\baccountId\b/, /\bapiKey\b/i, /\bendpoint\b/i, /\bIRR\b/]) expect(code, `${s.name}: ${re}`).not.toMatch(re);
    }
  });

  it("کرانِ فیلدها از ماژول‌های پایین‌دست می‌آید: عددِ سقفِ گام/کارت/نتیجه در policy.ts تکرار نشده است", () => {
    const policy = sources.find((s) => s.name === "policy.ts")!.code;
    for (const lit of ["16,", "64,", "2_000", "100_000", "50)"]) expect(policy.includes(`int(1, ${lit}`), lit).toBe(false);
    expect(policy).toMatch(/LOOP_LIMITS\.maxSteps/);
    expect(policy).toMatch(/MAX_CARDS_CEILING/);
    expect(policy).toMatch(/RUNNER_LIMITS\.maxResultChars/);
  });
});

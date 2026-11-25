/**
 * نگهبانِ کد منبعِ tool-policy-admin (ADR-0069؛ در tooling چون ماژول نباید node:fs را import کند): ماژولِ خالص: بی‌I/O، بی‌process.env، بی‌ساعت،
 * بی‌تایمر، بی‌تصادف؛ فقط به tool-policy وابسته؛ هرگز نمی‌پرتابد و متنِ استثنا را نمی‌گیرد؛ هیچ عدد/نامِ فیلدِ سیاست و هیچ مقدارِ پول ندارد
 * (همهٔ دانشِ سیاست از `resolveToolPolicy`)؛ `Date`/ساعت فقط از پورتِ `clock`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MODULES } from "../src/modules/registry";
import { HIGH_RISK_MODULES } from "./git-discipline";

const DIR = join(__dirname, "..", "src", "modules", "tool-policy-admin");
const strip = (c: string): string => c.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
const sources = readdirSync(DIR)
  .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && n !== "test-kit.ts" && n !== "store-contract.ts")
  .map((n) => ({ name: n, code: strip(readFileSync(join(DIR, n), "utf8")) }));

describe("tool-policy-admin · مرزهای کد منبع", () => {
  it("فهرست فایل‌های منبع شناخته‌شده است (فایل تازه باید آگاهانه اضافه شود)", () => {
    expect(sources.map((s) => s.name).sort()).toEqual(["admin.ts", "canonical.ts", "index.ts", "memory-store.ts", "types.ts", "validate.ts"]);
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

  it("importها فقط از tool-policy و فایل‌های نسبی؛ بی‌import پویا و بی‌node:", () => {
    for (const s of sources) {
      expect(s.code, s.name).not.toMatch(/\bimport\s*\(/);
      for (const m of s.code.matchAll(/from\s+"([^"]+)"/g)) {
        const spec = m[1]!;
        if (spec.startsWith("./")) continue;
        expect(spec, `${s.name}: ${spec}`).toBe("@/modules/tool-policy");
      }
    }
  });

  it("ثبت در registry: لایهٔ ۵، خالص، humanReview، dependsOn دقیقاً tool-policy؛ و در HIGH_RISK_MODULES", () => {
    const m = MODULES.find((x) => x.name === "tool-policy-admin");
    expect(m).toBeDefined();
    expect(m).toMatchObject({ layer: 5, humanReview: true, pure: true });
    expect([...m!.dependsOn]).toEqual(["tool-policy"]);
    expect(HIGH_RISK_MODULES).toContain("tool-policy-admin");
  });

  it("هرگز throw؛ هر catch بی‌متغیر است (متنِ استثنا گرفته نمی‌شود)", () => {
    for (const s of sources) {
      expect(s.code, `${s.name}: throw`).not.toMatch(/\bthrow\b/);
      expect(s.code, `${s.name}: catch(e)`).not.toMatch(/\bcatch\s*\(/);
    }
  });

  it("ماژول هیچ مقدارِ پول (قیمت، ارز، حساب، کلید) ندارد", () => {
    for (const s of sources) {
      const code = s.code.replace(/"[^"]*"/g, '""');
      for (const re of [/\bprice\b/i, /\bcurrency\b/i, /\btenantId\b/, /\baccountId\b/, /\bapiKey\b/i, /\bendpoint\b/i, /\bIRR\b/]) expect(code, `${s.name}: ${re}`).not.toMatch(re);
    }
  });

  it("دانشِ سیاست فقط از tool-policy: نامِ فیلدِ سیاست یا عددِ کران در کدِ منبع نیست", () => {
    for (const s of sources) {
      const code = s.code.replace(/"[^"]*"/g, '""');
      for (const re of [/\bgraceMs\b/, /\bmaxCallMs\b/, /\breservationTtlMs\b/, /\bonUnknownCost\b/, /\bmaxSteps\b/, /\bmaxCards\b/, /\btimeoutMs\b/]) expect(code, `${s.name}: ${re}`).not.toMatch(re);
    }
  });

  it("`reason` در admin.ts فقط از normalizeReason می‌گذرد و رکورد فقط از parseRecord ساخته می‌شود (یک مسیر)", () => {
    const admin = sources.find((s) => s.name === "admin.ts")!.code;
    expect(admin).toMatch(/normalizeReason\(/);
    expect(admin).toMatch(/parseRecord\(/);
    expect(admin).toMatch(/snapshotOverrides\(/);
    expect(admin).not.toMatch(/JSON\.parse|structuredClone/);
  });
});

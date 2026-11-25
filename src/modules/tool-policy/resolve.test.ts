import { describe, expect, it } from "vitest";
import { DEFAULT_TOOL_POLICY, POLICY_LIMITS, resolveToolPolicy } from "./index";
import { POLICY_SCHEMA } from "./policy";
import { deepFrozen } from "./test-kit";

const issuesOf = (raw: unknown): readonly string[] => {
  const r = resolveToolPolicy(raw);
  return r.ok ? [] : r.error.issues;
};
const G = 60_000;
const TIMING_OK = { graceMs: G, maxCallMs: 24_000, reservationTtlMs: 4 * G };

describe("tool-policy · اعتبارسنجیِ مرز", () => {
  it("undefined و {} و بخش‌های خالی ⇒ دقیقاً پیش‌فرض‌های کد", () => {
    for (const raw of [undefined, {}, { loop: {}, run: {}, answer: {}, model: {}, timing: {}, metering: {} }]) {
      const r = resolveToolPolicy(raw);
      expect(r.ok && r.value).toEqual(DEFAULT_TOOL_POLICY);
    }
  });

  it("خروجی عمیق‌یخ‌زده و مستقل از ورودی است (تغییرِ بعدیِ ورودی بی‌اثر)", () => {
    const raw = { loop: { maxSteps: 4 } };
    const r = resolveToolPolicy(raw);
    expect(r.ok && deepFrozen(r.value)).toBe(true);
    raw.loop.maxSteps = 9;
    expect(r.ok && r.value.loop.maxSteps).toBe(4);
  });

  it("ریشهٔ غیرشیء رد می‌شود (null هم؛ «بی‌بازنویسی» فقط undefined است)", () => {
    for (const raw of [null, 5, "x", true, [], [1], BigInt(10), () => 1]) expect(issuesOf(raw)).toEqual(["سیاست باید یک شیء ساده باشد."]);
  });

  it("بخش یا کلیدِ ناشناخته رد می‌شود، نه نادیده؛ نام کوتاه می‌شود و مقدار بازتاب نمی‌شود", () => {
    expect(issuesOf({ extra: 1 })).toEqual(['کلید ناشناخته: "extra".']);
    expect(issuesOf({ loop: { maxStep: 1 } })).toEqual(['loop: کلید ناشناخته: "maxStep".']);
    const long = issuesOf({ ["k".repeat(100)]: "SECRET-VALUE-9" });
    expect(long[0]).toContain("…");
    expect(JSON.stringify(long)).not.toContain("SECRET-VALUE-9");
  });

  it("کلیدِ __proto__ (مثلِ JSON.parse) ناشناخته است و نمونهٔ سراسری را آلوده نمی‌کند", () => {
    const raw = JSON.parse('{"__proto__":{"polluted":1},"loop":{"__proto__":{"x":1}}}') as unknown;
    const issues = issuesOf(raw);
    expect(issues).toEqual(['کلید ناشناخته: "__proto__".', 'loop: کلید ناشناخته: "__proto__".']);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("بخشِ غیرشیء رد می‌شود", () => {
    for (const bad of [null, 1, "x", [], undefined]) expect(issuesOf({ timing: bad })).toEqual(["timing: باید شیء ساده باشد."]);
  });

  it("هر فیلدِ صحیح: مرزِ پایین و بالا (فقط پیامِ خودِ فیلد سنجیده می‌شود، نه رابطه‌ها)", () => {
    for (const [section, fields] of Object.entries(POLICY_SCHEMA)) {
      for (const [key, spec] of Object.entries(fields)) {
        if (spec.kind !== "int") continue;
        const path = `${section}.${key}`;
        const own = (v: unknown) => issuesOf({ [section]: { [key]: v } }).some((i) => i.startsWith(`${path} باید عدد صحیح`));
        expect(own(spec.lo), `${path} lo`).toBe(false);
        expect(own(spec.hi), `${path} hi`).toBe(false);
        expect(own(spec.lo - 1), `${path} lo-1`).toBe(true);
        expect(own(spec.hi + 1), `${path} hi+1`).toBe(true);
        for (const bad of [1.5, Number.NaN, Infinity, -Infinity, "5", null, undefined, {}, [], BigInt(10), true]) expect(own(bad), `${path} ${String(bad)}`).toBe(true);
      }
    }
  });

  it("کرانِ هر فیلدِ صحیح مستقل از کد (جدولِ ثابت؛ کرانِ ماژول‌های پایین‌دست و سقف‌های سیاستی)", () => {
    const BOUNDS: Array<[string, string, number, number]> = [
      ["loop", "maxSteps", 1, 16], ["loop", "maxToolCalls", 1, 64], ["loop", "maxIdenticalCalls", 1, 16], ["loop", "truncationRetries", 0, 2],
      ["run", "totalTimeoutMs", 1_000, 600_000], ["run", "toolTimeoutMs", 50, 300_000], ["run", "maxResultChars", 64, 100_000],
      ["answer", "maxCards", 1, 50], ["answer", "maxOutputTokens", 1, 65_536],
      ["model", "timeoutMs", 1, 600_000],
      ["timing", "graceMs", 1, 43_200_000], ["timing", "maxCallMs", 1, 600_000], ["timing", "reservationTtlMs", 1_000, 86_400_000],
      ["metering", "perMessageOverheadTokens", 0, 1_000],
    ];
    expect(BOUNDS).toHaveLength(Object.values(POLICY_SCHEMA).flatMap((f) => Object.values(f)).filter((x) => x.kind === "int").length);
    for (const [s, k, lo, hi] of BOUNDS) {
      const path = `${s}.${k}`;
      const own = (v: number) => issuesOf({ [s]: { [k]: v } }).some((i) => i.startsWith(`${path} باید عدد صحیح`));
      expect([own(lo - 1), own(lo), own(hi), own(hi + 1)], path).toEqual([true, false, false, true]);
    }
  });

  it("مقدارِ صریحاً undefined بی‌صدا با پیش‌فرض جایگزین نمی‌شود", () => {
    expect(issuesOf({ loop: { maxSteps: undefined } })).toEqual(["loop.maxSteps باید عدد صحیح 1 تا 16 باشد."]);
  });

  it("onUnknownCost فقط forfeit یا release؛ release مجاز است (تصمیمِ مالک/ادمین)", () => {
    expect(issuesOf({ metering: { onUnknownCost: "release" } })).toEqual([]);
    expect(issuesOf({ metering: { onUnknownCost: "forfeit" } })).toEqual([]);
    for (const bad of ["Forfeit", "none", "", 1, null, undefined]) expect(issuesOf({ metering: { onUnknownCost: bad } })).toEqual(['metering.onUnknownCost باید یکی از "forfeit"، "release" باشد.']);
  });

  it("نامِ مدل: قاعدهٔ نامِ منطقی و سقفِ نویسه؛ نامِ بد بازتاب نمی‌شود", () => {
    const ok = (n: string) => issuesOf({ model: { name: n } }).length === 0;
    expect(ok("calc-answer")).toBe(true);
    expect(ok("a")).toBe(true);
    expect(ok("a".repeat(POLICY_LIMITS.maxModelNameChars))).toBe(true);
    expect(ok("a".repeat(POLICY_LIMITS.maxModelNameChars + 1))).toBe(false);
    for (const bad of ["", " x", "x y", "-x", "../x", "x/y", "مدل", "x\n", "x\u0000"]) expect(ok(bad), JSON.stringify(bad)).toBe(false);
    for (const bad of [1, null, undefined, {}]) expect(issuesOf({ model: { name: bad } })).toHaveLength(1);
    expect(JSON.stringify(issuesOf({ model: { name: "sk-LEAK-CANARY/x" } }))).not.toContain("LEAK-CANARY");
  });

  it("بازنویسیِ سازگارِ کلِ زمان‌بندی پذیرفته و اعمال می‌شود", () => {
    const r = resolveToolPolicy({ timing: TIMING_OK, model: { timeoutMs: 20_000 }, run: { totalTimeoutMs: 100_000 } });
    expect(r.ok && r.value.timing).toEqual(TIMING_OK);
    expect(r.ok && r.value.model.timeoutMs).toBe(20_000);
  });

  it("بازنویسیِ ناسازگار رد می‌شود و هرگز خودکار اصلاح نمی‌شود (graceMs کم، maxCallMs و ttl پیش‌فرض)", () => {
    const issues = issuesOf({ timing: { graceMs: 30_000 } });
    expect(issues).toContain("maxCallMs باید کمتر از graceMs باشد.");
    expect(issuesOf({ timing: { maxCallMs: 90_000 } })).toContain("maxCallMs باید کمتر از graceMs باشد.");
    expect(issuesOf({ timing: { maxCallMs: 50_000 } })).toEqual(["graceMs باید دست‌کم دو برابر maxCallMs باشد (حاشیهٔ تسویه)."]);
    expect(issuesOf({ model: { timeoutMs: 36_000 } })).toEqual(["model.timeoutMs باید کمتر از maxCallMs باشد."]);
    expect(issuesOf({ run: { totalTimeoutMs: 20_000 } })).toEqual(["totalTimeoutMs باید دست‌کم برابرِ maxCallMs باشد."]);
    expect(issuesOf({ timing: { reservationTtlMs: 100_000 } })).toEqual(["reservationTtlMs باید دست‌کم دو برابر graceMs باشد."]);
  });

  it("رابطه‌ها فقط وقتی سنجیده می‌شوند که هر پنج فیلدِ درگیر معتبر باشند (بی‌پیامِ تکراری)", () => {
    expect(issuesOf({ timing: { maxCallMs: "x" } })).toEqual(["timing.maxCallMs باید عدد صحیح 1 تا 600000 باشد."]);
  });

  it("هر کلید فقط یک‌بار خوانده می‌شود (getter/Proxy نمی‌تواند بین اعتبارسنجی و ساخت عوض شود)", () => {
    let reads = 0;
    const section = {
      get maxSteps() {
        reads += 1;
        return reads === 1 ? 4 : 99;
      },
    };
    const r = resolveToolPolicy({ loop: section });
    expect(reads).toBe(1);
    expect(r.ok && r.value.loop.maxSteps).toBe(4);
    let rootReads = 0;
    const root = { get loop() { rootReads += 1; return { maxSteps: 3 }; } };
    resolveToolPolicy(root);
    expect(rootReads).toBe(1);
  });

  it("ورودیِ پرتاب‌کننده هرگز استثنا نمی‌دهد و متنِ استثنا نشت نمی‌کند", () => {
    const evil = new Proxy({}, { ownKeys: () => { throw new Error("SECRET-CANARY"); } });
    const r = resolveToolPolicy(evil);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("SECRET-CANARY");
    const evilSection = { loop: new Proxy({}, { get: () => { throw new Error("SECRET-CANARY"); }, ownKeys: () => ["maxSteps"], getOwnPropertyDescriptor: () => ({ value: 1, enumerable: true, configurable: true }) }) };
    const r2 = resolveToolPolicy(evilSection);
    expect(r2.ok).toBe(false);
    expect(JSON.stringify(r2)).not.toContain("SECRET-CANARY");
  });

  it("مقدارِ ورودی هرگز در پیام‌ها بازتاب نمی‌شود", () => {
    const r = resolveToolPolicy({ loop: { maxSteps: "SECRET-VALUE-1" }, model: { name: "SECRET-VALUE-2/x" }, metering: { onUnknownCost: "SECRET-VALUE-3" } });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/SECRET-VALUE/);
  });

  it("سقفِ ۲۰ مشکل؛ بی‌تکرار؛ پیام و کد ثابت و خطا یخ‌زده", () => {
    const bad: Record<string, unknown> = {};
    for (const k of Array.from({ length: 40 }, (_, i) => `k${i}`)) bad[k] = 1;
    const r = resolveToolPolicy(bad);
    expect(!r.ok && r.error.issues).toHaveLength(20);
    expect(!r.ok && r.error.code).toBe("INVALID_POLICY");
    expect(!r.ok && deepFrozen(r.error)).toBe(true);
    expect(!r.ok && new Set(r.error.issues).size).toBe(20);
  });

  it("خودهمانی: سیاستِ حاصل دوباره‌ورودیِ تابع است و همان را می‌دهد", () => {
    const a = resolveToolPolicy({ loop: { maxSteps: 3 }, timing: TIMING_OK, model: { timeoutMs: 10_000 }, metering: { onUnknownCost: "release", perMessageOverheadTokens: 0 }, answer: { maxCards: 1 } });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const b = resolveToolPolicy(a.value);
    expect(b.ok && b.value).toEqual(a.value);
  });
});

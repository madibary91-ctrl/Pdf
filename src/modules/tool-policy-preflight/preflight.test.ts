import { describe, expect, it } from "vitest";
import { projectToolPolicy, resolveToolPolicy } from "@/modules/tool-policy";
import { preflightToolPolicy } from "./preflight";
import { compat, deepFrozen, fakeBuild, prng } from "./test-kit";

const STAGES = ["CONFIG_INVALID", "INPUT_UNREADABLE", "OVERRIDES_INVALID", "PROJECTION_INVALID", "BUILD_FAILED"];
const stageOf = (r: ReturnType<typeof preflightToolPolicy>): string => (r.ok ? "OK" : r.error.stage);

describe("tool-policy-preflight · مسیرِ سالم", () => {
  it("پیش‌فرض‌های کد (undefined و {}) و بازنویسیِ سازگار پذیرفته می‌شود", () => {
    for (const overrides of [undefined, {}, compat(60_000, 20_000), compat(150_000, 50_000)]) {
      const t = fakeBuild();
      const r = preflightToolPolicy({ overrides, build: t.build });
      expect(stageOf(r), JSON.stringify(overrides)).toBe("OK");
    }
  });

  it("خروجی: سیاستِ مؤثرِ resolve و projectionِ بازساخته؛ هر دو ژرف‌یخ‌زده", () => {
    const o = compat(120_000, 40_000);
    const r = preflightToolPolicy({ overrides: o, build: fakeBuild().build });
    if (!r.ok) throw new Error("expected ok");
    const resolved = resolveToolPolicy(o);
    if (!resolved.ok) throw new Error("resolve");
    const projected = projectToolPolicy(resolved.value);
    if (!projected.ok) throw new Error("project");
    expect(r.value.policy).toEqual(resolved.value);
    expect(r.value.projection).toEqual(projected.value);
    expect(deepFrozen(r.value)).toBe(true);
    expect(Object.keys(r.value).sort()).toEqual(["policy", "projection"]);
  });

  it("build دقیقاً یک بار و با همان projection صدا زده می‌شود؛ نمونه دور ریخته می‌شود", () => {
    const t = fakeBuild();
    const r = preflightToolPolicy({ overrides: compat(90_000, 30_000), build: t.build });
    if (!r.ok) throw new Error("expected ok");
    expect(t.state.calls).toHaveLength(1);
    expect(t.state.calls[0]).toBe(r.value.projection); // همان شیءِ بازساختهٔ پیوند، نه نگاشتِ اولیه
    expect(JSON.stringify(r.value)).not.toContain('"id"');
  });

  it("سازندهٔ ساختگی که تابع برمی‌گرداند هم پذیرفته می‌شود (قراردادِ پیوند)", () => {
    expect(stageOf(preflightToolPolicy({ overrides: {}, build: () => ({ ok: true, value: () => 1 }) }))).toBe("OK");
  });

  it("قطعی: دو بار با همان ورودی همان نتیجه", () => {
    const o = compat(90_000, 30_000);
    expect(preflightToolPolicy({ overrides: o, build: fakeBuild().build })).toEqual(preflightToolPolicy({ overrides: o, build: fakeBuild().build }));
  });

  it("ورودیِ بازنویسی تغییر نمی‌کند", () => {
    const o = compat(90_000, 30_000);
    const before = JSON.stringify(o);
    preflightToolPolicy({ overrides: o, build: fakeBuild().build });
    expect(JSON.stringify(o)).toBe(before);
  });
});

describe("tool-policy-preflight · OVERRIDES_INVALID", () => {
  const bad: [string, unknown][] = [
    ["کلیدِ ناشناخته", { nope: { x: 1 } }],
    ["بخشِ ناشناخته با مقدار", { loop: { unknownKey: 1 } }],
    ["خارج از کران", { loop: { maxSteps: 99_999_999_999 } }],
    ["نوعِ غلط", { loop: { maxSteps: "10" } }],
    ["رابطهٔ پول: فقط graceMs", { timing: { graceMs: 30_000 } }],
    ["رشته", "x"],
    ["آرایه", []],
    ["null", null],
  ];
  for (const [name, overrides] of bad) {
    it(`${name} ⇒ ردِ بی‌ساخت با issues`, () => {
      const t = fakeBuild();
      const r = preflightToolPolicy({ overrides, build: t.build });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe("PREFLIGHT_REJECTED");
      expect(r.error.stage).toBe("OVERRIDES_INVALID");
      expect(r.error.issues.length).toBeGreaterThan(0);
      expect(t.state.calls).toHaveLength(0);
    });
  }

  it("issues مقدارِ ورودی را بازتاب نمی‌دهد", () => {
    const r = preflightToolPolicy({ overrides: { loop: { maxSteps: 98_765_432_101 } }, build: fakeBuild().build });
    expect(JSON.stringify(r)).not.toContain("98765432101");
  });

  it("ورودیِ خصمانه (getter پرتاب‌کننده) ⇒ بی‌پرتاب و بی‌نشتِ متن", () => {
    const evil = { get loop(): never { throw new Error("sk-SECRET"); } };
    const t = fakeBuild();
    const r = preflightToolPolicy({ overrides: evil, build: t.build });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("sk-SECRET");
    expect(t.state.calls).toHaveLength(0);
  });
});

describe("tool-policy-preflight · BUILD_FAILED", () => {
  const builds: [string, () => unknown][] = [
    ["پرتاب", () => { throw new Error("sk-SECRET"); }],
    ["undefined", () => undefined],
    ["null", () => null],
    ["عدد", () => 5],
    ["ok:false", () => ({ ok: false, error: "sk-SECRET" })],
    ["ok:true بی‌value", () => ({ ok: true })],
    ["ok:true با value نامعتبر", () => ({ ok: true, value: 5 })],
    ["ok truthy غیر true", () => ({ ok: 1, value: {} })],
  ];
  for (const [name, build] of builds) {
    it(`${name} ⇒ BUILD_FAILED بی‌نشتِ متن`, () => {
      const r = preflightToolPolicy({ overrides: compat(90_000, 30_000), build });
      expect(stageOf(r)).toBe("BUILD_FAILED");
      expect(JSON.stringify(r)).not.toContain("sk-SECRET");
      if (!r.ok) expect(r.error.issues).toEqual([]);
    });
  }

  it("ردِ build وابسته به projection (سیاستِ معتبر ولی ناساخته‌شدنی)", () => {
    const t = fakeBuild((p) => p.service.maxCards === 3);
    expect(stageOf(preflightToolPolicy({ overrides: { answer: { maxCards: 3 } }, build: t.build }))).toBe("BUILD_FAILED");
    expect(stageOf(preflightToolPolicy({ overrides: { answer: { maxCards: 4 } }, build: t.build }))).toBe("OK");
  });
});

describe("tool-policy-preflight · CONFIG_INVALID", () => {
  const cfgs: [string, unknown][] = [
    ["undefined", undefined],
    ["null", null],
    ["{}", {}],
    ["build غیرتابع", { overrides: {}, build: "x" }],
    ["build عدد", { overrides: {}, build: 1 }],
    ["بی‌build", { overrides: {} }],
    ["getter پرتاب‌کننده", { get build(): never { throw new Error("sk-SECRET"); } }],
  ];
  it("پیکربندی پیش از بازنویسی سنجیده می‌شود: بازنویسیِ نامعتبر + build غیرتابع ⇒ CONFIG_INVALID", () => {
    expect(stageOf(preflightToolPolicy({ overrides: { nope: 1 }, build: "x" }))).toBe("CONFIG_INVALID");
    expect(stageOf(preflightToolPolicy({ overrides: { nope: 1 } }))).toBe("CONFIG_INVALID");
  });

  for (const [name, cfg] of cfgs) {
    it(`${name} ⇒ CONFIG_INVALID`, () => {
      const r = preflightToolPolicy(cfg);
      expect(stageOf(r)).toBe("CONFIG_INVALID");
      expect(JSON.stringify(r)).not.toContain("sk-SECRET");
    });
  }
});

describe("tool-policy-preflight · ردها", () => {
  it("خطا یخ‌زده، کد ثابت، پیامِ ثابتِ فارسی و متفاوت برای هر مرحله", () => {
    const rs = [
      preflightToolPolicy(null),
      preflightToolPolicy({ overrides: { nope: 1 }, build: fakeBuild().build }),
      preflightToolPolicy({ overrides: {}, build: () => 1 }),
    ];
    const msgs = new Set<string>();
    for (const r of rs) {
      if (r.ok) throw new Error("expected rejection");
      expect(Object.isFrozen(r.error)).toBe(true);
      expect(Object.isFrozen(r.error.issues)).toBe(true);
      expect(r.error.code).toBe("PREFLIGHT_REJECTED");
      expect(STAGES).toContain(r.error.stage);
      expect(r.error.message).toMatch(/[\u0600-\u06FF]/);
      msgs.add(r.error.message);
    }
    expect(msgs.size).toBe(3);
  });
});

describe("tool-policy-preflight · مدل‌محور", () => {
  it("۳۰۰ بذرِ تصادفی: پذیرش ⇔ resolve سالم و build راضی (داورِ مستقل)", () => {
    const rule = (maxSteps: number): boolean => maxSteps % 2 === 0;
    let accepted = 0;
    let rejected = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const rnd = prng(seed);
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
      const o: Record<string, unknown> = { ...(rnd() < 0.5 ? compat(pick([60_000, 90_000, 120_000]), pick([20_000, 30_000])) : {}) };
      if (rnd() < 0.7) o.loop = { maxSteps: pick([1, 2, 3, 4, 5, 6, 7, 8, 1_000_000_000, -1]) };
      if (rnd() < 0.2) o.bogus = {};
      const t = fakeBuild((p) => !rule(p.loop.maxSteps));
      const r = preflightToolPolicy({ overrides: o, build: t.build });
      const resolved = resolveToolPolicy(o);
      const expected = !resolved.ok ? "OVERRIDES_INVALID" : rule(resolved.value.loop.maxSteps) ? "OK" : "BUILD_FAILED";
      expect(stageOf(r), `seed ${seed}`).toBe(expected);
      expect(t.state.calls.length).toBe(resolved.ok ? 1 : 0);
      if (r.ok) accepted += 1;
      else rejected += 1;
    }
    expect(accepted).toBeGreaterThan(20);
    expect(rejected).toBeGreaterThan(20);
  });
});

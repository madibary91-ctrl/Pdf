import { describe, expect, it } from "vitest";
import { canonicalOverrides, deepFreeze, diffPolicies, isPlain, snapshotOverrides, stable } from "./canonical";

describe("tool-policy-admin/canonical · isPlain", () => {
  it("شیءِ ساده و بی‌پروتوتایپ true؛ آرایه، null، نمونهٔ کلاس و اولیه false", () => {
    expect(isPlain({})).toBe(true);
    expect(isPlain(Object.create(null))).toBe(true);
    for (const v of [[], null, undefined, 1, "x", new Date(0), new (class A {})(), new Map()]) expect(isPlain(v)).toBe(false);
  });
  it("Proxyی که getPrototypeOf می‌پرتابد: false و بی‌استثنا", () => {
    const p = new Proxy({}, { getPrototypeOf: () => { throw new Error("boom"); } });
    expect(isPlain(p)).toBe(false);
  });
});

describe("tool-policy-admin/canonical · snapshotOverrides", () => {
  it("شیءِ غیرساده ⇒ null", () => {
    for (const v of [undefined, null, [], 5, "x", new Date()]) expect(snapshotOverrides(v)).toBeNull();
  });
  it("هر کلید دقیقاً یک‌بار خوانده می‌شود (getter/Proxy نمی‌تواند عوض شود)", () => {
    let reads = 0;
    const raw = { timing: { get graceMs() { reads++; return reads === 1 ? 60_000 : 90_000; } } };
    const snap = snapshotOverrides(raw)!;
    expect(reads).toBe(1);
    expect((snap["timing"] as Record<string, unknown>)["graceMs"]).toBe(60_000);
  });
  it("getter بخش هم یک‌بار خوانده می‌شود", () => {
    let reads = 0;
    const raw = { get timing() { reads++; return { graceMs: 60_000 }; } };
    snapshotOverrides(raw);
    expect(reads).toBe(1);
  });
  it("ownKeys/get که می‌پرتابند ⇒ null (بی‌استثنا)", () => {
    expect(snapshotOverrides(new Proxy({}, { ownKeys: () => { throw new Error("x"); } }))).toBeNull();
    expect(snapshotOverrides({ get timing(): never { throw new Error("x"); } })).toBeNull();
  });
  it("برگِ غیرِ اولیه (شیء، تابع، undefined، bigint، symbol) ⇒ null؛ رشته/عدد/بولی می‌ماند", () => {
    const snap = snapshotOverrides({ s: { a: {}, b: () => 1, c: undefined, d: BigInt(1), e: Symbol("x"), f: "t", g: 2, h: true } })!;
    expect(snap["s"]).toEqual({ a: null, b: null, c: null, d: null, e: null, f: "t", g: 2, h: true });
  });
  it("بخشِ غیرِ شیء: اولیه می‌ماند (تا resolve رد کند)، شیءِ تودرتو null", () => {
    const snap = snapshotOverrides({ timing: 5, loop: [1], run: { x: { y: 1 } } })!;
    expect(snap["timing"]).toBe(5);
    expect(snap["loop"]).toBeNull();
    expect((snap["run"] as Record<string, unknown>)["x"]).toBeNull();
  });
  it("کلیدِ __proto__ دادهٔ عادی می‌ماند و پروتوتایپ آلوده نمی‌شود؛ خروجی بی‌پروتوتایپ است", () => {
    const raw = JSON.parse('{"__proto__":{"polluted":1},"timing":{"__proto__":2}}');
    const snap = snapshotOverrides(raw)!;
    expect(Object.getPrototypeOf(snap)).toBeNull();
    expect(Object.keys(snap).sort()).toEqual(["__proto__", "timing"]);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
  it("کلیدهای نمادین نادیده گرفته می‌شوند", () => {
    const sym = Symbol("k");
    const snap = snapshotOverrides({ [sym]: { a: 1 }, timing: { graceMs: 1 } })!;
    expect(Object.getOwnPropertySymbols(snap)).toHaveLength(0);
  });
  it("مستقل از ورودی: دست‌کاریِ بعدیِ ورودی عکس را عوض نمی‌کند", () => {
    const raw = { timing: { graceMs: 60_000 } };
    const snap = snapshotOverrides(raw)!;
    raw.timing.graceMs = 1;
    expect((snap["timing"] as Record<string, unknown>)["graceMs"]).toBe(60_000);
  });
});

describe("tool-policy-admin/canonical · canonicalOverrides", () => {
  it("کلیدها و بخش‌ها مرتب، بخشِ خالی حذف، یخ‌زده", () => {
    const snap = snapshotOverrides({ timing: { reservationTtlMs: 3, graceMs: 1 }, loop: {}, answer: { maxCards: 2 } })!;
    const c = canonicalOverrides<Record<string, Record<string, number>>>(snap);
    expect(Object.keys(c)).toEqual(["answer", "timing"]);
    expect(Object.keys(c["timing"]!)).toEqual(["graceMs", "reservationTtlMs"]);
    expect(Object.isFrozen(c) && Object.isFrozen(c["timing"])).toBe(true);
  });
  it("ترتیبِ درج بی‌اثر: stable برابر", () => {
    const a = canonicalOverrides(snapshotOverrides({ a: { x: 1, y: 2 }, b: { z: 3 } })!);
    const b = canonicalOverrides(snapshotOverrides({ b: { z: 3 }, a: { y: 2, x: 1 } })!);
    expect(stable(a)).toBe(stable(b));
  });
  it("overrides خالی ⇒ شیءِ خالی", () => {
    expect(canonicalOverrides(snapshotOverrides({})!)).toEqual({});
    expect(canonicalOverrides(snapshotOverrides({ timing: {} })!)).toEqual({});
  });
});

describe("tool-policy-admin/canonical · stable و deepFreeze", () => {
  it("مستقل از ترتیبِ کلید؛ نوع را تفکیک می‌کند؛ ترتیبِ آرایه معنادار", () => {
    expect(stable({ a: 1, b: { c: 2, d: 3 } })).toBe(stable({ b: { d: 3, c: 2 }, a: 1 }));
    expect(stable({ a: 1 })).not.toBe(stable({ a: "1" }));
    expect(stable([1, 2])).not.toBe(stable([2, 1]));
    expect(stable({ a: null })).not.toBe(stable({}));
    expect(stable(undefined)).toBe("null");
  });
  it("deepFreeze عمیق می‌بندد و دوباره‌فراخوانی بی‌خطاست", () => {
    const o = deepFreeze({ a: { b: [1, { c: 2 }] } });
    expect(Object.isFrozen(o.a.b[1])).toBe(true);
    expect(() => deepFreeze(o)).not.toThrow();
  });
});

describe("tool-policy-admin/canonical · diffPolicies", () => {
  const a = { timing: { graceMs: 90_000, maxCallMs: 36_000 }, model: { name: "calc-answer" } };
  it("یکسان ⇒ []", () => expect(diffPolicies(a, structuredClone(a))).toEqual([]));
  it("تغییر، مرتب بر پایهٔ مسیر؛ رشته و عدد", () => {
    const b = { timing: { graceMs: 60_000, maxCallMs: 36_000 }, model: { name: "x" } };
    expect(diffPolicies(a, b)).toEqual([
      { path: "model.name", from: "calc-answer", to: "x" },
      { path: "timing.graceMs", from: 90_000, to: 60_000 },
    ]);
  });
  it("مسیرهای تازه‌ای که فقط در عکسِ دوم‌اند هم مرتب در خروجی می‌آیند (نه به ترتیبِ دیده‌شدن)", () => {
    expect(diffPolicies({ timing: { graceMs: 1 } }, { timing: { graceMs: 2 }, answer: { maxCards: 3 }, loop: { maxSteps: 4 } }).map((c) => c.path)).toEqual(["answer.maxCards", "loop.maxSteps", "timing.graceMs"]);
  });
  it("مسیرِ نبوده در یک سو ⇒ null در همان سو", () => {
    expect(diffPolicies({ timing: { graceMs: 1 } }, { timing: { graceMs: 1, maxCallMs: 2 } })).toEqual([{ path: "timing.maxCallMs", from: null, to: 2 }]);
    expect(diffPolicies({ timing: { graceMs: 1, maxCallMs: 2 } }, { timing: { graceMs: 1 } })).toEqual([{ path: "timing.maxCallMs", from: 2, to: null }]);
  });
  it("ورودیِ غیرساده/بولی/تودرتو نادیده؛ بی‌استثنا", () => {
    expect(diffPolicies(null, undefined)).toEqual([]);
    expect(diffPolicies({ s: { a: true, b: { c: 1 } } }, { s: { a: false } })).toEqual([]);
  });
  it("خروجی یخ‌زده", () => expect(Object.isFrozen(diffPolicies({ s: { a: 1 } }, { s: { a: 2 } }))).toBe(true));
});

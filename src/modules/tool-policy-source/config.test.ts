import { describe, expect, it } from "vitest";
import { SOURCE_LIMITS } from "./config";
import { createPolicySource } from "./source";
import { fakeClock, MAX_STALE, REFRESH_TIMEOUT, scriptedReader, okCurrent } from "./test-kit";

const good = () => ({ reader: scriptedReader([okCurrent(1)]).reader, clock: fakeClock(), maxStaleMs: MAX_STALE, refreshTimeoutMs: REFRESH_TIMEOUT });
const issuesOf = (o: unknown): string[] => {
  const r = createPolicySource(o);
  return r.ok ? [] : [...r.error.issues];
};

describe("tool-policy-source · گزینه‌های ساخت", () => {
  it("گزینهٔ معتبر ساخته می‌شود و شیءِ یخ‌زده می‌دهد", () => {
    const r = createPolicySource(good());
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.isFrozen(r.value)).toBe(true);
  });

  it("ورودیِ غیرِ شیء، آرایه و null رد می‌شود", () => {
    for (const bad of [undefined, null, 1, "x", [], () => 0]) expect(issuesOf(bad)).toEqual(["options"]);
  });

  it("کلیدِ ناشناخته رد می‌شود و نامِ بلند بریده می‌شود (بی‌بازتابِ مقدار)", () => {
    expect(issuesOf({ ...good(), extra: 1 })).toEqual(["unknown:extra"]);
    expect(issuesOf({ ...good(), ["x".repeat(100)]: 1 })).toEqual(["unknown:?"]);
  });

  it("reader و clock الزامی‌اند و باید تابعِ لازم را داشته باشند", () => {
    expect(issuesOf({ ...good(), reader: undefined })).toEqual(["reader.current"]);
    expect(issuesOf({ ...good(), reader: {} })).toEqual(["reader.current"]);
    expect(issuesOf({ ...good(), reader: { current: 1 } })).toEqual(["reader.current"]);
    expect(issuesOf({ ...good(), clock: null })).toEqual(["clock.nowMs"]);
    expect(issuesOf({ ...good(), clock: { nowMs: "x" } })).toEqual(["clock.nowMs"]);
  });

  it("maxStaleMs و refreshTimeoutMs الزامی‌اند (بی‌پیش‌فرض) و کران‌ها دقیق‌اند", () => {
    const { maxStaleMs: S, refreshTimeoutMs: T } = SOURCE_LIMITS;
    const o = good();
    expect(issuesOf({ reader: o.reader, clock: o.clock })).toEqual(["maxStaleMs", "refreshTimeoutMs"]);
    expect(issuesOf({ ...o, maxStaleMs: S.min - 1 })).toEqual(["maxStaleMs"]);
    expect(issuesOf({ ...o, maxStaleMs: S.max + 1 })).toEqual(["maxStaleMs"]);
    expect(issuesOf({ ...o, maxStaleMs: S.min, refreshTimeoutMs: T.min })).toEqual([]);
    expect(issuesOf({ ...o, maxStaleMs: S.max, refreshTimeoutMs: T.max })).toEqual([]);
    expect(issuesOf({ ...o, refreshTimeoutMs: T.min - 1 })).toEqual(["refreshTimeoutMs"]);
    expect(issuesOf({ ...o, refreshTimeoutMs: T.max + 1 })).toEqual(["refreshTimeoutMs"]);
    for (const bad of [1.5, NaN, Infinity, "1000", null, -1000, 2 ** 60]) expect(issuesOf({ ...o, maxStaleMs: bad })).toEqual(["maxStaleMs"]);
  });

  it("رابطه: refreshTimeoutMs ≤ maxStaleMs (مرزِ دقیق)", () => {
    const o = good();
    expect(issuesOf({ ...o, maxStaleMs: 2_000, refreshTimeoutMs: 2_000 })).toEqual([]);
    expect(issuesOf({ ...o, maxStaleMs: 2_000, refreshTimeoutMs: 2_001 })).toEqual(["relation:refreshTimeoutMs<=maxStaleMs"]);
  });

  it("خطای پیکربندی متنِ ثابت است و مقدارِ ورودی را بازتاب نمی‌دهد", () => {
    const r = createPolicySource({ ...good(), maxStaleMs: "SECRET-VALUE-123" });
    expect(JSON.stringify(r)).not.toContain("SECRET-VALUE-123");
    if (!r.ok) expect(r.error.code).toBe("INVALID_CONFIG");
  });

  it("دسترسیِ پرتاب‌کننده به کلیدها (getter) ⇒ نامعتبر، نه استثنا", () => {
    const evil = {
      get reader(): never {
        throw new Error("boom");
      },
      clock: fakeClock(),
      maxStaleMs: MAX_STALE,
      refreshTimeoutMs: REFRESH_TIMEOUT,
    };
    expect(issuesOf(evil)).toEqual(["options"]);
    const evilMethod = { reader: { get current(): never { throw new Error("x"); } }, clock: fakeClock(), maxStaleMs: MAX_STALE, refreshTimeoutMs: REFRESH_TIMEOUT };
    expect(issuesOf(evilMethod)).toEqual(["reader.current"]);
  });

  it("خواننده با this درست صدا زده می‌شود و تابعِ current یک‌بار گرفته می‌شود (جایگزینیِ بعدی بی‌اثر)", async () => {
    let calls = 0;
    const reader = {
      tag: "mine",
      current(this: { tag: string }) {
        calls += 1;
        expect(this.tag).toBe("mine");
        return Promise.resolve(okCurrent(1));
      },
    };
    const r = createPolicySource({ reader, clock: fakeClock(), maxStaleMs: MAX_STALE, refreshTimeoutMs: REFRESH_TIMEOUT });
    if (!r.ok) throw new Error("x");
    reader.current = () => Promise.reject(new Error("swapped"));
    expect((await r.value.refresh()).ok).toBe(true);
    expect(calls).toBe(1);
  });
});

describe("tool-policy-source · کران‌های عددی (مقدارِ لفظی، نه از خودِ ثابت)", () => {
  const o = () => ({ reader: scriptedReader([okCurrent(1)]).reader, clock: fakeClock() });
  it("کران‌ها دقیقاً همین‌اند", () => {
    expect(SOURCE_LIMITS).toEqual({ maxStaleMs: { min: 1_000, max: 86_400_000 }, refreshTimeoutMs: { min: 100, max: 300_000 } });
  });
  it("مرزهای لفظی: maxStaleMs [۱۰۰۰ تا ۸۶٬۴۰۰٬۰۰۰]، refreshTimeoutMs [۱۰۰ تا ۳۰۰٬۰۰۰]", () => {
    expect(issuesOf({ ...o(), maxStaleMs: 999, refreshTimeoutMs: 100 })).toEqual(["maxStaleMs"]);
    expect(issuesOf({ ...o(), maxStaleMs: 1_000, refreshTimeoutMs: 100 })).toEqual([]);
    expect(issuesOf({ ...o(), maxStaleMs: 86_400_000, refreshTimeoutMs: 300_000 })).toEqual([]);
    expect(issuesOf({ ...o(), maxStaleMs: 86_400_001, refreshTimeoutMs: 300_000 })).toEqual(["maxStaleMs"]);
    expect(issuesOf({ ...o(), maxStaleMs: 86_400_000, refreshTimeoutMs: 99 })).toEqual(["refreshTimeoutMs"]);
    expect(issuesOf({ ...o(), maxStaleMs: 86_400_000, refreshTimeoutMs: 300_001 })).toEqual(["refreshTimeoutMs"]);
  });
});


import { describe, expect, it } from "vitest";
import { REFRESHER_LIMITS } from "./config";
import { createPolicyRefresher } from "./refresher";
import { controlledSource, DEADLINE, fakeTimer, goodOptions, INTERVAL, MAX_STALE, REFRESH_TIMEOUT, RETRY } from "./test-kit";

const base = () => goodOptions(controlledSource().source, fakeTimer().timer);
const issuesOf = (o: unknown): string[] => {
  const r = createPolicyRefresher(o as never);
  return r.ok ? [] : [...r.error.issues];
};
const withKeys = (extra: Record<string, unknown>): unknown => ({ ...base(), ...extra });

describe("tool-policy-refresher · گزینه‌های ساخت", () => {
  it("گزینهٔ معتبر ساخته می‌شود", () => {
    expect(createPolicyRefresher(base()).ok).toBe(true);
  });

  it("ورودیِ غیرِ شیء، آرایه و null رد می‌شود", () => {
    for (const bad of [undefined, null, 1, "x", [], () => 0]) expect(issuesOf(bad)).toEqual(["options"]);
  });

  it("کلیدِ ناشناخته رد می‌شود و نامِ بلند بریده می‌شود (بی‌بازتابِ مقدار)", () => {
    expect(issuesOf(withKeys({ extra: 1 }))).toEqual(["unknown:extra"]);
    expect(issuesOf(withKeys({ ["x".repeat(100)]: 1 }))).toEqual(["unknown:?"]);
    expect(issuesOf(withKeys({ ["x".repeat(40)]: 1 }))).toEqual([`unknown:${"x".repeat(40)}`]);
  });

  it("source و timer باید تابعِ لازم را داشته باشند؛ هر کدام جدا گزارش می‌شود", () => {
    expect(issuesOf(withKeys({ source: undefined }))).toEqual(["source.refresh"]);
    expect(issuesOf(withKeys({ source: {} }))).toEqual(["source.refresh"]);
    expect(issuesOf(withKeys({ source: { refresh: 1 } }))).toEqual(["source.refresh"]);
    expect(issuesOf(withKeys({ timer: undefined }))).toEqual(["timer.after", "timer.cancel"]);
    expect(issuesOf(withKeys({ timer: { after: () => 0 } }))).toEqual(["timer.cancel"]);
    expect(issuesOf(withKeys({ timer: { cancel: () => 0 } }))).toEqual(["timer.after"]);
  });

  it("دسترسیِ پرتاب‌کننده به source/timer نامعتبر است و متنِ استثنا بیرون نمی‌آید", () => {
    const boom = (): never => {
      throw new Error("secret-boom");
    };
    const src = Object.defineProperty({}, "refresh", { get: boom });
    const tmr = Object.defineProperty({ cancel: () => 0 }, "after", { get: boom });
    const r = createPolicyRefresher(withKeys({ source: src, timer: tmr }) as never);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect([...r.error.issues]).toEqual(["source.refresh", "timer.after"]);
      expect(JSON.stringify(r.error)).not.toContain("secret");
    }
  });

  it("گزینهٔ با getterِ پرتاب‌کننده روی خودِ options ⇒ options", () => {
    const o = { ...base() };
    Object.defineProperty(o, "intervalMs", {
      enumerable: true,
      get: () => {
        throw new Error("secret-boom");
      },
    });
    expect(issuesOf(o)).toEqual(["options"]);
  });

  it("پنج عددِ زمان‌بندی: غیرعدد، اعشار، NaN، Infinity، بیرونِ بازه و مرزها", () => {
    const L = REFRESHER_LIMITS;
    const cases: [string, { min: number; max: number }][] = [
      ["intervalMs", L.intervalMs],
      ["retryMs", L.retryMs],
      ["attemptDeadlineMs", L.attemptDeadlineMs],
      ["refreshTimeoutMs", L.refreshTimeoutMs],
      ["maxStaleMs", L.maxStaleMs],
    ];
    for (const [key, r] of cases) {
      for (const bad of ["5000", 1.5, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, r.min - 1, r.max + 1]) {
        expect(issuesOf(withKeys({ [key]: bad })), `${key}=${String(bad)}`).toContain(key);
      }
    }
  });

  it("مقدارِ لفظیِ کران‌ها (قفل: تغییرِ ناخواسته قرمز می‌شود)", () => {
    expect(REFRESHER_LIMITS.intervalMs).toEqual({ min: 1_000, max: 3_600_000 });
    expect(REFRESHER_LIMITS.retryMs).toEqual({ min: 100, max: 3_600_000 });
    expect(REFRESHER_LIMITS.attemptDeadlineMs).toEqual({ min: 100, max: 300_000 });
    expect(REFRESHER_LIMITS.refreshTimeoutMs).toEqual({ min: 100, max: 300_000 });
    expect(REFRESHER_LIMITS.maxStaleMs).toEqual({ min: 1_000, max: 86_400_000 });
    expect(Object.isFrozen(REFRESHER_LIMITS)).toBe(true);
  });

  it("رابطهٔ retryMs ≤ intervalMs: برابر مجاز، یکی بیشتر رد", () => {
    expect(issuesOf(withKeys({ retryMs: INTERVAL }))).toEqual([]);
    expect(issuesOf(withKeys({ retryMs: INTERVAL + 1 }))).toEqual(["relation:retryMs<=intervalMs"]);
  });

  it("رابطهٔ refreshTimeoutMs ≤ attemptDeadlineMs: برابر مجاز، یکی بیشتر رد", () => {
    expect(issuesOf(withKeys({ refreshTimeoutMs: DEADLINE }))).toEqual([]);
    expect(issuesOf(withKeys({ refreshTimeoutMs: DEADLINE + 1 }))).toEqual(["relation:refreshTimeoutMs<=attemptDeadlineMs"]);
    expect(REFRESH_TIMEOUT).toBeLessThan(DEADLINE);
  });

  it("رابطهٔ تحملِ یک چرخهٔ ازدست‌رفته: interval + 3·deadline + retry ≤ maxStaleMs؛ برابر مجاز، یکی کمتر رد", () => {
    const need = INTERVAL + 3 * DEADLINE + RETRY;
    expect(issuesOf(withKeys({ maxStaleMs: need }))).toEqual([]);
    expect(issuesOf(withKeys({ maxStaleMs: need - 1 }))).toEqual(["relation:interval+3*attemptDeadline+retry<=maxStaleMs"]);
    expect(need).toBeLessThanOrEqual(MAX_STALE);
  });

  it("رابطه‌ها فقط وقتی سنجیده می‌شوند که عددهای مربوط معتبرند (بی‌گزارشِ دوگانه)", () => {
    expect(issuesOf(withKeys({ intervalMs: "x", maxStaleMs: 1_000 }))).toEqual(["intervalMs"]);
    expect(issuesOf(withKeys({ attemptDeadlineMs: "x", refreshTimeoutMs: 100_000 }))).toEqual(["attemptDeadlineMs"]);
  });

  it("پیامِ خطا ثابت و فقط نامِ فیلد (بی‌بازتابِ مقدار)", () => {
    const r = createPolicyRefresher(withKeys({ intervalMs: "secret-value" }) as never);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_CONFIG");
      expect(JSON.stringify(r.error)).not.toContain("secret");
      expect(Object.isFrozen(r.error)).toBe(true);
      expect(Object.isFrozen(r.error.issues)).toBe(true);
    }
  });

  it("issues حداکثر ۲۰ مورد", () => {
    const o: Record<string, unknown> = { ...(base() as object) };
    for (let i = 0; i < 40; i++) o[`k${i}`] = 1;
    expect(issuesOf(o)).toHaveLength(20);
  });

  it("this برای source و timer حفظ می‌شود (متدِ کلاس‌گونه)", async () => {
    let seen: unknown = null;
    const source = {
      tag: "S",
      refresh(this: { tag: string }) {
        seen = this.tag;
        return Promise.resolve({ ok: true });
      },
    };
    const timer = {
      tag: "T",
      n: 0,
      after(this: { tag: string; n: number }, _fn: () => void, _ms: number) {
        this.n += 1;
        return { id: this.n };
      },
      cancel(this: { tag: string }, _h: unknown) {
        void this.tag;
      },
    };
    const r = createPolicyRefresher(goodOptions(source, timer));
    if (!r.ok) throw new Error("x");
    r.value.start();
    await Promise.resolve();
    expect(seen).toBe("S");
    expect(timer.n).toBeGreaterThan(0);
  });

  it("عددِ اعشاریِ داخلِ بازه رد می‌شود (فقط عددِ صحیح)", () => {
    for (const key of ["intervalMs", "retryMs", "attemptDeadlineMs", "refreshTimeoutMs", "maxStaleMs"]) {
      const v = key === "maxStaleMs" ? 30_000.5 : key === "intervalMs" ? 5_000.5 : 150.5;
      expect(issuesOf(withKeys({ [key]: v })), key).toContain(key);
    }
  });

  it("رابطهٔ تحمل با عددِ نامعتبرِ عددی‌نما دوباره گزارش نمی‌شود (فقط خودِ فیلد)", () => {
    expect(issuesOf(withKeys({ intervalMs: 500, maxStaleMs: 20_000 }))).toEqual(["intervalMs"]);
    expect(issuesOf(withKeys({ retryMs: 50, maxStaleMs: 20_000, intervalMs: 1_000 }))).toEqual(["retryMs"]);
    expect(issuesOf(withKeys({ attemptDeadlineMs: 50_000_000, maxStaleMs: 86_400_000, refreshTimeoutMs: 100 }))).toEqual(["attemptDeadlineMs"]);
  });

  it("this برای cancel هم حفظ می‌شود (cancelِ پرتاب‌کننده بی‌صدا بلعیده می‌شود، پس اثرِ آن را مستقیم می‌سنجیم)", async () => {
    let seen: unknown = null;
    const timer = {
      tag: "T",
      after: () => ({}),
      cancel(this: { tag: string }, _h: unknown) {
        seen = this.tag;
      },
    };
    const r = createPolicyRefresher(goodOptions({ refresh: () => Promise.resolve({ ok: true }) }, timer));
    if (!r.ok) throw new Error("x");
    r.value.start();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(seen).toBe("T");
  });
});

import { describe, expect, it } from "vitest";
import { drawUnit, sanitizeUnit } from "./backoff";
import { computeBackoff } from "./index";
import type { JitterMode } from "./resilience-types";

const bo = (retryNumber: number, jitter: JitterMode = "none", unit = 1, baseDelayMs = 100, maxDelayMs = 1000) => computeBackoff({ retryNumber, baseDelayMs, maxDelayMs, jitter, unit });

describe("backoff · نمایی با سقف", () => {
  it("جدول: ۱۰۰، ۲۰۰، ۴۰۰، ۸۰۰ و سپس سقف ۱۰۰۰", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((k) => bo(k))).toEqual([100, 200, 400, 800, 1000, 1000, 1000]);
  });
  it("پایهٔ صفر همیشه صفر؛ سقفِ کمتر از پایه سقف را اعمال می‌کند", () => {
    expect([1, 2, 9].map((k) => bo(k, "none", 1, 0, 1000))).toEqual([0, 0, 0]);
    expect(bo(1, "none", 1, 500, 300)).toBe(300);
  });
  it("شمارهٔ تلاشِ غیرمعمول بی‌سرریز و بی‌پرتاب است (NaN، منفی، صفر، اعشاری، بسیار بزرگ)", () => {
    expect(bo(Number.NaN)).toBe(100);
    expect(bo(-5)).toBe(100);
    expect(bo(0)).toBe(100);
    expect(bo(2.9)).toBe(200);
    expect(bo(1e9)).toBe(1000);
    expect(bo(Number.POSITIVE_INFINITY)).toBe(100); // نامتناهی = نامعتبر ⇒ ۱
    expect(computeBackoff({ retryNumber: 1e9, baseDelayMs: 60_000, maxDelayMs: 600_000, jitter: "none", unit: 1 })).toBe(600_000);
  });
});

describe("backoff · jitter", () => {
  it("none: unit نادیده گرفته می‌شود", () => {
    expect([0, 0.3, 1].map((u) => bo(3, "none", u))).toEqual([400, 400, 400]);
  });
  it("full: ⌊raw·u⌋ — ۰ تا raw", () => {
    expect(bo(3, "full", 0)).toBe(0);
    expect(bo(3, "full", 0.5)).toBe(200);
    expect(bo(3, "full", 0.999)).toBe(399);
    expect(bo(3, "full", 1)).toBe(400);
  });
  it("equal: ⌊raw/2 + raw/2·u⌋ — نیمهٔ raw تا raw (کف دارد)", () => {
    expect(bo(3, "equal", 0)).toBe(200);
    expect(bo(3, "equal", 0.5)).toBe(300);
    expect(bo(3, "equal", 1)).toBe(400);
    expect(bo(1, "equal", 0, 101, 1000)).toBe(50); // raw فرد ⇒ کف
    expect(bo(1, "equal", 1, 101, 1000)).toBe(101);
  });
  it("jitter روی raw پس از سقف اعمال می‌شود (نه پیش از آن)", () => {
    expect(bo(9, "full", 0.5)).toBe(500);
  });
  it("unit نامعتبر در خود computeBackoff هم به ۱ می‌افتد (بی‌کاهش)", () => {
    for (const u of [Number.NaN, -1, 2, Number.POSITIVE_INFINITY, "0.5" as unknown as number]) {
      expect(bo(3, "full", u)).toBe(400);
      expect(bo(3, "equal", u)).toBe(400);
    }
  });
});

describe("backoff · sanitizeUnit و drawUnit", () => {
  it("بازهٔ بستهٔ [۰،۱] می‌گذرد؛ هر چیز دیگر ۱ می‌شود", () => {
    for (const ok of [0, 0.25, 1]) expect(sanitizeUnit(ok)).toBe(ok);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -0.0001, 1.0001, "0.5", null, undefined, {}, [], true]) expect(sanitizeUnit(bad)).toBe(1);
  });
  it("drawUnit: منبع نیست، پرتاب می‌کند یا نامعتبر می‌دهد ⇒ ۱؛ مقدار معتبر عبور می‌کند", () => {
    expect(drawUnit(null)).toBe(1);
    expect(drawUnit({ next: () => { throw new Error("x"); } })).toBe(1);
    expect(drawUnit({ next: () => Number.NaN })).toBe(1);
    expect(drawUnit({ next: () => 0.25 })).toBe(0.25);
    expect(drawUnit({ next: () => 0 })).toBe(0);
  });
});

describe("backoff · تفاضلی در برابر اوراکل مستقل (BigInt و کسر دقیق)", () => {
  function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const oracle = (k: number, base: number, max: number, jitter: JitterMode, num: number): number => {
    // u = num/1024 دقیق؛ همه‌چیز عدد صحیح BigInt.
    let raw = BigInt(base);
    for (let e = 0; e < Math.min(k - 1, 60); e++) raw = raw * BigInt(2);
    if (raw > BigInt(max)) raw = BigInt(max);
    const n = BigInt(num);
    if (jitter === "none") return Number(raw);
    if (jitter === "full") return Number((raw * n) / BigInt(1024));
    return Number((raw * (BigInt(1024) + n)) / BigInt(2048));
  };
  it("۳۰۰۰ ورودی تصادفی + ناورداها (در بازه، یکنوا در u و در شمارهٔ تلاش)", () => {
    const r = rng(42);
    const modes: JitterMode[] = ["none", "full", "equal"];
    for (let i = 0; i < 3000; i++) {
      const base = Math.floor(r() * 60_001);
      const max = base + Math.floor(r() * (600_000 - base + 1));
      const k = 1 + Math.floor(r() * 12);
      const num = Math.floor(r() * 1025);
      const jitter = modes[Math.floor(r() * 3)] as JitterMode;
      const got = computeBackoff({ retryNumber: k, baseDelayMs: base, maxDelayMs: max, jitter, unit: num / 1024 });
      expect(got, `base=${base} max=${max} k=${k} ${jitter} u=${num}/1024`).toBe(oracle(k, base, max, jitter, num));
      expect(got).toBeGreaterThanOrEqual(0);
      expect(got).toBeLessThanOrEqual(max);
      if (num < 1024) expect(computeBackoff({ retryNumber: k, baseDelayMs: base, maxDelayMs: max, jitter, unit: (num + 1) / 1024 })).toBeGreaterThanOrEqual(got);
      expect(computeBackoff({ retryNumber: k + 1, baseDelayMs: base, maxDelayMs: max, jitter, unit: num / 1024 })).toBeGreaterThanOrEqual(got);
    }
  });
});

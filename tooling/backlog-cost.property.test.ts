/**
 * tooling/backlog-cost · خاصیتی (بذرِ ثابت، مرجعِ مستقل از پیاده‌سازی): ناورداهای آماری، وارونیِ افق، یکنوایی و بی‌پرتابیِ حکم و تجزیهٔ آرگومان.
 */
import { describe, expect, it } from "vitest";
import { COST_LIMITS, COST_POLICY, fitLinear, horizonRows, judgeCost, parseCostArgs, summarizeSamples } from "./backlog-cost";
import type { PlanSummary, ScenarioMeasure } from "./backlog-cost";

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (r: () => number, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
const SEEDS = Array.from({ length: 40 }, (_, i) => 1000 + i * 7919);

describe("backlog-cost · خاصیتی", () => {
  it("summarizeSamples: min ≤ median ≤ p95 ≤ max؛ p95 عضوِ نمونه‌هاست؛ تغییرناپذیر نسبت به جایگشت؛ مرجعِ مرتب‌سازیِ جدا", () => {
    for (const seed of SEEDS) {
      const r = rng(seed);
      const n = int(r, 1, 60);
      const xs = Array.from({ length: n }, () => Math.round(r() * 10_000) / 10);
      const a = summarizeSamples(xs);
      const shuffled = [...xs].sort(() => r() - 0.5);
      const b = summarizeSamples(shuffled);
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      expect(b.value).toEqual(a.value);
      const s = a.value;
      expect(s.minMs <= s.medianMs && s.medianMs <= s.p95Ms && s.p95Ms <= s.maxMs).toBe(true);
      expect(xs).toContain(s.p95Ms);
      // مرجع: شمارشِ «چند نمونه ≤ p95» باید دست‌کم ۹۵٪ باشد و کمتر از آن، با حذفِ خودِ p95، کمتر از ۹۵٪.
      const atOrBelow = xs.filter((x) => x <= s.p95Ms).length;
      const strictlyBelow = xs.filter((x) => x < s.p95Ms).length;
      expect(atOrBelow / n).toBeGreaterThanOrEqual(0.95);
      expect(strictlyBelow / n).toBeLessThan(0.95);
    }
  });

  it("fitLinear/horizonRows: خطِ دقیق بازیابی می‌شود؛ افق وارونِ خط است (h ≤ بودجه < h+1) و در بودجه یکنواست", () => {
    for (const seed of SEEDS) {
      const r = rng(seed);
      const slope = (int(r, 1, 5000) / 1e6) * (r() < 0.5 ? 1 : 3);
      const intercept = int(r, 0, 2000) / 100;
      const xs = Array.from(new Set(Array.from({ length: int(r, 2, 8) }, () => int(r, 1, 2_000_000)))).sort((a, b) => a - b);
      if (xs.length < 2) continue;
      const f = fitLinear(xs.map((x) => ({ x, y: slope * x + intercept })));
      expect(f.ok).toBe(true);
      if (!f.ok) return;
      expect(f.value.slope).toBeCloseTo(slope, 9);
      expect(Math.abs(f.value.intercept - intercept)).toBeLessThan(1e-3);
      expect(f.value.r2).toBeGreaterThan(0.999999);
      const b1 = intercept + int(r, 1, 10_000);
      const b2 = b1 + int(r, 1, 10_000);
      const h1 = horizonRows(f.value, b1) as number;
      const h2 = horizonRows(f.value, b2) as number;
      expect(h2).toBeGreaterThanOrEqual(h1);
      expect(f.value.slope * h1 + f.value.intercept).toBeLessThanOrEqual(b1 + 1e-6);
      expect(f.value.slope * (h1 + 1) + f.value.intercept).toBeGreaterThan(b1 - 1e-6);
    }
  });

  const plan = (r: () => number): PlanSummary => ({
    executionMs: 1,
    planningMs: 1,
    sharedHitBlocks: 0,
    sharedReadBlocks: 0,
    outboxRowsScanned: int(r, 0, 300_000),
    ackRowsTouched: 0,
    returnedRows: int(r, 0, 1000),
    nodeTypes: [],
    indexes: [],
    seqScanOnOutbox: false,
    sortNode: false,
  });
  const RANK = { ok: 0, warn: 1, fail: 2 } as const;

  it("judgeCost: یکنوا (کندترشدنِ خواندن هرگز حکم را بهتر نمی‌کند)، بی‌پرتاب، و حکمِ کل = بیشینهٔ رتبه‌ها", () => {
    for (const seed of SEEDS) {
      const r = rng(seed);
      const budget = { timeoutMs: int(r, 1, 20_000), intervalMs: int(r, 1, 100_000) };
      const base = int(r, 0, 25_000);
      const mk = (p95: number, label: string): ScenarioMeasure => ({
        label,
        deadRows: int(r, 0, 200_000),
        stats: { n: 7, minMs: 0, medianMs: p95 / 2, p95Ms: p95, maxMs: p95 },
        plan: plan(r),
      });
      const m = mk(base, "a");
      const slower: ScenarioMeasure = { ...m, stats: { ...m.stats, medianMs: m.stats.medianMs + int(r, 0, 5000), p95Ms: m.stats.p95Ms + int(r, 0, 5000) } };
      const a = judgeCost([m], budget);
      const b = judgeCost([slower], budget);
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      expect(RANK[b.value.status]).toBeGreaterThanOrEqual(RANK[a.value.status]);
      const many = judgeCost([m, slower, mk(int(r, 0, 25_000), "c")], budget);
      if (!many.ok) throw new Error("many");
      expect(RANK[many.value.status]).toBe(Math.max(...many.value.scenarios.map((s) => RANK[s.status])));
      // fail ⇔ دلیلِ READ_EXCEEDS_TIMEOUT
      for (const s of many.value.scenarios) expect(s.status === "fail").toBe(s.reasons.includes("READ_EXCEEDS_TIMEOUT"));
    }
    expect(COST_POLICY.nearTimeoutFraction).toBeLessThan(1);
  });

  it("judgeCost/summarizeSamples/fitLinear/horizonRows روی ورودیِ خراب (NaN، منفی، رشته، null، شیءِ تهی) هرگز نمی‌پرتابد؛ judgeCost ⇒ BAD_MEASURE", () => {
    const junk: unknown[] = [NaN, -1, Infinity, "x", null, undefined, {}, [], [[]], { stats: null }, { stats: {}, plan: {} }, { label: "a", deadRows: 1, stats: { medianMs: "1", p95Ms: 1 }, plan: { outboxRowsScanned: 1, returnedRows: 1 } }];
    for (const j of junk) {
      expect(judgeCost([j as never], { timeoutMs: 1, intervalMs: 1 })).toEqual({ ok: false, error: { code: "BAD_MEASURE" } });
      if (!Array.isArray(j)) expect(judgeCost(j as never, { timeoutMs: 1, intervalMs: 1 })).toEqual({ ok: false, error: { code: "BAD_MEASURE" } });
      expect(() => summarizeSamples(j as never)).not.toThrow();
      expect(() => fitLinear(j as never)).not.toThrow();
      expect(() => horizonRows(j as never, 5)).not.toThrow();
    }
  });

  it("parseCostArgs: روی رشته‌های تصادفی هرگز نمی‌پرتابد و رشتهٔ قناری را هرگز پژواک نمی‌کند", () => {
    const alphabet = "abc-=,0123456789۰۱ \n$%'\"";
    for (const seed of SEEDS) {
      const r = rng(seed);
      const canary = `CANARY${int(r, 1000, 9999)}`;
      const argv = Array.from({ length: int(r, 0, 4) }, () => {
        const body = Array.from({ length: int(r, 0, 12) }, () => alphabet[int(r, 0, alphabet.length - 1)]).join("");
        const flag = ["--scales=", "--limit=", "--format=", "--x=", "", "--"][int(r, 0, 5)] as string;
        return `${flag}${body}${r() < 0.3 ? canary : ""}`;
      });
      const res = parseCostArgs(argv);
      if (!res.ok) expect(JSON.stringify(res)).not.toContain("CANARY");
      else {
        expect(res.value.scales.length).toBeGreaterThan(0);
        expect(Math.max(...res.value.scales) + res.value.unacked + res.value.done).toBeLessThanOrEqual(COST_LIMITS.maxRows);
        for (let i = 1; i < res.value.scales.length; i++) expect(res.value.scales[i]).toBeGreaterThan(res.value.scales[i - 1] as number);
      }
    }
  });
});

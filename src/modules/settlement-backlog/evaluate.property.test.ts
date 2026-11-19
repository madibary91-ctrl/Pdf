/**
 * settlement-backlog · خاصیتی (مرجعِ مستقل): ۴۰ بذر × ۴۰۰ مورد. مدلِ مرجع جدا از `evaluate.ts` و با ساختاری دیگر نوشته شده
 * (جدولِ رتبه به‌جای مرتب‌سازی، نمونهٔ خام به‌جای تجزیه)؛ ناورداها: هم‌ارزیِ کامل، یکنوایی، بی‌پرتاب، شکستِ بسته روی نمونهٔ خراب‌شده.
 */
import { describe, expect, it } from "vitest";
import type { BacklogHealth } from "./index";
import { T0, TH, monitorOf } from "./test-kit";

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
/** مرزها را عمداً پرتکرار می‌کند. */
const near = (r: () => number, edge: number): number => Math.max(0, edge + int(r, -2, 2));

const REASONS = ["EXPIRED_UNBILLED", "ATTEMPTS_EXHAUSTED", "LEDGER_REJECTED"] as const;
const RANK = { ok: 0, degraded: 1, down: 2 } as const;

type Case = { sample: Record<string, unknown>; nowMs: number };

function validSample(r: () => number): { sample: Record<string, unknown>; atMs: number; count: number; oldest: number | null; undated: number } {
  const atMs = int(r, 0, 20_000);
  const count = r() < 0.3 ? int(r, 0, TH.sampleLimit) : [0, TH.degradedCount, TH.downCount, TH.sampleLimit][int(r, 0, 3)] ?? 0;
  const undated = count === 0 ? 0 : r() < 0.25 ? int(r, 1, count) : 0;
  const oldest = undated === count ? null : r() < 0.5 ? near(r, atMs - TH.degradedAfterMs) : near(r, atMs - TH.downAfterMs);
  const split: Record<string, number> = { EXPIRED_UNBILLED: 0, ATTEMPTS_EXHAUSTED: 0, LEDGER_REJECTED: 0 };
  for (let i = 0; i < count; i++) {
    const k = REASONS[int(r, 0, 2)] as string;
    split[k] = (split[k] ?? 0) + 1;
  }
  return {
    atMs,
    count,
    oldest,
    undated,
    sample: { ok: true, atMs, count, truncated: count === TH.sampleLimit, oldestDeadAtMs: oldest, undated, byReason: split },
  };
}

/** مدلِ مرجع: برای نمونهٔ معتبر، مجموعهٔ دلیل‌ها و وضعیت را مستقل می‌سازد. */
function model(sample: Record<string, unknown>, nowMs: number): { codes: string[]; status: keyof typeof RANK } {
  const out = new Map<string, number>(); // code → rank (1 degraded, 2 down)
  const sev = (code: string, rank: number) => out.set(code, rank);
  const atMs = sample["atMs"] as number;
  const count = sample["count"] as number;
  const oldest = sample["oldestDeadAtMs"] as number | null;
  const undated = sample["undated"] as number;
  let behind = false;
  if (nowMs < atMs) behind = true;
  else if (nowMs - atMs > TH.sampleMaxAgeMs) sev("SAMPLE_STALE", 1);
  if (count >= TH.downCount) sev("COUNT_CRITICAL", 2);
  else if (count >= TH.degradedCount) sev("COUNT_HIGH", 1);
  if (oldest !== null) {
    if (nowMs < oldest) behind = true;
    else if (nowMs - oldest > TH.downAfterMs) sev("OLDEST_STUCK", 2);
    else if (nowMs - oldest > TH.degradedAfterMs) sev("OLDEST_AGED", 1);
  }
  if (undated > 0) sev("AGE_UNKNOWN", 1);
  if (behind) sev("CLOCK_BEHIND", 1);
  const worst = Math.max(0, ...out.values());
  return { codes: [...out.keys()].sort(), status: (["ok", "degraded", "down"] as const)[worst] as keyof typeof RANK };
}

const m = monitorOf();
const run = (c: Case): BacklogHealth => m.evaluate({ sample: c.sample, nowMs: c.nowMs });

describe("settlement-backlog · ارزیابِ خاصیتی (مرجعِ مستقل)", () => {
  it("۴۰ بذر × ۴۰۰ مورد: دلیل‌ها، وضعیت، سن‌ها و ترتیبِ down-اول با مدلِ مرجع یکی است", () => {
    let nonOk = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed * 7919);
      for (let i = 0; i < 400; i++) {
        const v = validSample(r);
        const nowMs = r() < 0.15 ? int(r, 0, v.atMs) : v.atMs + [0, TH.sampleMaxAgeMs, TH.sampleMaxAgeMs + 1, int(r, 0, 12_000)][int(r, 0, 3)]!;
        const h = run({ sample: v.sample, nowMs });
        const want = model(v.sample, nowMs);
        expect(h.reasons.map((x) => x.code).sort(), `seed=${seed} i=${i}`).toEqual(want.codes);
        expect(h.status, `seed=${seed} i=${i}`).toBe(want.status);
        const ranks = h.reasons.map((x) => (x.severity === "down" ? 2 : 1));
        expect([...ranks].sort((a, b) => b - a)).toEqual(ranks);
        expect(h.count).toBe(v.count);
        expect(h.oldestAgeMs).toBe(v.oldest !== null && nowMs >= v.oldest ? nowMs - v.oldest : null);
        expect(h.sampleAgeMs).toBe(nowMs >= v.atMs ? nowMs - v.atMs : null);
        if (want.status !== "ok") nonOk++;
      }
    }
    expect(nonOk).toBeGreaterThan(2000);
  });

  it("یکنوایی: با ثابتِ نمونه و now ≥ max(atMs، قدیمی‌ترین)، جلو رفتنِ ساعت هرگز وضعیت را بهتر نمی‌کند", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed * 104729);
      for (let i = 0; i < 100; i++) {
        const v = validSample(r);
        const base = Math.max(v.atMs, v.oldest ?? 0);
        let prev = -1;
        for (let d = 0, t = base; d < 12; d++, t += int(r, 0, 3_000)) {
          const cur = RANK[run({ sample: v.sample, nowMs: t }).status];
          expect(cur, `seed=${seed} i=${i} t=${t}`).toBeGreaterThanOrEqual(prev);
          prev = cur;
        }
      }
    }
  });

  it("یکنوایی در شمار: با ثابتِ بقیه، افزودنِ مرده هرگز وضعیت را بهتر نمی‌کند", () => {
    for (let c = 1; c <= TH.sampleLimit; c++) {
      const mk = (n: number) => run({ sample: { ok: true, atMs: T0, count: n, truncated: n === TH.sampleLimit, oldestDeadAtMs: T0, undated: 0, byReason: { EXPIRED_UNBILLED: 0, ATTEMPTS_EXHAUSTED: n, LEDGER_REJECTED: 0 } }, nowMs: T0 });
      expect(RANK[mk(c).status]).toBeGreaterThanOrEqual(RANK[mk(c - 1 >= 1 ? c - 1 : 1).status]);
    }
  });

  it("نمونهٔ معتبری که یک فیلدش تصادفی خراب شود هرگز ok نیست (شکستِ بسته) و نمی‌پرتابد", () => {
    const junk: unknown[] = [undefined, null, -1, 1.5, "7", Number.NaN, {}, [], true, 10 ** 16];
    const fields = ["ok", "atMs", "count", "truncated", "oldestDeadAtMs", "undated", "byReason"];
    let checked = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed * 15485863);
      for (let i = 0; i < 100; i++) {
        const v = validSample(r);
        const f = fields[int(r, 0, fields.length - 1)] as string;
        const bad = junk[int(r, 0, junk.length - 1)];
        if (JSON.stringify(v.sample[f]) === JSON.stringify(bad)) continue;
        const s = { ...v.sample, [f]: bad };
        const h = run({ sample: s, nowMs: v.atMs });
        expect(h.status, `seed=${seed} i=${i} ${f}=${String(bad)}`).not.toBe("ok");
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(3000);
  });

  it("ورودیِ کاملاً تصادفی (شکل‌های دلخواه) هرگز نمی‌پرتابد و همیشه نتیجهٔ کاملِ منجمد می‌دهد", () => {
    const vals: unknown[] = [undefined, null, 0, 1, -1, 2 ** 53, "x", "", [], [1], {}, { ok: true }, { ok: false }, true, () => 1, Symbol("s"), BigInt(10)];
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed * 32452843);
      for (let i = 0; i < 100; i++) {
        const input = r() < 0.2 ? vals[int(r, 0, vals.length - 1)] : { sample: vals[int(r, 0, vals.length - 1)], nowMs: vals[int(r, 0, vals.length - 1)] };
        const h = m.evaluate(input);
        expect(["ok", "degraded", "down"]).toContain(h.status);
        expect(Object.isFrozen(h)).toBe(true);
        expect(h.thresholds).toEqual({ degradedCount: 3, downCount: 5, degradedAfterMs: 1000, downAfterMs: 5000, sampleMaxAgeMs: 2000 });
      }
    }
  });
});

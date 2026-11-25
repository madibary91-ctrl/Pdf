import { describe, expect, it } from "vitest";
import { checkPolicyRelations, DEFAULT_TOOL_POLICY, projectToolPolicy, resolveToolPolicy } from "./index";
import { prng } from "./test-kit";

/**
 * داورِ مستقل (بازنویسیِ ساده و جدا از کدِ تولیدی): سیاستِ مؤثر معتبر است اگر و فقط اگر این گزاره‌ها برقرار باشند.
 * عددهای کرانِ فیلد به‌صورت ثابت اینجا آمده تا اگر کدِ تولیدی کرانی را عوض کرد آزمون قرمز شود.
 */
const referee = (t: { graceMs: number; maxCallMs: number; ttl: number; modelTimeoutMs: number; total: number }): boolean =>
  t.maxCallMs >= 1 && t.maxCallMs <= 600_000 &&
  t.graceMs >= 30_000 && t.graceMs <= 43_200_000 &&
  t.ttl >= 1_000 && t.ttl <= 86_400_000 &&
  t.modelTimeoutMs >= 1 && t.modelTimeoutMs <= 600_000 &&
  t.total >= 1_000 && t.total <= 600_000 &&
  t.maxCallMs < t.graceMs &&
  t.maxCallMs * 2 <= t.graceMs &&
  t.ttl >= 2 * t.graceMs &&
  t.modelTimeoutMs < t.maxCallMs &&
  t.total >= t.maxCallMs;

describe("tool-policy · ویژگیِ داورِ مستقل (۱۵۰۰ بذر)", () => {
  it("resolveToolPolicy می‌پذیرد ⇔ داور می‌پذیرد؛ پذیرفته‌ها دوباره‌ورودی و نگاشت‌پذیرند", () => {
    const rnd = prng(20261211);
    const pool = (): number => {
      const k = rnd();
      if (k < 0.15) return [0, 1, -1, 29_999, 30_000, 599_999, 600_000, 600_001, 86_400_000][Math.floor(rnd() * 9)]!;
      return Math.floor(rnd() * 1_000_000) + 1;
    };
    let accepted = 0;
    let rejected = 0;
    for (let i = 0; i < 1500; i++) {
      const graceMs = rnd() < 0.7 ? Math.floor(30_000 + rnd() * 400_000) : pool();
      const maxCallMs = rnd() < 0.7 ? Math.max(1, Math.floor(graceMs * (0.1 + rnd() * 0.6))) : pool();
      const reservationTtlMs = rnd() < 0.7 ? Math.floor(graceMs * (1.5 + rnd() * 4)) : pool();
      const modelTimeoutMs = rnd() < 0.7 ? Math.max(1, Math.floor(maxCallMs * (0.3 + rnd() * 0.9))) : pool();
      const totalTimeoutMs = rnd() < 0.7 ? Math.max(1_000, Math.floor(maxCallMs * (0.5 + rnd() * 3))) : pool();
      const raw = { timing: { graceMs, maxCallMs, reservationTtlMs }, model: { timeoutMs: modelTimeoutMs }, run: { totalTimeoutMs } };
      const expected = referee({ graceMs, maxCallMs, ttl: reservationTtlMs, modelTimeoutMs, total: totalTimeoutMs });
      const r = resolveToolPolicy(raw);
      expect(r.ok, JSON.stringify(raw)).toBe(expected);
      const rel = checkPolicyRelations({ maxCallMs, graceMs, reservationTtlMs, modelTimeoutMs, totalTimeoutMs });
      if (expected) {
        accepted++;
        expect(rel).toEqual([]);
        expect(r.ok && resolveToolPolicy(r.value).ok).toBe(true);
        expect(projectToolPolicy(raw).ok).toBe(true);
      } else {
        rejected++;
        expect(!r.ok && r.error.issues.length).toBeGreaterThan(0);
        expect(projectToolPolicy(raw).ok).toBe(false);
      }
    }
    // هر دو شاخه به‌اندازهٔ کافی دیده شده‌اند (داور بی‌اثر نیست).
    expect(accepted).toBeGreaterThan(100);
    expect(rejected).toBeGreaterThan(100);
  });

  it("بازنویسیِ تصادفیِ فیلدهای غیرزمانی با داورِ ساده: معتبر ⇔ درون کران", () => {
    const rnd = prng(7);
    const fields: Array<[string, string, number, number]> = [
      ["loop", "maxSteps", 1, 16],
      ["loop", "maxToolCalls", 1, 64],
      ["loop", "maxIdenticalCalls", 1, 16],
      ["loop", "truncationRetries", 0, 2],
      ["answer", "maxCards", 1, 50],
      ["answer", "maxOutputTokens", 1, 65_536],
      ["metering", "perMessageOverheadTokens", 0, 1000],
    ];
    for (let i = 0; i < 600; i++) {
      const [s, k, lo, hi] = fields[Math.floor(rnd() * fields.length)]!;
      const v = Math.floor(rnd() * (hi * 2 + 6)) - 3;
      const r = resolveToolPolicy({ [s]: { [k]: v } });
      expect(r.ok, `${s}.${k}=${v}`).toBe(v >= lo && v <= hi);
    }
    expect(resolveToolPolicy({}).ok).toBe(true);
    expect(DEFAULT_TOOL_POLICY.loop.maxSteps).toBeGreaterThan(0);
  });
});

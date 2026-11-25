import { describe, expect, it } from "vitest";
import { DEFAULT_TOOL_POLICY, POLICY_LIMITS, resolveToolPolicy, timingFromGrace } from "./index";
import { deepFrozen } from "./test-kit";

describe("tool-policy · مجموعهٔ زمانی از graceMs", () => {
  it("graceMs پیش‌فرض ⇒ دقیقاً زمان‌بندیِ پیش‌فرض (نسبت‌های ۴۰٪ و ۴×)", () => {
    const r = timingFromGrace(DEFAULT_TOOL_POLICY.timing.graceMs);
    expect(r.ok && r.value).toEqual(DEFAULT_TOOL_POLICY.timing);
    expect(r.ok && deepFrozen(r.value)).toBe(true);
  });

  it("مرز: کفِ ۳۰٬۰۰۰ ⇒ ۱۲٬۰۰۰ و ۱۲۰٬۰۰۰؛ ۲۹٬۹۹۹ رد", () => {
    const r = timingFromGrace(POLICY_LIMITS.minGraceMs);
    expect(r.ok && r.value).toEqual({ graceMs: 30_000, maxCallMs: 12_000, reservationTtlMs: 120_000 });
    const low = timingFromGrace(POLICY_LIMITS.minGraceMs - 1);
    expect(low.ok).toBe(false);
    expect(!low.ok && low.error.issues).toEqual([`graceMs باید دست‌کم ${POLICY_LIMITS.minGraceMs} میلی‌ثانیه باشد.`]);
  });

  it("گردکردن به پایین است (مبنای ایمن: سقفِ تماس هرگز بیشتر از ۴۰٪ نمی‌شود)", () => {
    const r = timingFromGrace(30_001);
    expect(r.ok && r.value.maxCallMs).toBe(12_000);
    const r2 = timingFromGrace(30_004);
    expect(r2.ok && r2.value.maxCallMs).toBe(12_001);
  });

  it("سقفِ بالا: maxCallMs ≤ ۶۰۰٬۰۰۰ ⇒ graceMs ≤ ۱٬۵۰۰٬۰۰۰؛ بالاتر رد", () => {
    expect(timingFromGrace(1_500_000).ok).toBe(true);
    const over = timingFromGrace(1_500_003);
    expect(over.ok).toBe(false);
    expect(!over.ok && over.error.issues).toEqual(["timing.maxCallMs باید عدد صحیح 1 تا 600000 باشد."]);
  });

  it("ورودیِ نامعتبر رد می‌شود و مقدار بازتاب نمی‌شود", () => {
    for (const bad of [undefined, null, "90000", 1.5, -1, 0, Number.NaN, Infinity, BigInt(10), {}, [], Number.MAX_SAFE_INTEGER, 86_400_000]) {
      const r = timingFromGrace(bad);
      expect(r.ok, String(bad)).toBe(false);
      expect(!r.ok && r.error.code).toBe("INVALID_POLICY");
    }
    expect(JSON.stringify(timingFromGrace("SECRET-VALUE"))).not.toContain("SECRET-VALUE");
  });

  it("هر graceMs پذیرفته‌شده، با مهلتِ مدلِ کوچک، از resolveToolPolicy می‌گذرد و هر رابطه برقرار است (۲۰۰ نقطه)", () => {
    for (let g = POLICY_LIMITS.minGraceMs; g <= 1_500_000; g += 7_321) {
      const t = timingFromGrace(g);
      expect(t.ok, String(g)).toBe(true);
      if (!t.ok) continue;
      expect(t.value.maxCallMs).toBeLessThan(t.value.graceMs);
      expect(t.value.maxCallMs * 2).toBeLessThanOrEqual(t.value.graceMs);
      expect(t.value.reservationTtlMs).toBe(4 * g);
      const p = resolveToolPolicy({ timing: t.value, model: { timeoutMs: 1_000 }, run: { totalTimeoutMs: Math.max(1_000, t.value.maxCallMs) } });
      expect(p.ok, String(g)).toBe(true);
    }
  });
});

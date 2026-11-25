import { describe, expect, it } from "vitest";
import { LIMITS } from "@/modules/ledger";
import { LOOP_LIMITS } from "@/modules/tool-loop";
import { MAX_CARDS_CEILING } from "@/modules/calc-answer-cards";
import { RUNNER_LIMITS } from "@/modules/tool-runner";
import { checkPolicyRelations, DEFAULT_TOOL_POLICY, POLICY_LIMITS, POLICY_RATIOS, resolveToolPolicy } from "./index";
import { deepFrozen } from "./test-kit";

describe("tool-policy · پیش‌فرض‌های کد", () => {
  it("پیش‌فرض‌ها عمیق‌یخ‌زده‌اند و خودشان از اعتبارسنجی می‌گذرند (خودهمانی)", () => {
    expect(deepFrozen(DEFAULT_TOOL_POLICY)).toBe(true);
    const r = resolveToolPolicy(undefined);
    expect(r.ok && r.value).toEqual(DEFAULT_TOOL_POLICY);
    const again = resolveToolPolicy(DEFAULT_TOOL_POLICY);
    expect(again.ok && again.value).toEqual(DEFAULT_TOOL_POLICY);
  });

  it("نسبت‌های تأییدشدهٔ مالک: maxCallMs = ۴۰٪ graceMs، ttl = ۴×graceMs، onUnknownCost = forfeit، graceMs ≥ ۳۰ ثانیه", () => {
    const { timing, metering } = DEFAULT_TOOL_POLICY;
    expect(POLICY_RATIOS).toEqual({ callSharePercent: 40, ttlFactor: 4 });
    expect(timing.maxCallMs).toBe((timing.graceMs * POLICY_RATIOS.callSharePercent) / 100);
    expect(timing.reservationTtlMs).toBe(timing.graceMs * POLICY_RATIOS.ttlFactor);
    expect(timing.graceMs).toBeGreaterThanOrEqual(30_000);
    expect(metering.onUnknownCost).toBe("forfeit");
  });

  it("پیش‌فرض‌ها همهٔ رابطه‌های ساختاری را برآورده می‌کنند و مهلتِ مدل زودتر از سقفِ سخت است", () => {
    const { timing, model, run } = DEFAULT_TOOL_POLICY;
    expect(checkPolicyRelations({ maxCallMs: timing.maxCallMs, graceMs: timing.graceMs, reservationTtlMs: timing.reservationTtlMs, modelTimeoutMs: model.timeoutMs, totalTimeoutMs: run.totalTimeoutMs })).toEqual([]);
    expect(model.timeoutMs).toBeLessThan(timing.maxCallMs);
    expect(timing.maxCallMs * POLICY_LIMITS.maxCallShareDenominator).toBeLessThanOrEqual(timing.graceMs);
    expect(timing.reservationTtlMs).toBeLessThanOrEqual(LIMITS.MAX_TTL_MS);
  });

  it("کرانِ فیلدها از ماژول‌های پایین‌دست می‌آید، نه نسخهٔ دوم: پیش‌فرض‌ها زیرِ سقفِ آن‌هایند", () => {
    const p = DEFAULT_TOOL_POLICY;
    expect(p.loop.maxSteps).toBeLessThanOrEqual(LOOP_LIMITS.maxSteps);
    expect(p.loop.maxToolCalls).toBeLessThanOrEqual(LOOP_LIMITS.maxToolCalls);
    expect(p.loop.maxIdenticalCalls).toBeLessThanOrEqual(LOOP_LIMITS.maxIdenticalCalls);
    expect(p.loop.truncationRetries).toBeLessThanOrEqual(LOOP_LIMITS.maxTruncationRetries);
    expect(p.answer.maxCards).toBeLessThanOrEqual(MAX_CARDS_CEILING);
    expect(p.run.maxResultChars).toBeLessThanOrEqual(RUNNER_LIMITS.maxResultChars);
    expect(p.run.toolTimeoutMs).toBeGreaterThanOrEqual(RUNNER_LIMITS.minToolTimeoutMs);
  });

  it("هیچ پیش‌فرضِ حقوقی/قیمت/ارز/کلید در سیاست نیست: فقط شش بخشِ شناخته‌شده", () => {
    expect(Object.keys(DEFAULT_TOOL_POLICY)).toEqual(["loop", "run", "answer", "model", "timing", "metering"]);
    const text = JSON.stringify(DEFAULT_TOOL_POLICY);
    for (const word of ["price", "currency", "IRR", "apiKey", "tenant", "account", "endpoint"]) expect(text).not.toContain(word);
  });
});

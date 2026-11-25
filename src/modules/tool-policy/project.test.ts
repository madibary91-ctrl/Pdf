import { describe, expect, it } from "vitest";
import { DEFAULT_TOOL_POLICY, projectToolPolicy } from "./index";
import { deepFrozen } from "./test-kit";

describe("tool-policy · نگاشت به گزینه‌های پایین‌دست", () => {
  it("پیش‌فرض ⇒ شکلِ دقیقِ نگاشت (هر مقدار از همان بخشِ سیاست)", () => {
    const r = projectToolPolicy();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = DEFAULT_TOOL_POLICY;
    expect(r.value).toEqual({
      loop: { maxSteps: p.loop.maxSteps, maxToolCalls: p.loop.maxToolCalls, maxIdenticalCalls: p.loop.maxIdenticalCalls, truncationRetries: p.loop.truncationRetries },
      service: { model: p.model.name, maxOutputTokens: p.answer.maxOutputTokens, maxCards: p.answer.maxCards, totalTimeoutMs: p.run.totalTimeoutMs, toolTimeoutMs: p.run.toolTimeoutMs, maxResultChars: p.run.maxResultChars },
      deadline: { maxCallMs: p.timing.maxCallMs },
      durable: { graceMs: p.timing.graceMs, reservationTtlMs: p.timing.reservationTtlMs, perMessageOverheadTokens: p.metering.perMessageOverheadTokens, onUnknownCost: p.metering.onUnknownCost },
      gatewayModel: { timeoutMs: p.model.timeoutMs },
    });
    expect(deepFrozen(r.value)).toBe(true);
  });

  it("هیچ budget، ارز، قیمت، حساب یا کلیدی ساخته نمی‌شود", () => {
    const r = projectToolPolicy();
    const text = JSON.stringify(r.ok ? r.value : null);
    for (const word of ["budget", "currency", "price", "account", "tenant", "apiKey", "gateway\":", "ledger"]) expect(text).not.toContain(word);
  });

  it("گرافِ مقدار: بازنویسیِ معتبر تا خروجی می‌رسد", () => {
    const r = projectToolPolicy({ loop: { maxSteps: 3 }, metering: { onUnknownCost: "release" }, answer: { maxCards: 2 } });
    expect(r.ok && r.value.loop.maxSteps).toBe(3);
    expect(r.ok && r.value.durable.onUnknownCost).toBe("release");
    expect(r.ok && r.value.service.maxCards).toBe(2);
  });

  it("سیاستِ دست‌کاری‌شده/جعلی هرگز نگاشت نمی‌شود (دوباره اعتبارسنجی)", () => {
    const tampered = { ...DEFAULT_TOOL_POLICY, timing: { ...DEFAULT_TOOL_POLICY.timing, maxCallMs: DEFAULT_TOOL_POLICY.timing.graceMs } };
    const r = projectToolPolicy(tampered);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.issues).toContain("maxCallMs باید کمتر از graceMs باشد.");
    expect(projectToolPolicy(null).ok).toBe(false);
    expect(projectToolPolicy({ nope: 1 }).ok).toBe(false);
  });

  it("خروجی مستقل از ورودی است", () => {
    const raw = { loop: { maxSteps: 3 } };
    const r = projectToolPolicy(raw);
    raw.loop.maxSteps = 9;
    expect(r.ok && r.value.loop.maxSteps).toBe(3);
  });
});

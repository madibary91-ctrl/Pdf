import { describe, expect, it } from "vitest";
import { TOOL_LIMITS } from "@/modules/ai-gateway";
import { DEFAULT_TIMERS, RUNNER_LIMITS, resolveRunnerOptions } from "./config";
import { fakeTimers, makeLoop, okExec, stubGateway, scripted } from "./test-kit";

const { gateway } = stubGateway(scripted([]));
const GOOD = () => ({ gateway, loop: makeLoop(), executeTool: okExec(), totalTimeoutMs: 10_000, toolTimeoutMs: 1_000, maxResultChars: 4_000 });
const issuesOf = (o: unknown): readonly string[] => {
  const r = resolveRunnerOptions(o);
  if (r.ok) throw new Error("انتظارِ شکست");
  expect(r.error.code).toBe("INVALID_CONFIG");
  expect(r.error.partial).toBeNull();
  return r.error.issues;
};

describe("RUNNER_LIMITS", () => {
  it("سقفِ نتیجه از سقفِ قالبِ سیمِ دروازه فراتر نمی‌رود (و برابرِ آن است)", () => {
    expect(RUNNER_LIMITS.maxResultChars).toBe(TOOL_LIMITS.maxResultChars);
  });
  it("حدها عددهای ثابتِ قراردادی‌اند", () => {
    expect({ ...RUNNER_LIMITS, maxResultChars: 0 }).toEqual({ minTotalTimeoutMs: 1000, maxTotalTimeoutMs: 600_000, minToolTimeoutMs: 50, maxToolTimeoutMs: 300_000, minResultChars: 64, maxResultChars: 0 });
  });
});

describe("resolveRunnerOptions", () => {
  it("پیکربندیِ کامل پذیرفته می‌شود و تایمرِ پیش‌فرض جهانی است", () => {
    const r = resolveRunnerOptions(GOOD());
    expect(r.ok && r.value.timers).toBe(DEFAULT_TIMERS);
    expect(r.ok && Object.isFrozen(r.value)).toBe(true);
  });

  it("تایمرِ تزریقی حفظ می‌شود", () => {
    const f = fakeTimers();
    const r = resolveRunnerOptions({ ...GOOD(), timers: f.timers });
    expect(r.ok && r.value.timers).toBe(f.timers);
  });

  it.each(["totalTimeoutMs", "toolTimeoutMs", "maxResultChars"])("%s الزامی است (بی‌پیش‌فرض)", (k) => {
    const o: Record<string, unknown> = GOOD();
    delete o[k];
    expect(issuesOf(o).join()).toContain(k);
  });

  it.each([
    ["totalTimeoutMs", RUNNER_LIMITS.minTotalTimeoutMs, RUNNER_LIMITS.maxTotalTimeoutMs],
    ["toolTimeoutMs", RUNNER_LIMITS.minToolTimeoutMs, RUNNER_LIMITS.maxToolTimeoutMs],
    ["maxResultChars", RUNNER_LIMITS.minResultChars, RUNNER_LIMITS.maxResultChars],
  ])("%s: مرزهای دقیقِ %d و %d", (k, min, max) => {
    const ok = (v: unknown) => resolveRunnerOptions({ ...GOOD(), [k]: v }).ok;
    expect(ok(min)).toBe(true);
    expect(ok(max)).toBe(true);
    expect(ok(min - 1)).toBe(false);
    expect(ok(max + 1)).toBe(false);
    expect(ok(min + 0.5)).toBe(false);
    expect(ok(String(min))).toBe(false);
    expect(ok(Number.NaN)).toBe(false);
    expect(ok(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it.each([null, undefined, 5, "x", [], () => 1])("options غیرشیء (%s) ⇒ INVALID_CONFIG", (o) => {
    expect(issuesOf(o).length).toBeGreaterThan(0);
  });

  it("کلیدِ ناشناخته رد می‌شود (فقط نامِ کلید، کوتاه‌شده)", () => {
    const issues = issuesOf({ ...GOOD(), retries: 3, ["x".repeat(100)]: 1 });
    expect(issues.some((i) => i.includes("retries"))).toBe(true);
    expect(issues.every((i) => i.length < 120)).toBe(true);
  });

  it.each([
    ["gateway", {}],
    ["gateway", { completeStep: () => 1, toolFormat: () => 1 }],
    ["loop", { start: () => 1 }],
    ["loop", null],
    ["executeTool", "fn"],
    ["timers", { setTimeout: () => 1 }],
  ])("%s نامعتبر (%j)", (k, v) => {
    expect(issuesOf({ ...GOOD(), [k as string]: v }).join()).toContain(k as string);
  });

  it("هرگز پرتاب نمی‌کند (getter/Proxy خصمانه) و مقدارِ ورودی را بازتاب نمی‌دهد", () => {
    const hostile = new Proxy({}, { get() { throw new Error("SECRET-VALUE"); }, ownKeys() { throw new Error("SECRET-VALUE"); } });
    const r = resolveRunnerOptions(hostile);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("SECRET-VALUE");
    const r2 = resolveRunnerOptions({ ...GOOD(), totalTimeoutMs: "SECRET-VALUE" });
    expect(JSON.stringify(r2)).not.toContain("SECRET-VALUE");
  });
});

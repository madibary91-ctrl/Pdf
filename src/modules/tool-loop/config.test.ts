import { describe, expect, it } from "vitest";
import { LOOP_LIMITS, resolveToolLoopConfig } from "./index";
import { BASE_CONFIG } from "./test-kit";

const CAP = { kind: "cap", currency: "IRR", maxMicros: 1000, estimateStepMicros: () => 1 };
const bad = (over: Record<string, unknown>) => resolveToolLoopConfig({ ...BASE_CONFIG, ...over });

describe("tool-loop · پیکربندی", () => {
  it("پیکربندیِ معتبر پذیرفته و یخ‌زده و کپی می‌شود", () => {
    const raw: Record<string, unknown> = { ...BASE_CONFIG, budget: { ...CAP } };
    const r = resolveToolLoopConfig(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.isFrozen(r.value)).toBe(true);
    expect(Object.isFrozen(r.value.budget)).toBe(true);
    raw.maxSteps = 99;
    expect(r.value.maxSteps).toBe(5);
    expect(r.value.budget).toMatchObject({ kind: "cap", currency: "IRR", maxMicros: 1000 });
  });

  it("budget: none بدونِ کلیدِ اضافه پذیرفته می‌شود", () => {
    expect(bad({ budget: { kind: "none" } }).ok).toBe(true);
  });

  it.each(["maxSteps", "maxToolCalls", "maxIdenticalCalls", "truncationRetries", "budget"])("نبودنِ %s رد می‌شود (بی‌پیش‌فرض)", (key) => {
    const raw: Record<string, unknown> = { ...BASE_CONFIG };
    delete raw[key];
    const r = resolveToolLoopConfig(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_CONFIG");
  });

  it.each([
    ["maxSteps", 0],
    ["maxSteps", LOOP_LIMITS.maxSteps + 1],
    ["maxSteps", 1.5],
    ["maxSteps", "5"],
    ["maxSteps", Number.NaN],
    ["maxToolCalls", 0],
    ["maxToolCalls", LOOP_LIMITS.maxToolCalls + 1],
    ["maxToolCalls", -1],
    ["maxIdenticalCalls", 0],
    ["maxIdenticalCalls", LOOP_LIMITS.maxIdenticalCalls + 1],
    ["truncationRetries", -1],
    ["truncationRetries", LOOP_LIMITS.maxTruncationRetries + 1],
    ["truncationRetries", null],
  ])("%s=%s رد می‌شود", (key, value) => {
    expect(bad({ [key]: value }).ok).toBe(false);
  });

  it.each([
    ["maxSteps", 1],
    ["maxSteps", LOOP_LIMITS.maxSteps],
    ["maxToolCalls", LOOP_LIMITS.maxToolCalls],
    ["maxIdenticalCalls", 1],
    ["truncationRetries", 0],
    ["truncationRetries", LOOP_LIMITS.maxTruncationRetries],
  ])("مرزِ مجازِ %s=%s پذیرفته می‌شود", (key, value) => {
    expect(bad({ [key]: value }).ok).toBe(true);
  });

  it.each([
    ["کلیدِ ناشناخته", { extra: 1 }],
    ["budget رشته", { budget: "none" }],
    ["budget نوعِ ناشناخته", { budget: { kind: "unlimited" } }],
    ["none با کلیدِ اضافه", { budget: { kind: "none", maxMicros: 1 } }],
    ["cap بی‌ارز", { budget: { ...CAP, currency: undefined } }],
    ["cap ارزِ کوچک", { budget: { ...CAP, currency: "irr" } }],
    ["cap ارزِ چهارحرفی", { budget: { ...CAP, currency: "IRRR" } }],
    ["cap سقفِ صفر", { budget: { ...CAP, maxMicros: 0 } }],
    ["cap سقفِ اعشاری", { budget: { ...CAP, maxMicros: 1.5 } }],
    ["cap سقفِ ناامن", { budget: { ...CAP, maxMicros: Number.MAX_SAFE_INTEGER + 2 } }],
    ["cap برآوردگر غیرتابع", { budget: { ...CAP, estimateStepMicros: 5 } }],
    ["cap کلیدِ اضافه", { budget: { ...CAP, softCap: 1 } }],
  ])("%s رد می‌شود", (_n, over) => {
    const r = bad(over as Record<string, unknown>);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues.length).toBeGreaterThan(0);
  });

  it.each([null, undefined, 5, "x", []])("ورودیِ غیرشیء (%s) رد می‌شود", (v) => {
    expect(resolveToolLoopConfig(v).ok).toBe(false);
  });

  it("گیرندهٔ پرتابگر (Proxy) پرتاب نمی‌کند و رد می‌شود", () => {
    const p = new Proxy({}, { get: () => { throw new Error("boom"); }, ownKeys: () => { throw new Error("boom"); } });
    expect(resolveToolLoopConfig(p).ok).toBe(false);
  });

  it("پیام‌های خطا فقط نامِ فیلد دارند (بی‌بازتابِ مقدار)", () => {
    const r = bad({ maxSteps: "CANARY-نشت", extraCANARY: 1 });
    expect(JSON.stringify(r)).not.toContain("CANARY-نشت");
  });
});

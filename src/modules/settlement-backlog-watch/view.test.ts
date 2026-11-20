/**
 * settlement-backlog-watch · ساختِ نما از «آخرین نمونهٔ سالم» و «آخرین تلاش» (تابعِ خالص، ارزیابِ ساختگی). بی‌پایگاه.
 * ارزیابِ واقعی در watch.test.ts و روی monitorِ واقعی سنجیده می‌شود؛ اینجا فقط قواعدِ ترکیب.
 */
import { describe, expect, it } from "vitest";
import type { BacklogHealth, BacklogReason } from "@/modules/settlement-backlog";
import { buildView, failClosedView, safeView } from "./view";
import type { GoodSample, ViewInput } from "./view";

const SAMPLE: GoodSample = Object.freeze({ ok: true as const, atMs: 5, count: 2, truncated: false, oldestDeadAtMs: 1, undated: 0, byReason: Object.freeze({ EXPIRED_UNBILLED: 0, ATTEMPTS_EXHAUSTED: 2, LEDGER_REJECTED: 0 }) });
const TH = Object.freeze({ degradedCount: 1, downCount: 10, degradedAfterMs: 1, downAfterMs: 2, sampleMaxAgeMs: 3 });
const R = (code: BacklogReason["code"], severity: BacklogReason["severity"]): BacklogReason => ({ code, severity });
const health = (status: BacklogHealth["status"], reasons: BacklogReason[]): BacklogHealth => ({ status, reasons, count: 2, truncated: false, oldestAgeMs: 7, sampleAgeMs: 3, byReason: SAMPLE.byReason, failure: null, thresholds: TH });

function input(over: Partial<ViewInput> & { h?: BacklogHealth } = {}): { i: ViewInput; calls: unknown[] } {
  const calls: unknown[] = [];
  const h = over.h ?? health("ok", []);
  const i: ViewInput = {
    phase: "running",
    readyPolicy: "report",
    lastGood: SAMPLE,
    failure: null,
    nowMs: 99,
    evaluate: (x) => {
      calls.push(x);
      return h;
    },
    ...over,
  };
  return { i, calls };
}

describe("settlement-backlog-watch · buildView", () => {
  it("بی‌نمونه و بی‌تلاشِ ناموفق ⇒ unknown بی‌دلیل؛ ارزیاب صدا زده نمی‌شود", () => {
    const { i, calls } = input({ lastGood: null });
    expect(buildView(i)).toMatchObject({ status: "unknown", reasons: [], failure: null, count: null, byReason: null, oldestAgeMs: null, sampleAgeMs: null, truncated: null });
    expect(calls).toHaveLength(0);
  });

  it.each(["CLOCK_INVALID", "LIST_FAILED", "BAD_LIST", "TIMEOUT"] as const)("بی‌نمونه با تلاشِ ناموفقِ %s ⇒ degraded با SAMPLE_UNREADABLE (نه down)", (failure) => {
    const { i } = input({ lastGood: null, failure });
    const v = buildView(i);
    expect(v).toMatchObject({ status: "degraded", failure, reasons: [{ code: "SAMPLE_UNREADABLE", severity: "degraded" }] });
  });

  it("نمونهٔ سالم: ارزیاب دقیقاً یک بار با {sample, nowMs} صدا زده می‌شود و میدان‌ها عبور می‌کنند", () => {
    const { i, calls } = input({ h: health("degraded", [R("COUNT_HIGH", "degraded")]) });
    const v = buildView(i);
    expect(calls).toEqual([{ sample: SAMPLE, nowMs: 99 }]);
    expect(v).toMatchObject({ phase: "running", status: "degraded", count: 2, truncated: false, oldestAgeMs: 7, sampleAgeMs: 3, byReason: SAMPLE.byReason, failure: null, readyPolicy: "report" });
  });

  it("nowMs نامعتبر (null) بی‌تغییر به ارزیاب می‌رسد (او INPUT_INVALID می‌دهد، ما حدس نمی‌زنیم)", () => {
    const { i, calls } = input({ nowMs: null });
    buildView(i);
    expect(calls).toEqual([{ sample: SAMPLE, nowMs: null }]);
  });

  it("تلاشِ ناموفق روی ok ⇒ degraded؛ روی degraded ⇒ degraded؛ روی down ⇒ down (شدت پایین نمی‌آید)", () => {
    expect(buildView(input({ failure: "TIMEOUT", h: health("ok", []) }).i).status).toBe("degraded");
    expect(buildView(input({ failure: "TIMEOUT", h: health("degraded", [R("COUNT_HIGH", "degraded")]) }).i).status).toBe("degraded");
    expect(buildView(input({ failure: "TIMEOUT", h: health("down", [R("COUNT_CRITICAL", "down")]) }).i).status).toBe("down");
  });

  it("SAMPLE_UNREADABLE اضافه می‌شود و تکراری نمی‌شود؛ خطرناک‌ترین‌ها اول با ترتیبِ پایدار", () => {
    const h = health("down", [R("COUNT_HIGH", "degraded"), R("OLDEST_STUCK", "down"), R("SAMPLE_STALE", "degraded"), R("COUNT_CRITICAL", "down")]);
    const v = buildView(input({ failure: "LIST_FAILED", h }).i);
    expect(v.reasons.map((r) => r.code)).toEqual(["OLDEST_STUCK", "COUNT_CRITICAL", "COUNT_HIGH", "SAMPLE_STALE", "SAMPLE_UNREADABLE"]);
    const dup = buildView(input({ failure: "LIST_FAILED", h: health("degraded", [R("SAMPLE_UNREADABLE", "degraded")]) }).i);
    expect(dup.reasons.filter((r) => r.code === "SAMPLE_UNREADABLE")).toHaveLength(1);
  });

  it("بدونِ تلاشِ ناموفق، SAMPLE_UNREADABLE اضافه نمی‌شود و failure=null", () => {
    const v = buildView(input({ h: health("degraded", [R("COUNT_HIGH", "degraded")]) }).i);
    expect(v.reasons.map((r) => r.code)).toEqual(["COUNT_HIGH"]);
    expect(v.failure).toBeNull();
  });

  it("ورودیِ ارزیاب را تغییر نمی‌دهد و نتیجه منجمد است (آرایهٔ دلیل‌های ارزیاب دست‌نخورده)", () => {
    const reasons = [R("COUNT_HIGH", "degraded")];
    const v = buildView(input({ failure: "BAD_LIST", h: health("degraded", reasons) }).i);
    expect(reasons).toHaveLength(1);
    expect(Object.isFrozen(v)).toBe(true);
    expect(Object.isFrozen(v.reasons)).toBe(true);
  });

  it("فاز و سیاست بی‌تغییر منتقل می‌شوند", () => {
    for (const phase of ["idle", "running", "stalled", "stopped"] as const) for (const readyPolicy of ["report", "gate_down"] as const) expect(buildView(input({ phase, readyPolicy }).i)).toMatchObject({ phase, readyPolicy });
  });
});

describe("settlement-backlog-watch · safeView", () => {
  it("ارزیابِ پرتاب‌کننده ⇒ نمای شکستِ بسته با همان فاز و سیاست؛ بی‌نشتِ پیام", () => {
    const { i } = input({ phase: "stalled", readyPolicy: "gate_down" });
    const v = safeView({
      ...i,
      evaluate: () => {
        throw new Error("SECRET-EVAL");
      },
    });
    expect(v).toEqual(failClosedView("stalled", "gate_down"));
    expect(JSON.stringify(v)).not.toContain("SECRET");
  });

  it("ارزیابِ سالم ⇒ همان buildView", () => {
    const { i } = input({ h: health("degraded", [R("COUNT_HIGH", "degraded")]) });
    expect(safeView(i)).toEqual(buildView(i));
  });
});

describe("settlement-backlog-watch · failClosedView", () => {
  it("down با INPUT_INVALID و بی‌هیچ عددِ ساختگی", () => {
    const v = failClosedView("running", "gate_down");
    expect(v).toEqual({ phase: "running", status: "down", reasons: [{ code: "INPUT_INVALID", severity: "down" }], count: null, truncated: null, oldestAgeMs: null, sampleAgeMs: null, byReason: null, failure: null, readyPolicy: "gate_down" });
    expect(Object.isFrozen(v)).toBe(true);
  });
});

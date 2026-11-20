/**
 * settlement-backlog-watch · سیاستِ پروب (ADR-0042): «پسماند هرگز liveness را ۵۰۳ نکند و فقط در ready و startup گزارش شود».
 * جدولی، بدجنس و خاصیتی (مولدِ شبه‌تصادفیِ بذردار؛ بی‌وابستگیِ تازه)؛ و روی نمای واقعیِ `createBacklogWatch`.
 */
import { describe, expect, it } from "vitest";
import { projectBacklogForProbe } from "./index";
import type { BacklogView } from "./index";
import { FAST, deadEntry, scriptedOutbox, world } from "./test-kit";

const STATUSES = ["ok", "degraded", "down", "unknown"] as const;
const POLICIES = ["report", "gate_down"] as const;
const CODES = ["INPUT_INVALID", "SAMPLE_UNREADABLE", "SAMPLE_STALE", "CLOCK_BEHIND", "COUNT_HIGH", "COUNT_CRITICAL", "OLDEST_AGED", "OLDEST_STUCK", "AGE_UNKNOWN"] as const;

function view(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { phase: "running", status: "ok", reasons: [], count: 0, truncated: false, oldestAgeMs: null, sampleAgeMs: 0, byReason: null, failure: null, readyPolicy: "report", ...over };
}

describe("settlement-backlog-watch · live هرگز گزارش یا مسدود نمی‌شود", () => {
  it.each(STATUSES.flatMap((s) => POLICIES.map((p) => [s, p] as const)))("وضعیتِ %s با سیاستِ %s ⇒ {section:null, blocks:false}", (status, readyPolicy) => {
    expect(projectBacklogForProbe("live", view({ status, readyPolicy }))).toEqual({ section: null, blocks: false });
  });

  it.each([undefined, null, 5, "", "LIVE", "ready ", "Ready", "startup\n", {}, [], "health", "liveness"])("نوعِ ناشناخته %j هم هیچ‌چیز گزارش یا مسدود نمی‌کند", (kind) => {
    expect(projectBacklogForProbe(kind, view({ status: "down", readyPolicy: "gate_down" }))).toEqual({ section: null, blocks: false });
  });

  it("live حتی با نمای خراب هم نمی‌پرتابد و بی‌اثر است", () => {
    for (const bad of [null, undefined, 3, "x", [], new Proxy({}, { get() { throw new Error("boom"); } })]) expect(projectBacklogForProbe("live", bad)).toEqual({ section: null, blocks: false });
  });
});

describe("settlement-backlog-watch · startup: گزارش بله، مسدودسازی هرگز", () => {
  it.each(STATUSES.flatMap((s) => POLICIES.map((p) => [s, p] as const)))("وضعیتِ %s با سیاستِ %s ⇒ section هست و blocks=false", (status, readyPolicy) => {
    const r = projectBacklogForProbe("startup", view({ status, readyPolicy, count: 3, oldestAgeMs: 10, truncated: false, reasons: [{ code: "COUNT_HIGH", severity: "degraded" }] }));
    expect(r.blocks).toBe(false);
    expect(r.section).toEqual({ status, count: 3, truncated: false, oldestAgeMs: 10, reasons: ["COUNT_HIGH"], policy: readyPolicy });
  });
});

describe("settlement-backlog-watch · ready: فقط gate_down و فقط down مسدود می‌کند", () => {
  it.each(STATUSES.flatMap((s) => POLICIES.map((p) => [s, p] as const)))("وضعیتِ %s با سیاستِ %s", (status, policy) => {
    const r = projectBacklogForProbe("ready", view({ status, readyPolicy: policy }));
    expect(r.blocks).toBe(status === "down" && policy === "gate_down");
    expect(r.section?.status).toBe(status);
    expect(r.section?.policy).toBe(policy);
  });

  it("پیش‌فرضِ report: حتی down و ده‌ها دلیل ۵۰۳ نمی‌سازد", () => {
    const r = projectBacklogForProbe("ready", view({ status: "down", count: 500, reasons: [{ code: "COUNT_CRITICAL", severity: "down" }, { code: "OLDEST_STUCK", severity: "down" }] }));
    expect(r.blocks).toBe(false);
    expect(r.section?.reasons).toEqual(["COUNT_CRITICAL", "OLDEST_STUCK"]);
  });
});

describe("settlement-backlog-watch · نمای ناقابل‌اعتماد ⇒ unknown و بی‌مسدودسازی", () => {
  const malformed: Array<[string, unknown]> = [
    ["null", null],
    ["آرایه", []],
    ["رشته", "x"],
    ["عدد", 5],
    ["بی‌status", view({ status: undefined })],
    ["statusِ ناشناخته", view({ status: "critical" })],
    ["statusِ غیررشته", view({ status: 1 })],
    ["policyِ ناشناخته", view({ readyPolicy: "enforce" })],
    ["policyِ غایب", view({ readyPolicy: undefined })],
    ["countِ منفی", view({ count: -1 })],
    ["countِ اعشاری", view({ count: 1.5 })],
    ["countِ رشته", view({ count: "3" })],
    ["truncatedِ رشته", view({ truncated: "yes" })],
    ["oldestAgeMsِ NaN", view({ oldestAgeMs: Number.NaN })],
    ["oldestAgeMsِ منفی", view({ oldestAgeMs: -5 })],
    ["reasonsِ غیرآرایه", view({ reasons: "COUNT_HIGH" })],
    ["reasonsِ بیش از ۱۶", view({ reasons: Array.from({ length: 17 }, () => ({ code: "COUNT_HIGH" })) })],
    ["کدِ ناشناخته", view({ reasons: [{ code: "SECRET_CODE", severity: "down" }] })],
    ["دلیلِ null", view({ reasons: [null] })],
    ["دلیلِ رشته", view({ reasons: ["COUNT_HIGH"] })],
    ["Proxyِ پرتاب‌کننده", new Proxy({}, { get() { throw new Error("SECRET-PROXY"); } })],
  ];

  it.each(malformed)("%s ⇒ بخشِ unknown، blocks=false (روی ready و startup)", (_n, v) => {
    for (const kind of ["ready", "startup"] as const) {
      const r = projectBacklogForProbe(kind, v);
      expect(r.blocks).toBe(false);
      expect(r.section).toEqual({ status: "unknown", count: null, truncated: null, oldestAgeMs: null, reasons: [], policy: "report" });
    }
  });

  it("نمای خراب با status=down و gate_down هم مسدود نمی‌کند (شکلِ خراب = «نمی‌دانم»، نه down)", () => {
    expect(projectBacklogForProbe("ready", view({ status: "down", readyPolicy: "gate_down", count: -1 })).blocks).toBe(false);
  });
});

describe("settlement-backlog-watch · سقفِ دلیل‌ها", () => {
  it("دقیقاً ۱۶ دلیل پذیرفته می‌شود و ۱۷ دلیل ناقابل‌اعتماد است", () => {
    const mk = (n: number): unknown[] => Array.from({ length: n }, () => ({ code: "COUNT_HIGH", severity: "degraded" }));
    expect(projectBacklogForProbe("ready", view({ status: "degraded", reasons: mk(16) })).section?.reasons).toHaveLength(16);
    expect(projectBacklogForProbe("ready", view({ status: "degraded", reasons: mk(17) })).section?.status).toBe("unknown");
  });
});

describe("settlement-backlog-watch · بی‌نشت", () => {
  it("فقط شش کلیدِ مجاز بیرون می‌آید؛ فیلدهای اضافه (شناسه، byReason، رمز) نه", () => {
    const r = projectBacklogForProbe("ready", view({ status: "degraded", tenantId: "TENANT-SECRET", byReason: { ATTEMPTS_EXHAUSTED: 3 }, secret: "SECRET", reasons: [{ code: "COUNT_HIGH", severity: "degraded", detail: "SECRET-DETAIL" }] }));
    expect(Object.keys(r.section ?? {}).sort()).toEqual(["count", "oldestAgeMs", "policy", "reasons", "status", "truncated"]);
    expect(JSON.stringify(r)).not.toContain("SECRET");
    expect(r.section?.reasons).toEqual(["COUNT_HIGH"]);
  });

  it("نتیجه و بخش و کدها منجمدند", () => {
    const r = projectBacklogForProbe("ready", view());
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.section)).toBe(true);
    expect(Object.isFrozen(r.section?.reasons)).toBe(true);
    expect(Object.isFrozen(projectBacklogForProbe("live", view()))).toBe(true);
  });

  it("ورودی را تغییر نمی‌دهد", () => {
    const v = view({ status: "down", readyPolicy: "gate_down" });
    const copy = JSON.stringify(v);
    projectBacklogForProbe("ready", v);
    expect(JSON.stringify(v)).toBe(copy);
  });
});

describe("settlement-backlog-watch · خاصیتی: ناوردای «live/startup هرگز مسدود نمی‌شوند»", () => {
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }
  const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;

  it("۳۰۰۰ نمای شبه‌تصادفی (معتبر و خراب) × هر نوع: blocks فقط برای ready ∧ gate_down ∧ down ∧ نمای معتبر", () => {
    const r = rng(20261120);
    for (let n = 0; n < 3000; n++) {
      const valid = r() < 0.6;
      const v = view({
        status: valid ? pick(r, STATUSES) : pick(r, [...STATUSES, "weird", 7, undefined]),
        readyPolicy: pick(r, POLICIES),
        count: pick(r, [null, 0, 1, 10, 999]),
        truncated: pick(r, [null, true, false]),
        oldestAgeMs: pick(r, [null, 0, 5, 86_400_001]),
        reasons: Array.from({ length: Math.floor(r() * 4) }, () => ({ code: pick(r, CODES), severity: pick(r, ["degraded", "down"]) })),
      });
      const wellFormed = (STATUSES as readonly unknown[]).includes(v["status"]);
      for (const kind of ["live", "startup", "ready", "x"]) {
        const out = projectBacklogForProbe(kind, v);
        const expected = kind === "ready" && wellFormed && v["status"] === "down" && v["readyPolicy"] === "gate_down";
        expect(out.blocks, `${kind} ${JSON.stringify(v)}`).toBe(expected);
        if (kind !== "ready" && kind !== "startup") expect(out.section).toBeNull();
        else expect(out.section).not.toBeNull();
      }
    }
  });
});

describe("settlement-backlog-watch · روی نمای واقعیِ createBacklogWatch", () => {
  async function downWorld(readyPolicy: "report" | "gate_down"): Promise<BacklogView> {
    const { outbox, state } = scriptedOutbox();
    state.list = Array.from({ length: 10 }, (_, i) => deadEntry(i + 1));
    const w = world({ readyPolicy }, outbox);
    w.watch.start();
    await w.advance(FAST.intervalMs);
    return w.watch.view();
  }

  it("پسماندِ down + gate_down: ready مسدود، startup و live آزاد", async () => {
    const v = await downWorld("gate_down");
    expect(v.status).toBe("down");
    expect(projectBacklogForProbe("ready", v)).toMatchObject({ blocks: true, section: { status: "down", count: 10, policy: "gate_down" } });
    expect(projectBacklogForProbe("startup", v).blocks).toBe(false);
    expect(projectBacklogForProbe("live", v)).toEqual({ section: null, blocks: false });
  });

  it("پسماندِ down + report (پیش‌فرض): هیچ‌کدام مسدود نیست ولی ready و startup گزارش می‌دهند", async () => {
    const v = await downWorld("report");
    for (const kind of ["live", "startup", "ready"]) expect(projectBacklogForProbe(kind, v).blocks).toBe(false);
    expect(projectBacklogForProbe("ready", v).section?.reasons).toContain("COUNT_CRITICAL");
    expect(projectBacklogForProbe("live", v).section).toBeNull();
  });

  it("پسماندِ degraded با gate_down هنوز ready را مسدود نمی‌کند (فقط down)", async () => {
    const { outbox, state } = scriptedOutbox();
    state.list = [deadEntry(1)];
    const w = world({ readyPolicy: "gate_down" }, outbox);
    w.watch.start();
    await w.settle();
    expect(w.watch.view().status).toBe("degraded");
    expect(projectBacklogForProbe("ready", w.watch.view()).blocks).toBe(false);
  });

  it("پیش از اولین نمونه (unknown) و با خرابیِ outbox (degraded) هیچ‌وقت مسدود نمی‌کند", async () => {
    const { outbox, state } = scriptedOutbox();
    state.mode = "reject";
    const w = world({ readyPolicy: "gate_down" }, outbox);
    expect(projectBacklogForProbe("ready", w.watch.view()).blocks).toBe(false);
    w.watch.start();
    await w.settle();
    expect(w.watch.view().status).toBe("degraded");
    expect(projectBacklogForProbe("ready", w.watch.view()).blocks).toBe(false);
  });
});

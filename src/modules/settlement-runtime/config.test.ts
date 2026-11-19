/**
 * settlement-runtime · اعتبارسنجیِ پیکربندی روی مرز: شکستِ بسته، بی‌پرتاب، بی‌نشتِ مقدار، پیش‌فرض‌های مستند.
 */
import { describe, expect, it } from "vitest";
import { SETTLEMENT_LIMITS } from "@/modules/settlement";
import { SETTLEMENT_RUNTIME_LIMITS, createSettlementRuntime } from "./index";
import { CANARY, FAKE_DSN, GRACE, flush, orphan, tracedOutbox, world } from "./test-kit";
import type { World } from "./test-kit";

const NOOP = () => undefined;

function cfg(w: World, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ledger: w.ledger, outbox: w.outbox, clock: w.timer.clock, timer: w.timer, graceMs: GRACE, deadLetters: false, ...over };
}
const issuesOf = (r: ReturnType<typeof createSettlementRuntime>): readonly string[] => (r.ok ? [] : r.error.issues);

describe("settlement-runtime · پیکربندیِ معتبر", () => {
  it("حداقلِ پیکربندی پذیرفته می‌شود و نتیجه منجمد است", async () => {
    const w = await world();
    const r = createSettlementRuntime(cfg(w));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.isFrozen(r.value)).toBe(true);
      expect(Object.isFrozen(r.value.ports)).toBe(true);
      expect(r.value.ports.ledger).toBe(w.ledger);
      expect(r.value.ports.outbox).toBe(w.outbox);
    }
  });
  it("ساختن هیچ تایمری نمی‌سازد و به ساعت/پایگاه دست نمی‌زند (بی‌اثر جانبی)", async () => {
    const w = await world();
    createSettlementRuntime(cfg(w));
    expect(w.timer.pending()).toBe(0);
    expect(w.timer.delays).toEqual([]);
  });
  it("deadLetters با deliver و گزینه‌های معتبر پذیرفته می‌شود", async () => {
    const w = await world();
    expect(createSettlementRuntime(cfg(w, { deadLetters: { deliver: NOOP, batchLimit: 10, maxBatchesPerRun: 2, deliverTimeoutMs: 1000 } })).ok).toBe(true);
  });
  it("graceMs=2 کمینهٔ کارا (فاصله max(1,⌊2/4⌋)=1) و سقفِ graceMs پذیرفته است", async () => {
    const w = await world();
    expect(createSettlementRuntime(cfg(w, { graceMs: 2 })).ok).toBe(true);
    expect(createSettlementRuntime(cfg(w, { graceMs: SETTLEMENT_LIMITS.maxGraceMs })).ok).toBe(true);
  });
  it("preflight و startTimeoutMs و health و observer اختیاری‌اند و پذیرفته می‌شوند", async () => {
    const w = await world();
    const r = createSettlementRuntime(cfg(w, { preflight: async () => ({ ok: true }), startTimeoutMs: 1, health: { degradedAfterMs: 100, downAfterMs: 200 }, observer: {} }));
    expect(r.ok).toBe(true);
  });
});

describe("settlement-runtime · ورودیِ نامعتبر", () => {
  it.each([null, undefined, 5, "x", true, [], () => 1])("پیکربندیِ غیرشیء (%s) رد می‌شود", (raw) => {
    const r = createSettlementRuntime(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_CONFIG");
  });
  it.each(["ledger", "outbox", "clock", "timer", "graceMs", "deadLetters"])("نبودنِ «%s» رد می‌شود و نامِ فیلد در issue می‌آید", async (key) => {
    const w = await world();
    const c = cfg(w);
    delete c[key];
    const r = createSettlementRuntime(c);
    expect(r.ok).toBe(false);
    expect(issuesOf(r).join("|")).toContain(key);
  });
  it("کلیدِ ناشناخته رد می‌شود و نامِ بلند بریده می‌شود", async () => {
    const w = await world();
    const r = createSettlementRuntime(cfg(w, { ["x".repeat(500)]: 1, unknownKey: 1 }));
    expect(r.ok).toBe(false);
    expect(issuesOf(r).join("|")).toContain("unknownKey");
    for (const i of issuesOf(r)) expect(i.length, i.slice(0, 60)).toBeLessThan(100);
  });
  it.each([0, -1, 1.5, "10", Number.NaN, Number.POSITIVE_INFINITY, null, SETTLEMENT_LIMITS.maxGraceMs + 1])("graceMs=%s رد می‌شود", async (g) => {
    const w = await world();
    expect(createSettlementRuntime(cfg(w, { graceMs: g })).ok).toBe(false);
  });
  it("graceMs=1 رد می‌شود (فاصلهٔ ممکن ≤ ⌊1/2⌋=0 نیست) — پیامِ settlement بی‌تغییر می‌رسد", async () => {
    const w = await world();
    const r = createSettlementRuntime(cfg(w, { graceMs: 1 }));
    expect(r.ok).toBe(false);
    expect(issuesOf(r).join("|")).toContain("intervalMs");
  });
  it.each([undefined, true, null, "x", 5, {}, { deliver: "x" }, { deliver: NOOP, extra: 1 }, [], { deliver: NOOP, batchLimit: 0 }, { deliver: NOOP, deliverTimeoutMs: -1 }])("deadLetters نامعتبر/غایب (%j) رد می‌شود (شکستِ بسته)", async (dl) => {
    const w = await world();
    const c = cfg(w);
    if (dl === undefined) delete c["deadLetters"];
    else c["deadLetters"] = dl;
    const r = createSettlementRuntime(c);
    expect(r.ok).toBe(false);
    expect(issuesOf(r).join("|")).toContain("deadLetters");
  });
  it.each([0, 300_001, 1.5, "5", null])("startTimeoutMs=%s رد می‌شود", async (v) => {
    const w = await world();
    expect(issuesOf(createSettlementRuntime(cfg(w, { startTimeoutMs: v }))).join("|")).toContain("startTimeoutMs");
  });
  it("preflight غیرتابع رد می‌شود", async () => {
    const w = await world();
    expect(issuesOf(createSettlementRuntime(cfg(w, { preflight: "x" }))).join("|")).toContain("preflight");
  });
  it("timer بدون cancel و clock بدون nowMs رد می‌شوند", async () => {
    const w = await world();
    expect(issuesOf(createSettlementRuntime(cfg(w, { timer: { after: NOOP } }))).join("|")).toContain("timer");
    expect(issuesOf(createSettlementRuntime(cfg(w, { clock: {} }))).join("|")).toContain("clock");
  });
  it("outboxِ بی‌claimDue رد می‌شود (اجارهٔ رفتگر همیشه روشن است)", async () => {
    const w = await world();
    const { claimDue: _drop, ...rest } = w.outbox as unknown as Record<string, unknown>;
    void _drop;
    const r = createSettlementRuntime(cfg(w, { outbox: rest }));
    expect(r.ok).toBe(false);
    expect(issuesOf(r).join("|")).toContain("claimDue");
  });
  it.each([
    ["limit", 0],
    ["limit", 1001],
    ["maxAttempts", 101],
    ["retryDelayMs", -1],
    ["leaseMs", 0],
    ["leaseMs", null],
    ["intervalMs", null],
    ["leaseMs", 86_400_001],
    ["intervalMs", GRACE],
    ["maxBackoffMs", GRACE],
    ["maxDrainRuns", 0],
    ["stopTimeoutMs", 0],
  ])("تنظیمِ %s=%s را settlement رد می‌کند و issue به بیرون می‌رسد", async (k, v) => {
    const w = await world();
    const r = createSettlementRuntime(cfg(w, { [k as string]: v }));
    expect(r.ok).toBe(false);
    expect(issuesOf(r).join("|")).toContain(k as string);
  });
  it("health: کلیدِ ناشناخته، غیرشیء و آستانهٔ ناسازگار رد می‌شود", async () => {
    const w = await world();
    expect(issuesOf(createSettlementRuntime(cfg(w, { health: { bogus: 1 } }))).join("|")).toContain("bogus");
    expect(createSettlementRuntime(cfg(w, { health: 5 })).ok).toBe(false);
    expect(createSettlementRuntime(cfg(w, { health: { degradedAfterMs: 500, downAfterMs: 100 } })).ok).toBe(false);
  });
  it("همهٔ مشکل‌ها یک‌جا گزارش می‌شوند (نه فقط اولی)", async () => {
    const w = await world();
    const r = createSettlementRuntime(cfg(w, { graceMs: 1_000, limit: 0, startTimeoutMs: 0, deadLetters: 7, preflight: 3 }));
    const j = issuesOf(r).join("|");
    for (const k of ["limit", "startTimeoutMs", "deadLetters", "preflight"]) expect(j).toContain(k);
  });
});

describe("settlement-runtime · بی‌نشت و بی‌پرتاب", () => {
  it("مقدارِ حساس در هر فیلدِ اشتباه هرگز در خطا نمی‌آید", async () => {
    const w = await world();
    const bad = FAKE_DSN;
    for (const k of ["graceMs", "intervalMs", "leaseMs", "limit", "startTimeoutMs", "deadLetters", "health", "observer", "preflight", "timer", "clock", "ledger", "outbox", "maxAttempts", "retryDelayMs"]) {
      const r = createSettlementRuntime(cfg(w, { [k]: bad }));
      expect(JSON.stringify(r), k).not.toContain(CANARY);
    }
    expect(JSON.stringify(createSettlementRuntime(cfg(w, { [bad]: 1 })))).not.toContain(CANARY.slice(0, 5) + "zzz");
  });
  it("getterِ پرتابگر و Proxyِ لغوشده ⇒ INVALID_CONFIG بی‌پرتاب و بی‌نشت", async () => {
    const w = await world();
    const evil = cfg(w);
    Object.defineProperty(evil, "graceMs", {
      enumerable: true,
      get() {
        throw new Error(CANARY);
      },
    });
    const r1 = createSettlementRuntime(evil);
    expect(r1.ok).toBe(false);
    expect(JSON.stringify(r1)).not.toContain(CANARY);
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const r2 = createSettlementRuntime(proxy);
    expect(r2.ok).toBe(false);
  });
  it("getterِ deadLetters.deliver پرتابگر ⇒ INVALID_CONFIG بی‌پرتاب", async () => {
    const w = await world();
    const dl = {};
    Object.defineProperty(dl, "deliver", {
      enumerable: true,
      get() {
        throw new Error(CANARY);
      },
    });
    const r = createSettlementRuntime(cfg(w, { deadLetters: dl }));
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(CANARY);
  });
  it("هر کلید فقط یک بار خوانده می‌شود (getterِ دوچهره نمی‌تواند اعتبارسنجی را دور بزند)", async () => {
    const w = await world();
    const c = cfg(w);
    let reads = 0;
    Object.defineProperty(c, "graceMs", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? GRACE : 5; // دومین خواندن مقدارِ ناسازگار می‌داد
      },
    });
    const r = createSettlementRuntime(c);
    expect(reads).toBe(1);
    expect(r.ok).toBe(true);
  });
  it("تغییرِ شیءِ پیکربندی پس از ساخت اثری ندارد (عکسِ گرفته‌شده)", async () => {
    const w = await world();
    const c = cfg(w);
    const r = createSettlementRuntime(c);
    expect(r.ok).toBe(true);
    c["graceMs"] = 1;
    c["timer"] = null;
    if (r.ok) {
      expect((await r.value.start()).started).toBe(true);
      await r.value.stop();
    }
  });
});

describe("settlement-runtime · پیش‌فرض‌های مستند (ADR-0031)", () => {
  it("فاصلهٔ گذرها پیش‌فرض max(1,⌊graceMs/4⌋) است", async () => {
    const w = await world();
    const r = createSettlementRuntime(cfg(w));
    if (!r.ok) throw new Error("ساخت");
    await r.value.start();
    await w.timer.advance(GRACE / 4);
    expect(w.timer.delays).toContain(GRACE / 4);
    await r.value.stop();
  });
  it("graceMs=2 فاصلهٔ ۱ms می‌دهد", async () => {
    const w = await world();
    const r = createSettlementRuntime(cfg(w, { graceMs: 2 }));
    if (!r.ok) throw new Error("ساخت");
    await r.value.start();
    await w.timer.advance(3);
    expect(w.timer.delays).toContain(1);
    await r.value.stop();
  });
  it("intervalMs صریح بر پیش‌فرض می‌چربد", async () => {
    const w = await world();
    const r = createSettlementRuntime(cfg(w, { intervalMs: 1234 }));
    if (!r.ok) throw new Error("ساخت");
    await r.value.start();
    await w.timer.advance(2500);
    expect(w.timer.delays).toContain(1234);
    expect(w.timer.delays).not.toContain(GRACE / 4);
    await r.value.stop();
  });
  it("اجارهٔ رفتگر همیشه روشن است: پیش‌فرض leaseMs=graceMs و صریح بر آن می‌چربد", async () => {
    for (const [over, expected] of [[{}, GRACE], [{ leaseMs: 7777 }, 7777]] as const) {
      const w = await world();
      const spy = tracedOutbox(w.outbox);
      const r = createSettlementRuntime(cfg(w, { outbox: spy, ...over }));
      if (!r.ok) throw new Error("ساخت");
      await r.value.start();
      await w.timer.advance(GRACE / 4 + 1);
      expect(spy.claims.length).toBeGreaterThan(0);
      for (const q of spy.claims) expect(q.leaseMs).toBe(expected);
      await r.value.stop();
    }
  });
  it("leaseMs پیش‌فرض از سقفِ اجاره بیشتر نمی‌شود", async () => {
    const w = await world();
    const spy = tracedOutbox(w.outbox);
    const big = SETTLEMENT_LIMITS.maxGraceMs;
    const r = createSettlementRuntime(cfg(w, { outbox: spy, graceMs: big }));
    if (!r.ok) throw new Error("ساخت");
    await r.value.start();
    await w.timer.advance(big / 4 + 1);
    expect(spy.claims.length).toBeGreaterThan(0);
    for (const q of spy.claims) expect(q.leaseMs).toBe(Math.min(big, SETTLEMENT_LIMITS.maxLeaseMs));
    await r.value.stop();
  });
  it("آستانه‌های سلامت از graceMs می‌آیند و health صریح بر آنها می‌چربد", async () => {
    const w = await world();
    const a = createSettlementRuntime(cfg(w));
    const b = createSettlementRuntime(cfg(w, { health: { degradedAfterMs: 111, downAfterMs: 222 } }));
    if (!a.ok || !b.ok) throw new Error("ساخت");
    expect(a.value.health().health).toMatchObject({ degradedAfterMs: GRACE / 2, downAfterMs: GRACE });
    expect(b.value.health().health).toMatchObject({ degradedAfterMs: 111, downAfterMs: 222 });
  });
  it("سقف‌های عمومی مستند و منجمدند", () => {
    expect(SETTLEMENT_RUNTIME_LIMITS).toEqual({ defaultStartTimeoutMs: 15_000, maxStartTimeoutMs: 300_000 });
    expect(Object.isFrozen(SETTLEMENT_RUNTIME_LIMITS)).toBe(true);
  });
  it("بدونِ start هیچ کاری روی outbox/دفتر نمی‌شود", async () => {
    const w = await world();
    const spy = tracedOutbox(w.outbox);
    const r = createSettlementRuntime(cfg(w, { outbox: spy }));
    if (!r.ok) throw new Error("ساخت");
    await orphan(w, "r1");
    await w.timer.advance(GRACE * 3);
    await flush();
    expect(spy.count["claimDue"] ?? 0).toBe(0);
  });
});

/**
 * settlement-host · اعتبارسنجیِ پیکربندی: مرزها، پیش‌فرض‌ها (از راهِ رفتار)، ورودیِ بدجنس، بی‌نشتِ مقدار.
 */
import { describe, expect, it } from "vitest";
import { SETTLEMENT_HOST_LIMITS, createSettlementHost } from "./index";
import { CANARY, flush, rig, unavailable } from "./test-kit";

const issuesOf = (over: Record<string, unknown>, remove: string[] = []): string[] => {
  const r = rig(over);
  for (const k of remove) delete r.config[k];
  const h = createSettlementHost(r.config);
  if (h.ok) return [];
  expect(h.error.code).toBe("INVALID_CONFIG");
  return [...h.error.issues];
};

describe("settlement-host · پیکربندی", () => {
  it("پیکربندیِ حداقلی (runtime، timer، signals) معتبر است", () => {
    const r = rig();
    const h = createSettlementHost({ runtime: r.runtime, timer: r.timer, signals: r.signals });
    expect(h.ok).toBe(true);
  });
  it("signals:false معتبر است؛ نبودنِ signals رد می‌شود (انتخابِ آگاهانه)", () => {
    expect(createSettlementHost({ ...rig().config, signals: false }).ok).toBe(true);
    const iss = issuesOf({}, ["signals"]);
    expect(iss.join("|")).toMatch(/signals الزامی/);
  });
  it.each([undefined, null, true, 0, "x", [], () => 1])("ریشهٔ نامعتبر %s ⇒ INVALID_CONFIG بی‌پرتاب", (raw) => {
    const h = createSettlementHost(raw);
    expect(h.ok).toBe(false);
    if (!h.ok) expect(h.error.code).toBe("INVALID_CONFIG");
  });
  it("کلیدِ ناشناخته رد می‌شود و نامش (بریده) گزارش می‌شود", () => {
    const iss = issuesOf({ extra: 1, [`k${"x".repeat(100)}`]: 1 });
    expect(iss.some((m) => m.includes('"extra"'))).toBe(true);
    expect(Math.max(...iss.map((m) => m.length))).toBeLessThan(70); // نامِ کلید به ۴۰ نویسه بریده می‌شود
  });
  it.each(["runtime", "timer"])("%s الزامی است", (k) => {
    expect(issuesOf({}, [k]).join("|")).toContain(k);
  });
  it.each([
    ["runtime", { start() {}, stop() {} }],
    ["runtime", { start() {}, health() {} }],
    ["runtime", { stop() {}, health() {} }],
    ["runtime", 5],
    ["timer", { after() {} }],
    ["timer", { cancel() {} }],
    ["signals", { on() {} }],
    ["signals", { off() {} }],
    ["signals", true],
    ["signals", null],
    ["signals", "process"],
  ])("%s با شکلِ نامعتبر رد می‌شود", (k, v) => {
    expect(issuesOf({ [k]: v }).join("|")).toContain(k);
  });
  it.each(["exit", "closeResources", "observer"])("%s اگر باشد باید تابع باشد (null پذیرفته نمی‌شود)", (k) => {
    for (const bad of [null, 1, "f", {}, true]) expect(issuesOf({ [k]: bad }).join("|"), String(bad)).toContain(k);
    expect(issuesOf({ [k]: undefined })).toEqual([]);
  });
  describe("shutdownTimeoutMs", () => {
    const max = SETTLEMENT_HOST_LIMITS.maxShutdownTimeoutMs;
    it.each([1, 2, 15_000, max - 1, max])("مقدارِ معتبر %i پذیرفته می‌شود", (v) => {
      expect(issuesOf({ shutdownTimeoutMs: v })).toEqual([]);
    });
    it.each([0, -1, max + 1, 1.5, Number.NaN, Infinity, "100", null, true, {}])("مقدارِ نامعتبر %s رد می‌شود (null پیش‌فرض نمی‌شود)", (v) => {
      expect(issuesOf({ shutdownTimeoutMs: v }).join("|")).toContain("shutdownTimeoutMs");
    });
    it("پیش‌فرض ۱۵٬۰۰۰ و سقفِ مستند", async () => {
      expect(SETTLEMENT_HOST_LIMITS.defaultShutdownTimeoutMs).toBe(15_000);
      expect(max).toBe(300_000);
      const r = rig();
      const h = createSettlementHost(r.config);
      if (!h.ok) throw new Error("x");
      await h.value.shutdown();
      expect(r.timer.delays).toEqual([15_000]);
    });
    it("مقدارِ صریح می‌چربد", async () => {
      const r = rig({ shutdownTimeoutMs: 321 });
      const h = createSettlementHost(r.config);
      if (!h.ok) throw new Error("x");
      await h.value.shutdown();
      expect(r.timer.delays).toEqual([321]);
    });
  });
  describe("bootRetry", () => {
    it.each([1, 2, 9, 10])("maxAttempts=%i معتبر", (v) => expect(issuesOf({ bootRetry: { maxAttempts: v } })).toEqual([]));
    it.each([0, -1, 11, 1.5, Number.NaN, "3", null, true])("maxAttempts=%s رد می‌شود", (v) => expect(issuesOf({ bootRetry: { maxAttempts: v } }).join("|")).toContain("bootRetry.maxAttempts"));
    it.each([1, 2, 59_999, 60_000])("delayMs=%i معتبر", (v) => expect(issuesOf({ bootRetry: { delayMs: v } })).toEqual([]));
    it.each([0, -1, 60_001, 0.5, Number.NaN, Infinity, "5", null, false])("delayMs=%s رد می‌شود", (v) => expect(issuesOf({ bootRetry: { delayMs: v } }).join("|")).toContain("bootRetry.delayMs"));
    it.each([null, 3, "x", [], true])("خودِ bootRetry=%s باید شیء ساده باشد", (v) => expect(issuesOf({ bootRetry: v }).join("|")).toContain("bootRetry"));
    it("کلیدِ ناشناخته در bootRetry رد می‌شود", () => {
      expect(issuesOf({ bootRetry: { maxAttempts: 2, retries: 3 } }).join("|")).toContain("(bootRetry)");
    });
    it("پیش‌فرض‌ها: ۱ تلاش (بی‌بازتلاش) و فاصلهٔ ۱۰۰۰ وقتی تلاش‌ها بیش از ۱ باشد", async () => {
      expect(SETTLEMENT_HOST_LIMITS).toMatchObject({ defaultBootAttempts: 1, defaultBootDelayMs: 1_000, maxBootAttempts: 10, maxBootDelayMs: 60_000 });
      const a = rig();
      a.runtime.startQueue.push(unavailable);
      const ha = createSettlementHost(a.config);
      if (!ha.ok) throw new Error("x");
      expect((await ha.value.boot()).booted).toBe(false);
      expect(a.runtime.calls.start).toBe(1);
      expect(a.timer.delays).toEqual([]);
      const b = rig({ bootRetry: { maxAttempts: 2 } });
      b.runtime.startQueue.push(unavailable);
      const hb = createSettlementHost(b.config);
      if (!hb.ok) throw new Error("x");
      const p = hb.value.boot();
      await flush();
      expect(b.timer.delays).toEqual([1_000]);
      await b.timer.advance(1_000);
      expect((await p).booted).toBe(true);
    });
  });
  it("هر کلید فقط یک بار خوانده می‌شود (getter دو بار پاسخ متفاوت نمی‌دهد)", () => {
    const base = rig().config;
    const reads: Record<string, number> = {};
    const raw: Record<string, unknown> = {};
    for (const k of Object.keys(base)) {
      Object.defineProperty(raw, k, {
        enumerable: true,
        get() {
          reads[k] = (reads[k] ?? 0) + 1;
          return base[k];
        },
      });
    }
    expect(createSettlementHost(raw).ok).toBe(true);
    for (const k of Object.keys(base)) expect(reads[k], k).toBe(1);
  });
  it("getter که می‌پرتابد یا Proxy بدجنس ⇒ INVALID_CONFIG بی‌پرتاب و بی‌نشت", () => {
    const evil = { get runtime(): never { throw new Error(`boom ${CANARY}`); } };
    const a = createSettlementHost(evil);
    expect(a.ok).toBe(false);
    expect(JSON.stringify(a)).not.toContain(CANARY);
    const px = new Proxy({}, { ownKeys() { throw new Error(`boom ${CANARY}`); } });
    const b = createSettlementHost(px);
    expect(b.ok).toBe(false);
    expect(JSON.stringify(b)).not.toContain(CANARY);
  });
  it("مقدارِ نامعتبر (مثلاً رشتهٔ اتصال در فیلدِ اشتباه) هرگز در پیام نمی‌آید", () => {
    const dsn = ["post", "gres://u:", CANARY, "@h/db"].join("");
    for (const k of ["shutdownTimeoutMs", "runtime", "timer", "signals", "exit", "closeResources", "observer", "bootRetry"]) {
      const iss = issuesOf({ [k]: dsn, [`${CANARY}-key`]: dsn });
      expect(JSON.stringify(iss), k).not.toContain(dsn);
      expect(JSON.stringify(iss).includes(CANARY) && !JSON.stringify(iss).includes(`${CANARY}-key`)).toBe(false);
    }
  });
  it("خروجیِ INVALID_CONFIG منجمد و issues یکتاست", () => {
    const h = createSettlementHost({});
    expect(h.ok).toBe(false);
    if (!h.ok) {
      expect(Object.isFrozen(h.error)).toBe(true);
      expect(Object.isFrozen(h.error.issues)).toBe(true);
      expect(new Set(h.error.issues).size).toBe(h.error.issues.length);
    }
  });
  it("میزبانِ ساخته‌شده منجمد است و بی‌اثرِ جانبی: تا boot/shutdown هیچ پورتی صدا زده نمی‌شود", () => {
    const r = rig();
    const h = createSettlementHost(r.config);
    if (!h.ok) throw new Error("x");
    expect(Object.isFrozen(h.value)).toBe(true);
    expect(Object.isFrozen(h.value.probes)).toBe(true);
    expect(r.log).toEqual([]);
    expect(r.signals.count()).toBe(0);
    expect(r.timer.pending()).toBe(0);
    expect(h.value.status()).toEqual({ state: "idle", bootAttempts: 0, hasBooted: false, lastBootFailure: null, shutdownReason: null });
  });
});

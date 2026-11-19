/**
 * settlement-host · چرخهٔ عمر: بوت، بازتلاش، خاموشی، مهلت، سیگنال و پورتِ خصمانه — با زمانِ مجازی و پورت‌های ساختگی.
 */
import { describe, expect, it } from "vitest";
import { createSettlementHost } from "./index";
import type { HostEvent, SettlementHost } from "./index";
import { CANARY, deferred, flush, rig, unavailable } from "./test-kit";
import type { Rig } from "./test-kit";

function build(r: Rig): SettlementHost {
  const h = createSettlementHost(r.config);
  if (!h.ok) throw new Error(h.error.issues.join("; "));
  return h.value;
}
const types = (r: Rig): string[] => r.events.map((e: HostEvent) => e.type);

describe("settlement-host · بوت", () => {
  it("موفق: سیگنال‌ها پیش از runtime.start نصب می‌شوند و نتیجه و وضعیت درست است", async () => {
    const r = rig();
    const h = build(r);
    const res = await h.boot();
    expect(res).toEqual({ booted: true, atMs: 1_000, attempts: 1 });
    expect(r.log).toEqual(["signals.on:SIGTERM", "signals.on:SIGINT", "start"]);
    expect(h.status()).toEqual({ state: "running", bootAttempts: 1, hasBooted: true, lastBootFailure: null, shutdownReason: null });
    expect(Object.isFrozen(res)).toBe(true);
    expect(Object.isFrozen(h.status())).toBe(true);
  });
  it("idempotent: پس از موفقیت همان نتیجه و start فقط یک بار", async () => {
    const r = rig();
    const h = build(r);
    const a = await h.boot();
    const b = await h.boot();
    expect(b).toBe(a);
    expect(r.runtime.calls.start).toBe(1);
    expect(r.signals.count()).toBe(2);
  });
  it("هم‌زمان: یک وعده و یک start", async () => {
    const r = rig();
    const gate = deferred<unknown>();
    r.runtime.startQueue.push(() => gate.promise);
    const h = build(r);
    const p1 = h.boot();
    const p2 = h.boot();
    const p3 = h.boot();
    expect(p2).toBe(p1);
    expect(p3).toBe(p1);
    expect(h.status().state).toBe("booting");
    gate.resolve({ started: true, atMs: 5 });
    expect((await p1).booted).toBe(true);
    expect(r.runtime.calls.start).toBe(1);
  });
  it.each([
    ["NOT_MIGRATED", "PREFLIGHT_FAILED"],
    ["SCHEMA_MISMATCH", "PREFLIGHT_FAILED"],
  ])("شکستِ دائمیِ %s هرگز بازتلاش نمی‌شود (مداخلهٔ انسان لازم است)", async (code, reason) => {
    const r = rig({ bootRetry: { maxAttempts: 5 } });
    r.runtime.startQueue.push({ started: false, reason, code });
    const h = build(r);
    const res = await h.boot();
    expect(res).toEqual({ booted: false, reason, code, attempts: 1 });
    expect(r.runtime.calls.start).toBe(1);
    expect(r.timer.delays).toEqual([]);
    expect(h.status()).toMatchObject({ state: "failed", hasBooted: false, lastBootFailure: { reason, code } });
  });
  it.each(["CLOCK_INVALID", "PREVIOUS_RUN_ACTIVE", "SCHEDULE_FAILED", "STOPPED_DURING_START", "ALREADY_RUNNING", "STARTING", "STOPPING"])("شکستِ %s بازتلاش نمی‌شود و عیناً گزارش می‌شود", async (reason) => {
    const r = rig({ bootRetry: { maxAttempts: 5 } });
    r.runtime.startQueue.push({ started: false, reason, code: null });
    const h = build(r);
    expect(await h.boot()).toEqual({ booted: false, reason, code: null, attempts: 1 });
    expect(r.runtime.calls.start).toBe(1);
  });
  it("کدِ UNAVAILABLE همراهِ دلیلی غیر از PREFLIGHT_FAILED (خروجیِ ناسازگارِ runtime) بازتلاش نمی‌شود", async () => {
    const r = rig({ bootRetry: { maxAttempts: 5 } });
    r.runtime.startQueue.push({ started: false, reason: "SCHEDULE_FAILED", code: "UNAVAILABLE" });
    const h = build(r);
    expect(await h.boot()).toMatchObject({ booted: false, reason: "SCHEDULE_FAILED", attempts: 1 });
    expect(r.runtime.calls.start).toBe(1);
    expect(r.timer.delays).toEqual([]);
  });
  it("PREFLIGHT_FAILED بی‌کدِ UNAVAILABLE (کدِ ناشناخته/نبود) بازتلاش نمی‌شود", async () => {
    const r = rig({ bootRetry: { maxAttempts: 5 } });
    r.runtime.startQueue.push({ started: false, reason: "PREFLIGHT_FAILED", code: "WEIRD" });
    const h = build(r);
    expect(await h.boot()).toEqual({ booted: false, reason: "PREFLIGHT_FAILED", code: null, attempts: 1 });
    expect(r.runtime.calls.start).toBe(1);
  });
  it("UNAVAILABLE بازتلاش می‌شود: دو شکستِ گذرا سپس موفقیت (فاصلهٔ پیش‌فرض ۱۰۰۰)", async () => {
    const r = rig({ bootRetry: { maxAttempts: 3 } });
    r.runtime.startQueue.push(unavailable, unavailable);
    const h = build(r);
    const p = h.boot();
    await flush();
    expect(r.runtime.calls.start).toBe(1);
    expect(h.status().state).toBe("booting");
    await r.timer.advance(999);
    expect(r.runtime.calls.start).toBe(1);
    await r.timer.advance(1);
    expect(r.runtime.calls.start).toBe(2);
    await r.timer.advance(1_000);
    expect(await p).toEqual({ booted: true, atMs: 1_000, attempts: 3 });
    expect(r.timer.delays).toEqual([1_000, 1_000]);
    expect(r.timer.cancelled()).toBe(0); // انتظارِ سپری‌شده لغو نمی‌شود
    expect(h.status()).toMatchObject({ state: "running", bootAttempts: 3, lastBootFailure: null });
  });
  it("فاصلهٔ صریح (۲۵۰) رعایت می‌شود", async () => {
    const r = rig({ bootRetry: { maxAttempts: 2, delayMs: 250 } });
    r.runtime.startQueue.push(unavailable);
    const h = build(r);
    const p = h.boot();
    await flush();
    await r.timer.advance(249);
    expect(r.runtime.calls.start).toBe(1);
    await r.timer.advance(1);
    expect((await p).booted).toBe(true);
    expect(r.timer.delays).toEqual([250]);
  });
  it("پایانِ تلاش‌ها: دقیقاً maxAttempts بار start و پس از آخرین شکست انتظاری نیست", async () => {
    const r = rig({ bootRetry: { maxAttempts: 3, delayMs: 10 } });
    r.runtime.startQueue.push(unavailable, unavailable, unavailable, unavailable);
    const h = build(r);
    const p = h.boot();
    await flush();
    await r.timer.advance(10);
    await r.timer.advance(10);
    expect(await p).toEqual({ booted: false, reason: "PREFLIGHT_FAILED", code: "UNAVAILABLE", attempts: 3 });
    expect(r.runtime.calls.start).toBe(3);
    expect(r.timer.delays).toEqual([10, 10]);
    expect(r.timer.pending()).toBe(0);
    expect(h.status().state).toBe("failed");
  });
  it("زمان‌سنجِ خراب هنگامِ انتظارِ بازتلاش ⇒ بازتلاش متوقف و شکستِ آخر گزارش می‌شود", async () => {
    const r = rig({ bootRetry: { maxAttempts: 5 } });
    r.runtime.startQueue.push(unavailable);
    r.timer.failAfter(1);
    const h = build(r);
    const res = await h.boot();
    expect(res).toEqual({ booted: false, reason: "PREFLIGHT_FAILED", code: "UNAVAILABLE", attempts: 1 });
    expect(r.runtime.calls.start).toBe(1);
    expect(JSON.stringify([res, h.status(), r.events])).not.toContain(CANARY);
  });
  it("پس از failed می‌شود دوباره بوت کرد: شمارنده بازنشانی، شنونده‌ها دوباره نصب نمی‌شوند", async () => {
    const r = rig();
    r.runtime.startQueue.push({ started: false, reason: "PREFLIGHT_FAILED", code: "NOT_MIGRATED" });
    const h = build(r);
    expect((await h.boot()).booted).toBe(false);
    expect(h.status().lastBootFailure).toEqual({ reason: "PREFLIGHT_FAILED", code: "NOT_MIGRATED" });
    const res = await h.boot();
    expect(res).toEqual({ booted: true, atMs: 1_000, attempts: 1 });
    expect(h.status()).toMatchObject({ state: "running", bootAttempts: 1, hasBooted: true, lastBootFailure: null });
    expect(r.signals.count("SIGTERM")).toBe(1);
    expect(r.signals.count("SIGINT")).toBe(1);
  });
  it("hasBooted چسبنده است: پس از یک موفقیت و خاموشی همچنان true", async () => {
    const r = rig();
    const h = build(r);
    await h.boot();
    await h.shutdown();
    expect(h.status()).toMatchObject({ state: "stopped", hasBooted: true });
  });
  it.each([undefined, null, 42, "x", [], {}, { started: "yes" }, { started: 0, reason: "CLOCK_INVALID", code: null }, { started: "true", atMs: 5 }, { started: true }, { started: true, atMs: -1 }, { started: true, atMs: 1.5 }, { started: true, atMs: "1" }, { started: false }, { started: false, reason: "WAT" }, { started: false, reason: 7 }])("خروجیِ نامعتبرِ start (%j) ⇒ RUNTIME_INVALID", async (value) => {
    const r = rig({ bootRetry: { maxAttempts: 3 } });
    r.runtime.startQueue.push(value);
    const h = build(r);
    expect(await h.boot()).toEqual({ booted: false, reason: "RUNTIME_INVALID", code: null, attempts: 1 });
    expect(r.runtime.calls.start).toBe(1);
    expect(h.status().state).toBe("failed");
  });
  it("start که ردّ شود یا همگام بپرتابد ⇒ RUNTIME_INVALID بی‌نشت", async () => {
    for (const mk of [() => Promise.reject(new Error(`boom ${CANARY}`)), () => { throw new Error(`boom ${CANARY}`); }]) {
      const r = rig();
      r.runtime.startQueue.push(mk);
      const h = build(r);
      const res = await h.boot();
      expect(res).toMatchObject({ booted: false, reason: "RUNTIME_INVALID" });
      expect(JSON.stringify([res, h.status(), r.events])).not.toContain(CANARY);
    }
  });
  it("کدِ ناشناخته در شکستِ دیگر null می‌شود (بی‌نشتِ مقدارِ ناشناخته)", async () => {
    const r = rig();
    r.runtime.startQueue.push({ started: false, reason: "CLOCK_INVALID", code: CANARY });
    const h = build(r);
    expect(await h.boot()).toEqual({ booted: false, reason: "CLOCK_INVALID", code: null, attempts: 1 });
  });
  describe("سیگنال‌ها", () => {
    it("نصبِ ناموفق (دومین on می‌پرتابد) ⇒ SIGNALS_UNAVAILABLE؛ start هرگز صدا زده نمی‌شود؛ شنونده‌ی نیمه‌نصب برگردانده می‌شود", async () => {
      const r = rig();
      r.signals.failOnNth(2);
      const h = build(r);
      const res = await h.boot();
      expect(res).toEqual({ booted: false, reason: "SIGNALS_UNAVAILABLE", code: null, attempts: 0 });
      expect(r.runtime.calls.start).toBe(0);
      expect(r.signals.count()).toBe(0);
      expect(r.signals.offCalls()).toBe(1);
      expect(h.status()).toMatchObject({ state: "failed", lastBootFailure: { reason: "SIGNALS_UNAVAILABLE", code: null } });
      expect(JSON.stringify(res)).not.toContain(CANARY);
    });
    it("پس از نصبِ ناموفق، بوتِ دوباره (وقتی on درست شد) موفق است", async () => {
      const r = rig();
      r.signals.failOnNth(1);
      const h = build(r);
      expect((await h.boot()).booted).toBe(false);
      expect((await h.boot()).booted).toBe(true);
      expect(r.signals.count()).toBe(2);
    });
    it("signals:false ⇒ هیچ شنونده‌ای و بوت موفق", async () => {
      const r = rig({ signals: false });
      const h = build(r);
      expect((await h.boot()).booted).toBe(true);
      expect(r.log).toEqual(["start"]);
      await h.shutdown();
      expect(r.log).toEqual(["start", "stop", "close"]);
    });
    it("برداشتنِ شنونده که بپرتابد خاموشی را نمی‌شکند", async () => {
      const r = rig();
      const h = build(r);
      await h.boot();
      r.signals.breakOff();
      const res = await h.shutdown();
      expect(res.ok).toBe(true);
      expect(h.status().state).toBe("stopped");
    });
  });
  it("رویدادهای مشاهده‌گر: موفق، بازتلاش و شکست — فقط کد و شمارنده", async () => {
    const r = rig({ bootRetry: { maxAttempts: 2, delayMs: 5 } });
    r.runtime.startQueue.push(unavailable);
    const h = build(r);
    const p = h.boot();
    await flush();
    await r.timer.advance(5);
    await p;
    expect(r.events).toEqual([
      { type: "boot.attempt_failed", attempt: 1, reason: "PREFLIGHT_FAILED", code: "UNAVAILABLE", willRetry: true },
      { type: "booted", attempts: 2, atMs: 1_000 },
    ]);
    const r2 = rig({ bootRetry: { maxAttempts: 2, delayMs: 5 } });
    r2.runtime.startQueue.push({ started: false, reason: "PREFLIGHT_FAILED", code: "SCHEMA_MISMATCH" });
    await build(r2).boot();
    expect(r2.events).toEqual([
      { type: "boot.attempt_failed", attempt: 1, reason: "PREFLIGHT_FAILED", code: "SCHEMA_MISMATCH", willRetry: false },
      { type: "boot.failed", attempts: 1, reason: "PREFLIGHT_FAILED", code: "SCHEMA_MISMATCH" },
    ]);
    const r3 = rig({ bootRetry: { maxAttempts: 2, delayMs: 5 } });
    r3.runtime.startQueue.push(unavailable, unavailable);
    const h3 = build(r3);
    const p3 = h3.boot();
    await flush();
    await r3.timer.advance(5);
    await p3;
    expect(r3.events.map((e: HostEvent) => (e.type === "boot.attempt_failed" ? `${e.type}:${e.willRetry}` : e.type))).toEqual(["boot.attempt_failed:true", "boot.attempt_failed:false", "boot.failed"]);
  });
  it("مشاهده‌گر که بپرتابد یا ردّ شود رفتارِ میزبان را عوض نمی‌کند", async () => {
    for (const obs of [() => { throw new Error(CANARY); }, () => Promise.reject(new Error(CANARY))]) {
      const r = rig({ observer: obs });
      const h = build(r);
      expect((await h.boot()).booted).toBe(true);
      expect((await h.shutdown()).ok).toBe(true);
      await flush();
    }
  });
});

describe("settlement-host · خاموشی", () => {
  it("از running: ترتیبِ دقیقِ stop ← close؛ نتیجه، حالت و شنونده‌ها", async () => {
    const r = rig();
    const h = build(r);
    await h.boot();
    r.log.length = 0;
    const res = await h.shutdown();
    expect(res).toEqual({ ok: true, clean: true, timedOut: false, closed: "ok", reason: "MANUAL" });
    expect(Object.isFrozen(res)).toBe(true);
    expect(r.log).toEqual(["stop", "close", "signals.off:SIGTERM", "signals.off:SIGINT"]);
    expect(r.signals.count()).toBe(0);
    expect(h.status()).toMatchObject({ state: "stopped", shutdownReason: "MANUAL" });
    expect(h.probes.ready().httpStatus).toBe(503);
  });
  it("هم‌زمان/تکراری: یک وعدهٔ مشترک؛ stop و close فقط یک بار", async () => {
    const r = rig();
    const h = build(r);
    await h.boot();
    const a = h.shutdown();
    const b = h.shutdown();
    expect(b).toBe(a);
    await a;
    expect(await h.shutdown()).toBe(await a);
    expect(r.runtime.calls.stop).toBe(1);
    expect(r.closes.n).toBe(1);
  });
  it("هنگامِ خاموشی: حالتِ stopping، ready بی‌درنگ ۵۰۳، startup همچنان ۲۰۰، live ۲۰۰", async () => {
    const r = rig();
    const gate = deferred<unknown>();
    r.runtime.impl.stop = () => gate.promise;
    const h = build(r);
    await h.boot();
    expect(h.probes.ready().httpStatus).toBe(200);
    const p = h.shutdown();
    expect(h.status().state).toBe("stopping");
    expect(h.probes.ready()).toMatchObject({ httpStatus: 503, body: { state: "stopping", sweep: null } });
    expect(h.probes.startup().httpStatus).toBe(200);
    expect(h.probes.live().httpStatus).toBe(200);
    expect(r.closes.n).toBe(0);
    gate.resolve({ clean: true });
    await p;
    expect(r.closes.n).toBe(1);
    expect(h.probes.ready()).toMatchObject({ httpStatus: 503, body: { state: "stopped" } });
  });
  it("توقفِ ناتمیز ⇒ closeResources صدا زده نمی‌شود (گذرِ آویزان هنوز از استخر استفاده می‌کند)", async () => {
    const r = rig();
    r.runtime.impl.stop = () => ({ clean: false });
    const h = build(r);
    await h.boot();
    const res = await h.shutdown();
    expect(res).toEqual({ ok: false, clean: false, timedOut: false, closed: "skipped", reason: "MANUAL" });
    expect(r.closes.n).toBe(0);
  });
  it.each([
    ["null", () => null],
    ["undefined", () => undefined],
    ["clean رشته", () => ({ clean: "yes" })],
    ["clean عدد ۱", () => ({ clean: 1 })],
    ["بدونِ clean", () => ({})],
    ["رشته", () => "ok"],
    ["ردّ", () => Promise.reject(new Error(CANARY))],
    ["پرتابِ همگام", () => { throw new Error(CANARY); }],
  ])("stop با خروجیِ نامعتبر (%s) ⇒ ناتمیز و closeResources صدا زده نمی‌شود", async (_n, impl) => {
    const r = rig();
    r.runtime.impl.stop = impl;
    const h = build(r);
    await h.boot();
    const res = await h.shutdown();
    expect(res).toMatchObject({ ok: false, clean: false, closed: "skipped" });
    expect(r.closes.n).toBe(0);
    expect(JSON.stringify([res, r.events])).not.toContain(CANARY);
  });
  it.each([
    ["پرتابِ همگام", () => { throw new Error(CANARY); }],
    ["ردّ", () => Promise.reject(new Error(CANARY))],
  ])("closeResources با %s ⇒ closed:failed، clean:true، ok:false و بی‌نشت", async (_n, close) => {
    const r = rig({ closeResources: close });
    const h = build(r);
    await h.boot();
    const res = await h.shutdown();
    expect(res).toEqual({ ok: false, clean: true, timedOut: false, closed: "failed", reason: "MANUAL" });
    expect(JSON.stringify([res, r.events])).not.toContain(CANARY);
  });
  it("closeResources ناهمگام پیش از پایانِ خاموشی تمام می‌شود و پس از stop شروع می‌شود", async () => {
    const r = rig();
    const gate = deferred();
    let closed = false;
    r.config["closeResources"] = async () => {
      r.log.push("close:start");
      await gate.promise;
      closed = true;
      r.log.push("close:end");
    };
    const h = build(r);
    await h.boot();
    r.log.length = 0;
    const p = h.shutdown();
    await flush();
    expect(r.log).toEqual(["stop", "close:start"]);
    expect(h.status().state).toBe("stopping");
    gate.resolve();
    const res = await p;
    expect(closed).toBe(true);
    expect(res.closed).toBe("ok");
  });
  it("closeResources نباشد ⇒ closed:none و ok:true", async () => {
    const r = rig();
    delete r.config["closeResources"];
    const h = build(r);
    await h.boot();
    expect(await h.shutdown()).toEqual({ ok: true, clean: true, timedOut: false, closed: "none", reason: "MANUAL" });
  });
  it("هرگز بوت‌نشده (idle): stop و close همچنان اجرا می‌شوند و شنونده‌ای نیست", async () => {
    const r = rig();
    const h = build(r);
    const res = await h.shutdown();
    expect(res.ok).toBe(true);
    expect(r.log).toEqual(["stop", "close"]);
    expect(h.status()).toMatchObject({ state: "stopped", hasBooted: false });
  });
  it("از حالتِ failed هم مرتب خاموش می‌شود و شنونده‌ها برداشته می‌شوند", async () => {
    const r = rig();
    r.runtime.startQueue.push({ started: false, reason: "PREFLIGHT_FAILED", code: "NOT_MIGRATED" });
    const h = build(r);
    await h.boot();
    expect(r.signals.count()).toBe(2);
    const res = await h.shutdown();
    expect(res.ok).toBe(true);
    expect(r.signals.count()).toBe(0);
    expect(h.status().lastBootFailure).not.toBeNull();
  });
  it("پس از خاموشی boot ⇒ SHUTTING_DOWN و start دوباره صدا زده نمی‌شود", async () => {
    const r = rig();
    const h = build(r);
    await h.boot();
    await h.shutdown();
    expect(await h.boot()).toEqual({ booted: false, reason: "SHUTTING_DOWN", code: null, attempts: 1 });
    expect(r.runtime.calls.start).toBe(1);
    expect(h.status().state).toBe("stopped");
  });
  it("هنگامِ خاموشی boot ⇒ SHUTTING_DOWN", async () => {
    const r = rig();
    const gate = deferred<unknown>();
    r.runtime.impl.stop = () => gate.promise;
    const h = build(r);
    await h.boot();
    const p = h.shutdown();
    expect(await h.boot()).toMatchObject({ booted: false, reason: "SHUTTING_DOWN" });
    gate.resolve({ clean: true });
    await p;
  });
  describe("مهلتِ کلی", () => {
    it("stop آویزان ⇒ پس از shutdownTimeoutMs با timedOut و ناتمیز تمام می‌شود (و close صدا زده نمی‌شود)", async () => {
      const r = rig({ shutdownTimeoutMs: 500 });
      r.runtime.impl.stop = () => new Promise(() => undefined);
      const h = build(r);
      await h.boot();
      let done = false;
      const p = h.shutdown().then((x) => {
        done = true;
        return x;
      });
      await r.timer.advance(499);
      expect(done).toBe(false);
      expect(h.status().state).toBe("stopping");
      await r.timer.advance(1);
      expect(await p).toEqual({ ok: false, clean: false, timedOut: true, closed: "skipped", reason: "MANUAL" });
      expect(h.status().state).toBe("stopped");
      expect(r.closes.n).toBe(0);
    });
    it("closeResources آویزان ⇒ timedOut و closed:failed در حالی که clean:true", async () => {
      const r = rig({ shutdownTimeoutMs: 100, closeResources: () => new Promise(() => undefined) });
      const h = build(r);
      await h.boot();
      const p = h.shutdown();
      await flush();
      await r.timer.advance(100);
      expect(await p).toEqual({ ok: false, clean: true, timedOut: true, closed: "failed", reason: "MANUAL" });
    });
    it("بی‌closeResources: توقفِ ناتمیز (clean:false) هرگز ok نیست (closed:none نباید پنهانش کند) و exit(1)", async () => {
      const r = rig();
      delete r.config["closeResources"];
      r.runtime.impl.stop = () => ({ clean: false });
      const h = build(r);
      await h.boot();
      r.signals.emit("SIGTERM");
      await flush();
      expect(await h.shutdown()).toEqual({ ok: false, clean: false, timedOut: false, closed: "none", reason: "SIGTERM" });
      expect(r.exits).toEqual([1]);
    });
    it("بی‌closeResources: بوتِ آویزان که مهلت را می‌خورد ⇒ stop تمیز بود ولی ok:false (timedOut)", async () => {
      const r = rig({ shutdownTimeoutMs: 200 });
      delete r.config["closeResources"];
      r.runtime.startQueue.push(() => new Promise(() => undefined));
      const h = build(r);
      void h.boot();
      await flush();
      const p = h.shutdown();
      await flush();
      await r.timer.advance(200);
      expect(await p).toEqual({ ok: false, clean: true, timedOut: true, closed: "none", reason: "MANUAL" });
    });
    it("اتمامِ به‌موقع زمان‌سنجِ مهلت را لغو می‌کند (تایمرِ معلق نمی‌ماند)", async () => {
      const r = rig();
      const h = build(r);
      await h.boot();
      await h.shutdown();
      expect(r.timer.pending()).toBe(0);
      expect(r.timer.cancelled()).toBe(1);
    });
    it("زمان‌سنجِ خراب مانعِ توقف نمی‌شود: stop و close اجرا می‌شوند، فقط مهلت نیست", async () => {
      const r = rig();
      const h = build(r);
      await h.boot();
      r.timer.failAfter(1);
      const res = await h.shutdown();
      expect(res).toEqual({ ok: true, clean: true, timedOut: false, closed: "ok", reason: "MANUAL" });
      expect(r.timer.cancelled()).toBe(0);
    });
    it("اگر مهلت زودتر بزند و بعد stop تمام شود، نتیجه یک بار و نخستین (timedOut) است", async () => {
      const r = rig({ shutdownTimeoutMs: 50 });
      const gate = deferred<unknown>();
      r.runtime.impl.stop = () => gate.promise;
      const h = build(r);
      await h.boot();
      const p = h.shutdown();
      await r.timer.advance(50);
      const res = await p;
      gate.resolve({ clean: true });
      await flush();
      expect(res.timedOut).toBe(true);
      expect(await h.shutdown()).toBe(res);
      expect(r.exits).toEqual([]);
    });
  });
  describe("مسابقهٔ بوت و خاموشی", () => {
    it("خاموشی در میانهٔ start: stop بی‌درنگ صدا زده می‌شود ولی close تا پایانِ start نمی‌آید؛ boot ⇒ SHUTTING_DOWN", async () => {
      const r = rig();
      const gate = deferred<unknown>();
      r.runtime.startQueue.push(() => gate.promise);
      const h = build(r);
      const boot = h.boot();
      await flush();
      const p = h.shutdown();
      await flush();
      expect(r.runtime.calls.stop).toBe(1);
      expect(r.closes.n).toBe(0);
      expect(h.status().state).toBe("stopping");
      gate.resolve({ started: false, reason: "STOPPED_DURING_START", code: null });
      expect(await boot).toMatchObject({ booted: false, reason: "SHUTTING_DOWN" });
      expect(await p).toMatchObject({ ok: true, closed: "ok" });
      expect(r.log.indexOf("stop")).toBeLessThan(r.log.indexOf("close"));
      expect(h.status()).toMatchObject({ state: "stopped", hasBooted: false });
    });
    it("start که درست هنگامِ خاموشی موفق برمی‌گردد هم SHUTTING_DOWN است (حالت running نمی‌شود)", async () => {
      const r = rig();
      const gate = deferred<unknown>();
      r.runtime.startQueue.push(() => gate.promise);
      const h = build(r);
      const boot = h.boot();
      await flush();
      const p = h.shutdown();
      gate.resolve({ started: true, atMs: 9 });
      expect(await boot).toMatchObject({ booted: false, reason: "SHUTTING_DOWN" });
      await p;
      expect(h.status()).toMatchObject({ state: "stopped", hasBooted: false });
      expect(r.events.some((e: HostEvent) => e.type === "booted")).toBe(false);
    });
    it("start آویزان + خاموشی ⇒ مهلتِ کلی نجاتش می‌دهد (timedOut)", async () => {
      const r = rig({ shutdownTimeoutMs: 200 });
      r.runtime.startQueue.push(() => new Promise(() => undefined));
      const h = build(r);
      void h.boot();
      await flush();
      const p = h.shutdown();
      await flush();
      await r.timer.advance(200);
      expect(await p).toMatchObject({ timedOut: true, closed: "failed", clean: true });
    });
    it("خاموشی هنگامِ انتظارِ بازتلاش: انتظار لغو می‌شود، start دوباره صدا زده نمی‌شود و boot ⇒ SHUTTING_DOWN", async () => {
      const r = rig({ bootRetry: { maxAttempts: 5, delayMs: 1_000 } });
      r.runtime.startQueue.push(unavailable);
      const h = build(r);
      const boot = h.boot();
      await flush();
      expect(r.timer.pending()).toBe(1);
      const p = h.shutdown();
      expect(r.timer.pending()).toBe(1); // فقط تایمرِ مهلتِ خاموشی؛ انتظارِ بازتلاش بی‌درنگ لغو شد
      expect(await boot).toMatchObject({ booted: false, reason: "SHUTTING_DOWN", attempts: 1 });
      expect((await p).ok).toBe(true);
      expect(r.timer.pending()).toBe(0);
      await r.timer.advance(10_000);
      expect(r.runtime.calls.start).toBe(1);
      expect(r.timer.pending()).toBe(0);
    });
  });
  it("رویدادهای خاموشی به ترتیب: started سپس finished با نتیجه", async () => {
    const r = rig();
    const h = build(r);
    await h.boot();
    r.events.length = 0;
    await h.shutdown();
    expect(r.events).toEqual([
      { type: "shutdown.started", reason: "MANUAL" },
      { type: "shutdown.finished", reason: "MANUAL", ok: true, clean: true, timedOut: false, closed: "ok" },
    ]);
  });
});

describe("settlement-host · سیگنال", () => {
  it("SIGTERM: خاموشی با دلیلِ SIGTERM و سپس exit(0) — پس از close", async () => {
    const r = rig();
    const h = build(r);
    await h.boot();
    r.log.length = 0;
    expect(r.signals.emit("SIGTERM")).toBe(1);
    await flush();
    expect(r.exits).toEqual([0]);
    expect(r.log.filter((x) => x === "stop" || x === "close" || x.startsWith("exit"))).toEqual(["stop", "close", "exit:0"]);
    expect(h.status()).toMatchObject({ state: "stopped", shutdownReason: "SIGTERM" });
    expect(r.events.find((e: HostEvent) => e.type === "shutdown.started")).toEqual({ type: "shutdown.started", reason: "SIGTERM" });
  });
  it("SIGINT همین‌طور", async () => {
    const r = rig();
    const h = build(r);
    await h.boot();
    r.signals.emit("SIGINT");
    await flush();
    expect(r.exits).toEqual([0]);
    expect(h.status().shutdownReason).toBe("SIGINT");
  });
  it("خاموشیِ ناموفق (توقفِ ناتمیز) ⇒ exit(1)", async () => {
    const r = rig();
    r.runtime.impl.stop = () => ({ clean: false });
    const h = build(r);
    await h.boot();
    r.signals.emit("SIGTERM");
    await flush();
    expect(r.exits).toEqual([1]);
  });
  it("خاموشیِ ناموفق (closeResources شکست) ⇒ exit(1)", async () => {
    const r = rig({ closeResources: () => { throw new Error("x"); } });
    const h = build(r);
    await h.boot();
    r.signals.emit("SIGTERM");
    await flush();
    expect(r.exits).toEqual([1]);
  });
  it("مهلت ⇒ exit(1) پس از سقف", async () => {
    const r = rig({ shutdownTimeoutMs: 40 });
    r.runtime.impl.stop = () => new Promise(() => undefined);
    const h = build(r);
    await h.boot();
    r.signals.emit("SIGTERM");
    await flush();
    expect(r.exits).toEqual([]);
    await r.timer.advance(40);
    expect(r.exits).toEqual([1]);
    expect(h.status().state).toBe("stopped");
  });
  it("سیگنالِ تکراری (SIGTERM سپس SIGINT و دوباره) خاموشی را نمی‌کُشد و exit را دوباره صدا نمی‌زند", async () => {
    const r = rig();
    const gate = deferred<unknown>();
    r.runtime.impl.stop = () => gate.promise;
    const h = build(r);
    await h.boot();
    r.signals.emit("SIGTERM");
    r.signals.emit("SIGINT");
    r.signals.emit("SIGTERM");
    await flush();
    expect(r.runtime.calls.stop).toBe(1);
    expect(r.exits).toEqual([]);
    expect(h.status().shutdownReason).toBe("SIGTERM");
    gate.resolve({ clean: true });
    await flush();
    expect(r.exits).toEqual([0]);
    expect(r.runtime.calls.stop).toBe(1);
    expect(r.closes.n).toBe(1);
  });
  it("سیگنال هنگامِ خاموشیِ دستی ⇒ exit پس از پایان (با کدِ نتیجه)", async () => {
    const r = rig();
    const gate = deferred<unknown>();
    r.runtime.impl.stop = () => gate.promise;
    const h = build(r);
    await h.boot();
    const p = h.shutdown();
    r.signals.emit("SIGTERM");
    await flush();
    expect(r.exits).toEqual([]);
    expect(r.runtime.calls.stop).toBe(1);
    gate.resolve({ clean: false });
    const res = await p;
    expect(res.reason).toBe("MANUAL");
    expect(r.exits).toEqual([1]);
  });
  it("خاموشیِ دستیِ بی‌سیگنال هرگز exit را صدا نمی‌زند", async () => {
    const r = rig();
    const h = build(r);
    await h.boot();
    await h.shutdown();
    expect(r.exits).toEqual([]);
  });
  it("بدونِ exit: سیگنال فقط خاموش می‌کند و نمی‌پرتابد", async () => {
    const r = rig();
    delete r.config["exit"];
    const h = build(r);
    await h.boot();
    r.signals.emit("SIGTERM");
    await flush();
    expect(h.status().state).toBe("stopped");
  });
  it("exit که بپرتابد نتیجهٔ خاموشی را نمی‌شکند", async () => {
    const r = rig({ exit: () => { throw new Error(CANARY); } });
    const h = build(r);
    await h.boot();
    r.signals.emit("SIGTERM");
    await flush();
    expect(h.status().state).toBe("stopped");
    expect(JSON.stringify(await h.shutdown())).not.toContain(CANARY);
  });
  it("پس از خاموشی شنونده‌ها برداشته شده‌اند: سیگنالِ بعدی هیچ اثری ندارد", async () => {
    const r = rig();
    const h = build(r);
    await h.boot();
    await h.shutdown();
    expect(r.signals.emit("SIGTERM")).toBe(0);
    expect(r.signals.emit("SIGINT")).toBe(0);
    expect(r.exits).toEqual([]);
  });
  it("پیش از بوت شنونده‌ای نیست؛ هر دو سیگنال دقیقاً یک شنونده دارند", async () => {
    const r = rig();
    const h = build(r);
    expect(r.signals.emit("SIGTERM")).toBe(0);
    await h.boot();
    expect(r.signals.count("SIGTERM")).toBe(1);
    expect(r.signals.count("SIGINT")).toBe(1);
    expect(r.signals.count()).toBe(2);
  });
  it("سیگنال هنگامِ start ⇒ خاموشی و بوت SHUTTING_DOWN و سپس exit", async () => {
    const r = rig();
    const gate = deferred<unknown>();
    r.runtime.startQueue.push(() => gate.promise);
    const h = build(r);
    const boot = h.boot();
    await flush();
    r.signals.emit("SIGTERM");
    await flush();
    expect(r.runtime.calls.stop).toBe(1);
    expect(r.exits).toEqual([]);
    gate.resolve({ started: false, reason: "STOPPED_DURING_START", code: null });
    expect(await boot).toMatchObject({ reason: "SHUTTING_DOWN" });
    await flush();
    expect(r.exits).toEqual([0]);
  });
});

describe("settlement-host · پروب‌ها از راهِ میزبان", () => {
  it("پیش از بوت: live ۲۰۰، startup/ready ۵۰۳؛ بی‌آن‌که health خوانده شود", () => {
    const r = rig();
    const h = build(r);
    expect(h.probes.live().httpStatus).toBe(200);
    expect(h.probes.startup().httpStatus).toBe(503);
    expect(h.probes.ready()).toMatchObject({ httpStatus: 503, body: { state: "idle" } });
    expect(r.runtime.calls.health).toBe(0);
  });
  it("هنگامِ بوتِ کُند: live ۲۰۰ ولی startup/ready ۵۰۳ (شروعِ کُندِ پایگاه live را قرمز نمی‌کند)", async () => {
    const r = rig();
    const gate = deferred<unknown>();
    r.runtime.startQueue.push(() => gate.promise);
    const h = build(r);
    const p = h.boot();
    await flush();
    expect([h.probes.live().httpStatus, h.probes.startup().httpStatus, h.probes.ready().httpStatus]).toEqual([200, 503, 503]);
    gate.resolve({ started: true, atMs: 1 });
    await p;
    expect([h.probes.live().httpStatus, h.probes.startup().httpStatus, h.probes.ready().httpStatus]).toEqual([200, 200, 200]);
  });
  it("پس از بوتِ شکست‌خورده: live ۲۰۰، startup ۵۰۳، ready ۵۰۳", async () => {
    const r = rig();
    r.runtime.startQueue.push({ started: false, reason: "PREFLIGHT_FAILED", code: "NOT_MIGRATED" });
    const h = build(r);
    await h.boot();
    expect([h.probes.live().httpStatus, h.probes.startup().httpStatus, h.probes.ready().httpStatus]).toEqual([200, 503, 503]);
  });
  it("ready سلامتِ زندهٔ runtime را هر بار می‌خواند (degraded ۲۰۰، down ۵۰۳، پرتاب ۵۰۳)", async () => {
    const r = rig();
    const h = build(r);
    await h.boot();
    r.runtime.impl.health = () => ({ health: { status: "degraded" }, httpStatus: 200 });
    expect(h.probes.ready()).toMatchObject({ httpStatus: 200, body: { sweep: "degraded" } });
    r.runtime.impl.health = () => ({ health: { status: "down" }, httpStatus: 503 });
    expect(h.probes.ready()).toMatchObject({ httpStatus: 503, body: { sweep: "down" } });
    r.runtime.impl.health = () => { throw new Error(CANARY); };
    const bad = h.probes.ready();
    expect(bad).toMatchObject({ httpStatus: 503, body: { sweep: null } });
    expect(JSON.stringify(bad)).not.toContain(CANARY);
    r.runtime.impl.health = () => ({ health: { status: "ok" }, httpStatus: 200 });
    expect(h.probes.ready().httpStatus).toBe(200);
  });
});

describe("settlement-host · هیچ متدی نمی‌پرتابد", () => {
  it("دنبالهٔ بدجنس: بوت/خاموشی/پروب/وضعیتِ مکرر با پورت‌های خراب", async () => {
    const r = rig({ exit: () => { throw new Error(CANARY); }, observer: () => { throw new Error(CANARY); }, closeResources: () => { throw new Error(CANARY); } });
    r.runtime.impl.stop = () => { throw new Error(CANARY); };
    r.runtime.impl.health = () => { throw new Error(CANARY); };
    r.runtime.startQueue.push(() => { throw new Error(CANARY); });
    const h = build(r);
    const out: unknown[] = [];
    out.push(await h.boot(), await h.boot(), h.status(), h.probes.live(), h.probes.startup(), h.probes.ready());
    r.signals.emit("SIGTERM");
    out.push(await h.shutdown(), await h.shutdown(), await h.boot(), h.status(), h.probes.live(), h.probes.startup(), h.probes.ready());
    await flush();
    expect(JSON.stringify(out)).not.toContain(CANARY);
  });
});

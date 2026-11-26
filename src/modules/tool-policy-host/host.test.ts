/**
 * tool-policy-host · چرخهٔ عمر: بوت، بازتلاش، «بوت شد ≠ آماده است»، خاموشی، مهلت، سیگنال و پورتِ خصمانه — با زمانِ مجازی و پورت‌های ساختگی.
 */
import { describe, expect, it } from "vitest";
import { createToolPolicyHost } from "./index";
import type { HostEvent, ToolPolicyHost } from "./index";
import { CANARY, deferred, flush, notMigrated, rig, unavailable } from "./test-kit";
import type { Rig } from "./test-kit";

function build(r: Rig): ToolPolicyHost {
  const h = createToolPolicyHost(r.config);
  if (!h.ok) throw new Error(h.error.issues.join("; "));
  return h.value;
}
const types = (r: Rig): string[] => r.events.map((e: HostEvent) => e.type);
const hang = (): Promise<never> => new Promise<never>(() => undefined);
const notReady = (reason: string) => (): unknown => ({ state: "RUNNING", ready: false, reason, source: null, refresher: null });
const readyHealth = (): unknown => ({ state: "RUNNING", ready: true, reason: null, source: null, refresher: null });

describe("tool-policy-host · بوت", () => {
  it("موفق: سیگنال‌ها پیش از runtime.start نصب می‌شوند و نتیجه و وضعیت درست است", async () => {
    const r = rig();
    const h = build(r);
    const res = await h.boot();
    expect(res).toEqual({ booted: true, attempts: 1 });
    expect(r.log).toEqual(["signals.on:SIGTERM", "signals.on:SIGINT", "start"]);
    expect(h.status()).toEqual({ state: "running", bootAttempts: 1, hasBooted: true, hasBeenReady: false, lastBootFailure: null, shutdownReason: null });
    expect(Object.isFrozen(res)).toBe(true);
    expect(Object.isFrozen(h.status())).toBe(true);
    expect(types(r)).toEqual(["booted"]);
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
    expect(p2).toBe(p1);
    expect(h.status().state).toBe("booting");
    gate.resolve({ started: true });
    expect((await p1).booted).toBe(true);
    expect(r.runtime.calls.start).toBe(1);
  });
  it.each(["NOT_MIGRATED", "SCHEMA_MISMATCH", "ALREADY_STARTED", "STOPPING", "STOPPED_DURING_START", "SCHEDULE_FAILED"])("شکستِ %s عیناً از ریشه می‌آید و هرگز بازتلاش نمی‌شود", async (reason) => {
    const r = rig({ bootRetry: { maxAttempts: 5 } });
    r.runtime.startQueue.push({ started: false, reason });
    const h = build(r);
    const res = await h.boot();
    expect(res).toEqual({ booted: false, reason, attempts: 1 });
    expect(r.runtime.calls.start).toBe(1);
    expect(r.timer.delays).toEqual([]);
    expect(h.status()).toMatchObject({ state: "failed", hasBooted: false, lastBootFailure: { reason } });
    expect(r.events).toEqual([
      { type: "boot.attempt_failed", attempt: 1, reason, willRetry: false },
      { type: "boot.failed", attempts: 1, reason },
    ]);
  });
  it("UNAVAILABLE بازتلاش می‌شود: با تأخیرِ پیکربندی‌شده و تلاشِ سوم موفق", async () => {
    const r = rig({ bootRetry: { maxAttempts: 3, delayMs: 250 } });
    r.runtime.startQueue.push(unavailable, unavailable);
    const h = build(r);
    const p = h.boot();
    await flush();
    expect(r.runtime.calls.start).toBe(1);
    await r.timer.advance(249);
    expect(r.runtime.calls.start).toBe(1);
    await r.timer.advance(1);
    expect(r.runtime.calls.start).toBe(2);
    await r.timer.advance(250);
    expect(await p).toEqual({ booted: true, attempts: 3 });
    expect(r.timer.delays).toEqual([250, 250]);
    expect(types(r)).toEqual(["boot.attempt_failed", "boot.attempt_failed", "booted"]);
    expect(r.events[0]).toMatchObject({ willRetry: true });
    expect(h.status()).toMatchObject({ state: "running", bootAttempts: 3, lastBootFailure: null });
  });
  it("UNAVAILABLE تمام‌نشده تا سقفِ تلاش ⇒ failed با UNAVAILABLE", async () => {
    const r = rig({ bootRetry: { maxAttempts: 2, delayMs: 10 } });
    r.runtime.startQueue.push(unavailable, unavailable, unavailable);
    const h = build(r);
    const p = h.boot();
    await flush();
    await r.timer.advance(10);
    expect(await p).toEqual({ booted: false, reason: "UNAVAILABLE", attempts: 2 });
    expect(r.runtime.calls.start).toBe(2);
    expect(r.events.at(-1)).toEqual({ type: "boot.failed", attempts: 2, reason: "UNAVAILABLE" });
  });
  it("پیش‌فرض یک تلاش است: بی‌بازتلاش و بی‌زمان‌سنج", async () => {
    const r = rig();
    r.runtime.startQueue.push(unavailable);
    const h = build(r);
    expect(await h.boot()).toEqual({ booted: false, reason: "UNAVAILABLE", attempts: 1 });
    expect(r.timer.delays).toEqual([]);
  });
  it("پس از UNAVAILABLE بازتلاش‌شده، NOT_MIGRATED دیگر بازتلاش نمی‌شود", async () => {
    const r = rig({ bootRetry: { maxAttempts: 5, delayMs: 5 } });
    r.runtime.startQueue.push(unavailable, notMigrated);
    const h = build(r);
    const p = h.boot();
    await flush();
    await r.timer.advance(5);
    expect(await p).toEqual({ booted: false, reason: "NOT_MIGRATED", attempts: 2 });
    expect(r.runtime.calls.start).toBe(2);
  });
  it.each<[string, unknown]>([
    ["undefined", undefined],
    ["null", null],
    ["عدد", 5],
    ["رشته", "x"],
    ["شیء تهی", {}],
    ["started رشته", { started: "true" }],
    ["started=1", { started: 1 }],
    ["started=false بدونِ دلیل", { started: false }],
    ["دلیلِ ناشناخته", { started: false, reason: "BOGUS" }],
    ["دلیلِ قدیمیِ تسویه (PREFLIGHT_FAILED)", { started: false, reason: "PREFLIGHT_FAILED", code: "UNAVAILABLE" }],
    ["دلیلِ غیررشته", { started: false, reason: 5 }],
    ["started رشته با دلیلِ معتبر", { started: "no", reason: "NOT_MIGRATED" }],
    ["started=0 با دلیلِ معتبر", { started: 0, reason: "UNAVAILABLE" }],
    ["دلیلِ حاوی CANARY", { started: false, reason: `UNAVAILABLE ${CANARY}` }],
  ])("پاسخِ بدشکلِ start (%s) ⇒ RUNTIME_INVALID بی‌بازتلاش و بی‌نشت", async (_l, value) => {
    const r = rig({ bootRetry: { maxAttempts: 4 } });
    r.runtime.startQueue.push(value);
    const h = build(r);
    const res = await h.boot();
    expect(res).toEqual({ booted: false, reason: "RUNTIME_INVALID", attempts: 1 });
    expect(r.runtime.calls.start).toBe(1);
    expect(JSON.stringify([res, r.events])).not.toContain(CANARY);
    expect(h.status().state).toBe("failed");
  });
  it("start که بپرتابد/ردّ شود یا getterِ بدجنس داشته باشد ⇒ RUNTIME_INVALID بی‌نشت", async () => {
    for (const next of [() => { throw new Error(`boom ${CANARY}`); }, () => Promise.reject(new Error(`boom ${CANARY}`)), () => ({ get started(): boolean { throw new Error(CANARY); } })]) {
      const r = rig();
      r.runtime.startQueue.push(next);
      const h = build(r);
      const res = await h.boot();
      expect(res).toEqual({ booted: false, reason: "RUNTIME_INVALID", attempts: 1 });
      expect(JSON.stringify([res, r.events, h.status()])).not.toContain(CANARY);
    }
  });
  it("نصبِ ناموفقِ سیگنال ⇒ SIGNALS_UNAVAILABLE؛ ریشه شروع نمی‌شود و شنونده‌ی نیمه‌نصب برداشته می‌شود", async () => {
    const r = rig();
    r.signals.failOnNth(2);
    const h = build(r);
    expect(await h.boot()).toEqual({ booted: false, reason: "SIGNALS_UNAVAILABLE", attempts: 0 });
    expect(r.runtime.calls.start).toBe(0);
    expect(r.signals.count()).toBe(0);
    expect(h.status()).toMatchObject({ state: "failed", lastBootFailure: { reason: "SIGNALS_UNAVAILABLE" } });
  });
  it("signals:false آگاهانه است: بی‌شنونده و بوت موفق", async () => {
    const r = rig({ signals: false });
    const h = build(r);
    expect((await h.boot()).booted).toBe(true);
    expect(r.signals.count()).toBe(0);
    expect(r.log).toEqual(["start"]);
  });
  it("زمان‌سنجِ خراب هنگامِ انتظارِ بازتلاش ⇒ بوت با همان دلیل می‌شکند (بی‌حلقهٔ داغ)", async () => {
    const r = rig({ bootRetry: { maxAttempts: 5, delayMs: 5 } });
    r.timer.failAfter(1);
    r.runtime.startQueue.push(unavailable);
    const h = build(r);
    expect(await h.boot()).toEqual({ booted: false, reason: "UNAVAILABLE", attempts: 1 });
    expect(r.runtime.calls.start).toBe(1);
  });
  it("خاموشی در میانهٔ انتظارِ بازتلاش بیدارش می‌کند: SHUTTING_DOWN و start تازه‌ای نیست", async () => {
    const r = rig({ bootRetry: { maxAttempts: 5, delayMs: 60_000 } });
    r.runtime.startQueue.push(unavailable);
    const h = build(r);
    const p = h.boot();
    await flush();
    const s = await h.shutdown();
    expect(await p).toEqual({ booted: false, reason: "SHUTTING_DOWN", attempts: 1 });
    expect(r.runtime.calls.start).toBe(1);
    expect(s.ok).toBe(true);
    expect(r.timer.pending()).toBe(0);
  });
  it("خاموشی در میانهٔ start: stop صدا زده می‌شود، خاموشی منتظرِ بوت می‌ماند و running نمی‌شود", async () => {
    const r = rig();
    const gate = deferred<unknown>();
    r.runtime.startQueue.push(() => gate.promise);
    const h = build(r);
    const pb = h.boot();
    await flush();
    let done = false;
    const ps = h.shutdown().then((x) => ((done = true), x));
    await flush();
    expect(r.runtime.calls.stop).toBe(1);
    expect(done).toBe(false); // تا پایانِ start منتظر می‌ماند
    gate.resolve({ started: true });
    expect(await pb).toEqual({ booted: false, reason: "SHUTTING_DOWN", attempts: 1 });
    expect((await ps).ok).toBe(true);
    expect(h.status()).toMatchObject({ state: "stopped", hasBooted: false });
    expect(r.log.indexOf("stop")).toBeLessThan(r.log.indexOf("close"));
  });
  it("پس از شکستِ بوت، boot دوباره ممکن است و شمارنده/شکستِ قدیمی بازنشانی می‌شود", async () => {
    const r = rig();
    r.runtime.startQueue.push(notMigrated);
    const h = build(r);
    expect((await h.boot()).booted).toBe(false);
    expect(r.signals.count()).toBe(2);
    expect(await h.boot()).toEqual({ booted: true, attempts: 1 });
    expect(h.status()).toMatchObject({ state: "running", lastBootFailure: null, hasBooted: true });
    expect(r.signals.count()).toBe(2); // نصبِ دوباره‌ی تکراری نیست
  });
  it("پس از خاموشی boot ⇒ SHUTTING_DOWN و start نمی‌خورد", async () => {
    const r = rig();
    const h = build(r);
    await h.shutdown();
    expect(await h.boot()).toEqual({ booted: false, reason: "SHUTTING_DOWN", attempts: 0 });
    expect(r.runtime.calls.start).toBe(0);
    expect(h.status().state).toBe("stopped");
  });
  it("پس از آماده‌شدن هم boot همان نتیجهٔ کش‌شده را می‌دهد و start دوباره نمی‌خورد", async () => {
    const r = rig();
    const h = build(r);
    const a = await h.boot();
    h.probes.ready();
    expect(await h.boot()).toBe(a);
    expect(r.runtime.calls.start).toBe(1);
  });
});

describe("tool-policy-host · «بوت شد» ≠ «آماده است»", () => {
  it("پس از start موفق ولی پیش از نخستین تازه‌سازی: running است، اما ready و startup ⇒ ۵۰۳ با دلیلِ ثابت", async () => {
    const r = rig();
    r.runtime.impl.health = notReady("NOT_LOADED");
    const h = build(r);
    await h.boot();
    expect(h.status().state).toBe("running");
    expect(h.probes.live().httpStatus).toBe(200);
    expect(h.probes.startup()).toEqual({ httpStatus: 503, body: { probe: "startup", ok: false, state: "running", reason: null } });
    expect(h.probes.ready()).toEqual({ httpStatus: 503, body: { probe: "ready", ok: false, state: "running", reason: "NOT_LOADED" } });
    expect(h.status().hasBeenReady).toBe(false);
    expect(types(r)).toEqual(["booted"]);
  });
  it("وقتی ریشه آماده شد پروبِ startup ۲۰۰ و چسبنده می‌شود (ready.first فقط یک بار)", async () => {
    const r = rig();
    r.runtime.impl.health = notReady("NOT_LOADED");
    const h = build(r);
    await h.boot();
    expect(h.probes.startup().httpStatus).toBe(503);
    r.runtime.impl.health = readyHealth;
    expect(h.probes.startup()).toMatchObject({ httpStatus: 200, body: { ok: true, state: "running" } });
    expect(h.status().hasBeenReady).toBe(true);
    expect(h.probes.ready().httpStatus).toBe(200);
    expect(types(r).filter((t) => t === "ready.first")).toHaveLength(1);
    // سپس منبع کهنه می‌شود: ready می‌افتد ولی startup ۲۰۰ می‌ماند (سرویس را نباید دوباره «در حالِ بوت» نشان داد).
    r.runtime.impl.health = notReady("STALE");
    expect(h.probes.ready()).toMatchObject({ httpStatus: 503, body: { reason: "STALE" } });
    expect(h.probes.startup().httpStatus).toBe(200);
    r.runtime.impl.health = readyHealth;
    expect(h.probes.ready().httpStatus).toBe(200); // بهبود
    expect(types(r).filter((t) => t === "ready.first")).toHaveLength(1);
  });
  it("پروبِ ready هم خودش نخستین آمادگی را چسبنده می‌کند", async () => {
    const r = rig();
    const h = build(r);
    await h.boot();
    expect(h.status().hasBeenReady).toBe(false);
    expect(h.probes.ready().httpStatus).toBe(200);
    expect(h.status().hasBeenReady).toBe(true);
    expect(types(r)).toEqual(["booted", "ready.first"]);
  });
  it("live هرگز سلامت را نمی‌خواند و چسبنده نمی‌کند", async () => {
    const r = rig();
    const h = build(r);
    await h.boot();
    const before = r.runtime.calls.health;
    for (let i = 0; i < 5; i++) expect(h.probes.live().httpStatus).toBe(200);
    expect(r.runtime.calls.health).toBe(before);
    expect(h.status().hasBeenReady).toBe(false);
  });
  it("هر پروب حداکثر یک بار health() می‌خواند", async () => {
    const r = rig();
    const h = build(r);
    await h.boot();
    r.runtime.impl.health = notReady("STALE");
    for (const k of ["startup", "ready"] as const) {
      const before = r.runtime.calls.health;
      h.probes[k]();
      expect(r.runtime.calls.health - before).toBe(1);
    }
    r.runtime.impl.health = readyHealth;
    for (const k of ["startup", "ready"] as const) {
      const before = r.runtime.calls.health;
      h.probes[k]();
      expect(r.runtime.calls.health - before).toBeLessThanOrEqual(2); // startup: یک بار برای چسباندن
    }
  });
  it("تا running نیست چسبنده نمی‌شود، حتی اگر ریشه «آماده» بگوید (idle، booting، failed، stopping)", async () => {
    const r = rig();
    const gate = deferred<unknown>();
    r.runtime.startQueue.push(() => gate.promise);
    const h = build(r);
    expect(h.probes.startup().httpStatus).toBe(503); // idle
    expect(h.probes.ready().httpStatus).toBe(503);
    const pb = h.boot();
    await flush();
    expect(h.probes.startup().httpStatus).toBe(503); // booting
    expect(h.probes.ready().httpStatus).toBe(503);
    gate.resolve({ started: false, reason: "NOT_MIGRATED" });
    await pb;
    expect(h.probes.startup().httpStatus).toBe(503); // failed
    expect(h.probes.ready().httpStatus).toBe(503);
    expect(h.status().hasBeenReady).toBe(false);
    expect(types(r)).not.toContain("ready.first");
  });
  it("با آغازِ خاموشی ready فوراً ۵۰۳ می‌شود (ریشه هنوز «آماده» بگوید) ولی startup چسبنده می‌ماند", async () => {
    const r = rig();
    const h = build(r);
    await h.boot();
    expect(h.probes.ready().httpStatus).toBe(200);
    r.runtime.impl.stop = hang;
    void h.shutdown();
    await flush();
    expect(h.status().state).toBe("stopping");
    expect(h.probes.ready()).toMatchObject({ httpStatus: 503, body: { state: "stopping", reason: null } });
    expect(h.probes.startup().httpStatus).toBe(200);
    expect(h.probes.live().httpStatus).toBe(200);
  });
  it("در خاموشی/توقف نخستین آمادگی چسبنده نمی‌شود", async () => {
    const r = rig();
    r.runtime.impl.health = notReady("NOT_LOADED");
    const h = build(r);
    await h.boot();
    await h.shutdown();
    r.runtime.impl.health = readyHealth;
    expect(h.probes.startup().httpStatus).toBe(503);
    expect(h.probes.ready().httpStatus).toBe(503);
    expect(h.status().hasBeenReady).toBe(false);
  });
  it("health ریشه بپرتابد یا ناسازگار باشد ⇒ ready ۵۰۳ با HEALTH_UNAVAILABLE، چسبنده نمی‌شود، بی‌نشت", async () => {
    const r = rig();
    const h = build(r);
    await h.boot();
    for (const health of [() => { throw new Error(`boom ${CANARY}`); }, () => ({ state: "RUNNING", ready: true, reason: "STALE" }), () => null, () => ({ ready: "yes" })]) {
      r.runtime.impl.health = health;
      const a = h.probes.ready();
      const b = h.probes.startup();
      expect(a).toEqual({ httpStatus: 503, body: { probe: "ready", ok: false, state: "running", reason: "HEALTH_UNAVAILABLE" } });
      expect(b.httpStatus).toBe(503);
      expect(JSON.stringify([a, b])).not.toContain(CANARY);
    }
    expect(h.status().hasBeenReady).toBe(false);
  });
  it("مشاهده‌گرِ پرتابگر روی ready.first پروب را نمی‌شکند", async () => {
    const r = rig({ observer: () => { throw new Error(CANARY); } });
    const h = build(r);
    await h.boot();
    expect(h.probes.ready().httpStatus).toBe(200);
    expect(h.status().hasBeenReady).toBe(true);
  });
});

describe("tool-policy-host · خاموشی", () => {
  it("ترتیب: stop ← close ← برداشتنِ شنونده‌ها؛ نتیجهٔ ok و وضعیت stopped", async () => {
    const r = rig();
    const h = build(r);
    await h.boot();
    const res = await h.shutdown();
    expect(res).toEqual({ ok: true, clean: true, timedOut: false, closed: "ok", reason: "MANUAL" });
    expect(r.log).toEqual(["signals.on:SIGTERM", "signals.on:SIGINT", "start", "stop", "close", "signals.off:SIGTERM", "signals.off:SIGINT"]);
    expect(h.status()).toMatchObject({ state: "stopped", shutdownReason: "MANUAL" });
    expect(r.signals.count()).toBe(0);
    expect(r.exits).toEqual([]); // خاموشیِ دستی exit نمی‌زند
    expect(Object.isFrozen(res)).toBe(true);
  });
  it("هم‌زمان: یک وعده و یک stop و یک close", async () => {
    const r = rig();
    const h = build(r);
    await h.boot();
    const p1 = h.shutdown();
    const p2 = h.shutdown();
    expect(p2).toBe(p1);
    await p1;
    expect(await h.shutdown()).toBe(await p1);
    expect(r.runtime.calls.stop).toBe(1);
    expect(r.closes.n).toBe(1);
  });
  it("بدونِ closeResources: closed=none و ok", async () => {
    const r = rig({ closeResources: undefined });
    const h = build(r);
    await h.boot();
    expect(await h.shutdown()).toMatchObject({ ok: true, closed: "none" });
  });
  it("خاموشیِ میزبانِ هرگز-بوت‌نشده هم stop را می‌زند و تمیز تمام می‌شود", async () => {
    const r = rig();
    const h = build(r);
    expect(await h.shutdown()).toMatchObject({ ok: true, clean: true });
    expect(r.runtime.calls.stop).toBe(1);
  });
  it.each<[string, unknown]>([
    ["abandonedInFlight=true", { stopped: true, abandonedInFlight: true }],
    ["stopped=false", { stopped: false, abandonedInFlight: false }],
    ["abandonedInFlight ناموجود", { stopped: true }],
    ["abandonedInFlight رشته", { stopped: true, abandonedInFlight: "false" }],
    ["شکلِ قدیمیِ clean:true", { clean: true }],
    ["null", null],
    ["undefined", undefined],
    ["رشته", "stopped"],
  ])("توقفِ ناتمیز یا ناشناخته (%s) ⇒ clean=false، closeResources صدا زده نمی‌شود (closed=skipped)", async (_l, value) => {
    const r = rig();
    r.runtime.impl.stop = () => value;
    const h = build(r);
    await h.boot();
    const res = await h.shutdown();
    expect(res).toEqual({ ok: false, clean: false, timedOut: false, closed: "skipped", reason: "MANUAL" });
    expect(r.closes.n).toBe(0);
  });
  it("stop که بپرتابد/ردّ شود ⇒ ناتمیز و بی‌نشت و بی‌close", async () => {
    for (const stop of [() => { throw new Error(`boom ${CANARY}`); }, () => Promise.reject(new Error(`boom ${CANARY}`))]) {
      const r = rig({ observer: undefined });
      r.runtime.impl.stop = stop;
      const h = build(r);
      const res = await h.shutdown();
      expect(res).toMatchObject({ ok: false, clean: false, closed: "skipped" });
      expect(JSON.stringify(res)).not.toContain(CANARY);
      expect(r.closes.n).toBe(0);
    }
  });
  it("خاموشی منتظرِ بوتِ آویزان: stop تمیز و بدونِ closeResources ولی مهلت گذشته ⇒ ok=false (timedOut)", async () => {
    const r = rig({ closeResources: undefined, shutdownTimeoutMs: 500 });
    r.runtime.startQueue.push(hang);
    const h = build(r);
    void h.boot();
    await flush();
    const p = h.shutdown();
    await flush();
    await r.timer.advance(500);
    expect(await p).toEqual({ ok: false, clean: true, timedOut: true, closed: "none", reason: "MANUAL" });
  });
  it("توقفِ ناتمیز بدونِ closeResources ⇒ ok=false (closed=none ولی clean=false)", async () => {
    const r = rig({ closeResources: undefined });
    r.runtime.impl.stop = () => ({ stopped: true, abandonedInFlight: true });
    const h = build(r);
    await h.boot();
    expect(await h.shutdown()).toEqual({ ok: false, clean: false, timedOut: false, closed: "none", reason: "MANUAL" });
  });
  it("closeResources که بپرتابد ⇒ closed=failed و ok=false ولی clean=true", async () => {
    const r = rig({ closeResources: () => { throw new Error(`boom ${CANARY}`); } });
    const h = build(r);
    await h.boot();
    const res = await h.shutdown();
    expect(res).toEqual({ ok: false, clean: true, timedOut: false, closed: "failed", reason: "MANUAL" });
    expect(JSON.stringify(res)).not.toContain(CANARY);
    expect(h.status().state).toBe("stopped");
  });
  it("closeResources ناهمگامِ ردّشونده هم closed=failed است", async () => {
    const r = rig({ closeResources: () => Promise.reject(new Error(CANARY)) });
    const h = build(r);
    expect(await h.shutdown()).toMatchObject({ ok: false, clean: true, closed: "failed" });
  });
  it("stop آویزان ⇒ پس از shutdownTimeoutMs timedOut و closed=skipped", async () => {
    const r = rig({ shutdownTimeoutMs: 4_000 });
    r.runtime.impl.stop = hang;
    const h = build(r);
    await h.boot();
    const p = h.shutdown();
    await flush();
    await r.timer.advance(3_999);
    expect(h.status().state).toBe("stopping");
    await r.timer.advance(1);
    expect(await p).toEqual({ ok: false, clean: false, timedOut: true, closed: "skipped", reason: "MANUAL" });
    expect(h.status().state).toBe("stopped");
    expect(r.closes.n).toBe(0);
  });
  it("closeResources آویزان ⇒ timedOut و closed=failed", async () => {
    const r = rig({ shutdownTimeoutMs: 1_000, closeResources: hang });
    const h = build(r);
    await h.boot();
    const p = h.shutdown();
    await flush();
    await r.timer.advance(1_000);
    expect(await p).toEqual({ ok: false, clean: true, timedOut: true, closed: "failed", reason: "MANUAL" });
  });
  it("پیش‌فرضِ مهلت ۱۵ثانیه است و پایانِ به‌موقع مهلت را لغو می‌کند", async () => {
    const r = rig();
    const h = build(r);
    await h.boot();
    await h.shutdown();
    expect(r.timer.delays).toEqual([15_000]);
    expect(r.timer.pending()).toBe(0);
    expect(r.timer.cancelled()).toBe(1);
  });
  it("زمان‌سنجِ خرابِ مهلت مانعِ توقف نیست (فقط بی‌مهلت)", async () => {
    const r = rig();
    r.timer.failAfter(1);
    const h = build(r);
    await h.boot();
    expect(await h.shutdown()).toMatchObject({ ok: true, clean: true, timedOut: false });
  });
});

describe("tool-policy-host · سیگنال و exit", () => {
  it("SIGTERM ⇒ خاموشی ⇒ exit(0) پس از پایانِ کامل", async () => {
    const r = rig();
    const h = build(r);
    await h.boot();
    expect(r.signals.emit("SIGTERM")).toBe(1);
    await flush();
    expect(r.exits).toEqual([0]);
    expect(r.log.slice(-4)).toEqual(["close", "signals.off:SIGTERM", "signals.off:SIGINT", "exit:0"]);
    expect(h.status()).toMatchObject({ state: "stopped", shutdownReason: "SIGTERM" });
    expect(r.events.find((e) => e.type === "shutdown.finished")).toMatchObject({ reason: "SIGTERM", ok: true });
  });
  it("SIGINT ⇒ reason=SIGINT؛ خاموشیِ ناموفق ⇒ exit(1)", async () => {
    const r = rig();
    r.runtime.impl.stop = () => ({ stopped: true, abandonedInFlight: true });
    const h = build(r);
    await h.boot();
    r.signals.emit("SIGINT");
    await flush();
    expect(r.exits).toEqual([1]);
    expect(h.status().shutdownReason).toBe("SIGINT");
  });
  it("سیگنالِ تکراری بی‌اثر است (خاموشی را نمی‌کُشد) و exit یک بار", async () => {
    const r = rig();
    const h = build(r);
    await h.boot();
    r.signals.emit("SIGTERM");
    r.signals.emit("SIGTERM");
    r.signals.emit("SIGINT");
    await flush();
    expect(r.runtime.calls.stop).toBe(1);
    expect(r.exits).toEqual([0]);
  });
  it("خاموشیِ دستیِ در جریان و سپس سیگنال ⇒ exit پس از همان خاموشی", async () => {
    const r = rig();
    const gate = deferred<unknown>();
    r.runtime.impl.stop = () => gate.promise;
    const h = build(r);
    await h.boot();
    const p = h.shutdown();
    await flush();
    r.signals.emit("SIGTERM");
    expect(r.exits).toEqual([]);
    gate.resolve({ stopped: true, abandonedInFlight: false });
    await p;
    await flush();
    expect(r.exits).toEqual([0]);
    expect(h.status().shutdownReason).toBe("MANUAL");
  });
  it("بدونِ exit هیچ فرایندی بسته نمی‌شود؛ exit پرتابگر فرایند را نمی‌شکند", async () => {
    const r1 = rig({ exit: undefined });
    const h1 = build(r1);
    await h1.boot();
    r1.signals.emit("SIGTERM");
    await flush();
    expect(h1.status().state).toBe("stopped");
    const r2 = rig({ exit: () => { throw new Error(CANARY); } });
    const h2 = build(r2);
    await h2.boot();
    r2.signals.emit("SIGTERM");
    await flush();
    expect(h2.status().state).toBe("stopped");
  });
  it("برداشتنِ ناموفقِ شنونده بی‌پرتاب است", async () => {
    const r = rig();
    const h = build(r);
    await h.boot();
    r.signals.breakOff();
    expect((await h.shutdown()).ok).toBe(true);
  });
  it("رویدادها به ترتیب و بسته‌اند؛ مشاهده‌گرِ پرتابگر/ناهمگامِ ردّشونده رفتار را عوض نمی‌کند", async () => {
    const r = rig();
    const h = build(r);
    await h.boot();
    await h.shutdown();
    expect(types(r)).toEqual(["booted", "shutdown.started", "shutdown.finished"]);
    expect(r.events.every((e) => Object.isFrozen(e))).toBe(true);
    for (const observer of [() => { throw new Error(CANARY); }, () => Promise.reject(new Error(CANARY))]) {
      const q = rig({ observer });
      const hh = build(q);
      expect((await hh.boot()).booted).toBe(true);
      expect((await hh.shutdown()).ok).toBe(true);
      await flush();
    }
  });
  it("هیچ متدی نمی‌پرتابد وقتی health/stop/start همه خراب‌اند", async () => {
    const r = rig();
    r.runtime.startQueue.push(() => { throw new Error(CANARY); });
    r.runtime.impl.health = () => { throw new Error(CANARY); };
    r.runtime.impl.stop = () => { throw new Error(CANARY); };
    const h = build(r);
    const results = [await h.boot(), h.probes.live(), h.probes.startup(), h.probes.ready(), h.status(), await h.shutdown()];
    expect(JSON.stringify(results)).not.toContain(CANARY);
  });
});

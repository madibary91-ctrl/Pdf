/**
 * settlement-runtime · چرخهٔ عمر، پیش‌بازرسی، سلامت و پول — روی دفتر و outbox حافظه‌ایِ واقعی و زمانِ مجازی.
 * هیچ `sweep()` دستی در کار نیست: همه‌چیز را فقط خودِ اجرا (start) پیش می‌برد.
 */
import { describe, expect, it } from "vitest";
import { createSettlementRuntime } from "./index";
import type { SettlementRuntime } from "./index";
import { CANARY, FUNDS, GRACE, KEY, UNIT, WORST, audit, balance, flush, must, orphan, reserveInput, tracedOutbox, world } from "./test-kit";
import type { World } from "./test-kit";

const NOOP = () => undefined;
const HALF = GRACE / 2;
const INTERVAL = GRACE / 4;

function make(w: World, over: Record<string, unknown> = {}): SettlementRuntime {
  const r = createSettlementRuntime({ ledger: w.ledger, outbox: w.outbox, clock: w.timer.clock, timer: w.timer, graceMs: GRACE, deadLetters: false, ...over });
  if (!r.ok) throw new Error(r.error.issues.join("; "));
  return r.value;
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const codes = (rt: SettlementRuntime): string[] => rt.health().health.reasons.map((x) => x.code);

describe("settlement-runtime · پول: خودِ اجرا رزروهای یتیم را می‌بندد", () => {
  it("رزروِ یتیم بی‌هیچ sweep دستی پس از graceMs بسته می‌شود (forfeit) و ناوردای پول برقرار است", async () => {
    const w = await world({ policy: "forfeit" });
    const rt = make(w);
    await orphan(w, "r1");
    expect((await rt.start()).started).toBe(true);
    await w.timer.advance(GRACE - 1);
    expect((await balance(w.ledger)).held).toBe(WORST);
    await w.timer.advance(1 + 2 * INTERVAL);
    expect(await balance(w.ledger)).toMatchObject({ held: 0, available: FUNDS - WORST, totals: { forfeited: WORST, charged: 0 } });
    await audit(w.store);
    await rt.stop();
  });
  it("با سیاست release مبلغ آزاد می‌شود", async () => {
    const w = await world({ policy: "release" });
    const rt = make(w);
    await orphan(w, "r1");
    await rt.start();
    await w.timer.advance(GRACE + 2 * INTERVAL);
    expect(await balance(w.ledger)).toMatchObject({ held: 0, available: FUNDS, totals: { forfeited: 0 } });
    await audit(w.store);
    await rt.stop();
  });
  it("۲۵ رزروِ یتیم همه بسته می‌شوند (تخلیه) و هزینه دقیقاً یک بار گرفته می‌شود", async () => {
    const w = await world();
    const rt = make(w, { limit: 5 });
    for (let i = 0; i < 25; i++) await orphan(w, `r${i}`);
    await rt.start();
    await w.timer.advance(GRACE + 4 * INTERVAL);
    const b = await balance(w.ledger);
    expect(b.held).toBe(0);
    expect(b.totals.forfeited).toBe(25 * WORST);
    await audit(w.store);
    await rt.stop();
  });
  it("دو اجرای هم‌زمان روی یک outbox و دفتر هیچ رزروی را دوبار نمی‌بندند (اجارهٔ پیش‌فرض)", async () => {
    const w = await world();
    const a = make(w, { limit: 3 });
    const b = make(w, { limit: 3 });
    for (let i = 0; i < 12; i++) await orphan(w, `r${i}`);
    await a.start();
    await b.start();
    await w.timer.advance(GRACE + 5 * INTERVAL);
    const bal = await balance(w.ledger);
    expect(bal.held).toBe(0);
    expect(bal.totals.forfeited).toBe(12 * WORST);
    await audit(w.store);
    await a.stop();
    await b.stop();
  });
  it("پس از stop دیگر چیزی بسته نمی‌شود؛ با start دوباره ادامه می‌دهد (ریستارتِ فرایند)", async () => {
    const w = await world();
    const rt = make(w);
    await rt.start();
    await rt.stop();
    await orphan(w, "r1");
    await w.timer.advance(GRACE * 3);
    expect((await balance(w.ledger)).held).toBe(WORST);
    await rt.start();
    await w.timer.advance(2 * INTERVAL);
    expect((await balance(w.ledger)).held).toBe(0);
    await audit(w.store);
    await rt.stop();
  });
});

describe("settlement-runtime · چرخهٔ عمر", () => {
  it("start: started:true با atMs = ساعتِ همان لحظه؛ status و ports درست‌اند", async () => {
    const w = await world();
    const rt = make(w);
    expect(rt.status()).toMatchObject({ state: "idle", startedAtMs: null });
    const now = w.timer.now();
    const r = await rt.start();
    expect(r).toEqual({ started: true, atMs: now });
    expect(rt.status()).toMatchObject({ state: "running", startedAtMs: now });
    expect(rt.status().loop.state).toBe("running");
    expect(rt.ports.ledger).toBe(w.ledger);
    await rt.stop();
  });
  it("start دوباره: ALREADY_RUNNING و حلقهٔ دوم ساخته نمی‌شود", async () => {
    const w = await world();
    const rt = make(w);
    await rt.start();
    const before = w.timer.pending();
    expect(await rt.start()).toEqual({ started: false, reason: "ALREADY_RUNNING", code: null });
    expect(w.timer.pending()).toBe(before);
    expect(rt.status().state).toBe("running"); // شکستِ start نباید حالتِ اجرای در حال کار را خراب کند
    await rt.stop();
  });
  it("stop: حالت idle، همهٔ تایمرها لغو، clean:true؛ stop تکراری و stop پیش از start بی‌اثر و بی‌خطاست", async () => {
    const w = await world();
    const rt = make(w);
    expect(await rt.stop()).toEqual({ clean: true });
    await rt.start();
    expect(await rt.stop()).toEqual({ clean: true });
    expect(rt.status().state).toBe("idle");
    expect(w.timer.pending()).toBe(0);
    expect(await rt.stop()).toEqual({ clean: true });
    expect(rt.health().health.status).toBe("down");
  });
  it("ریستارت: startedAtMs تازه می‌شود", async () => {
    const w = await world();
    const rt = make(w);
    const a = await rt.start();
    await rt.stop();
    await w.timer.advance(5000);
    const b = await rt.start();
    expect(a.started && b.started).toBe(true);
    if (a.started && b.started) expect(b.atMs).toBe(a.atMs + 5000);
    expect(rt.status().startedAtMs).toBe(w.timer.now());
    await rt.stop();
  });
  it("stop هم‌زمان: یک وعدهٔ مشترک؛ در این میانه start ⇒ STOPPING؛ پس از پایانِ گذر idle", async () => {
    const w = await world();
    const gate = deferred();
    const spy = tracedOutbox(w.outbox);
    const slow = { ...spy, claimDue: async (q: unknown) => (await gate.promise, spy.claimDue(q)) };
    const rt = make(w, { outbox: slow });
    await rt.start();
    await w.timer.advance(1); // گذرِ نخست در claimDue آویزان است
    await flush();
    const p1 = rt.stop();
    const p2 = rt.stop();
    expect(p1).toBe(p2);
    expect(rt.status().state).toBe("stopping");
    expect(await rt.start()).toEqual({ started: false, reason: "STOPPING", code: null });
    gate.resolve();
    expect(await p1).toEqual({ clean: true });
    expect(rt.status().state).toBe("idle");
  });
  it("گذرِ آویزان: stop پس از stopTimeoutMs clean:false؛ start ⇒ PREVIOUS_RUN_ACTIVE؛ پس از رهایی دوباره می‌شود", async () => {
    const w = await world();
    const gate = deferred();
    const spy = tracedOutbox(w.outbox);
    const slow = { ...spy, claimDue: async (q: unknown) => (await gate.promise, spy.claimDue(q)) };
    const rt = make(w, { outbox: slow, stopTimeoutMs: 5000 });
    await rt.start();
    await w.timer.advance(1);
    const p = rt.stop();
    await w.timer.advance(5000);
    expect(await p).toEqual({ clean: false });
    expect(rt.status().state).toBe("idle");
    expect(await rt.start()).toEqual({ started: false, reason: "PREVIOUS_RUN_ACTIVE", code: null });
    gate.resolve();
    await flush();
    expect((await rt.start()).started).toBe(true);
    await rt.stop();
  });
  it("زمان‌سنجِ خراب هنگامِ start (نمی‌تواند گذر بسازد): حلقه stalled و سلامت down — هرگز ok", async () => {
    const w = await world();
    const rt = make(w);
    w.timer.failAfter(1);
    await rt.start();
    await w.timer.advance(1);
    await flush();
    expect(rt.health().health.status).toBe("down");
    expect(rt.health().httpStatus).toBe(503);
    await rt.stop();
  });
  it("ساعتِ نامعتبر هنگامِ start ⇒ CLOCK_INVALID و حلقه ساخته نمی‌شود", async () => {
    for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY, "x" as unknown as number]) {
      const w = await world();
      const rt = make(w, { clock: { nowMs: () => bad } });
      expect(await rt.start()).toEqual({ started: false, reason: "CLOCK_INVALID", code: null });
      expect(w.timer.pending()).toBe(0);
      expect(rt.status().state).toBe("idle");
    }
    const w = await world();
    const rt = make(w, {
      clock: {
        nowMs: () => {
          throw new Error(CANARY);
        },
      },
    });
    const r = await rt.start();
    expect(r).toEqual({ started: false, reason: "CLOCK_INVALID", code: null });
    expect(JSON.stringify([r, rt.health(), rt.status()])).not.toContain(CANARY);
  });
});

describe("settlement-runtime · پیش‌بازرسی (شکستِ بسته)", () => {
  it("موفق ⇒ شروع؛ preflight یک بار در هر start صدا زده می‌شود", async () => {
    const w = await world();
    let n = 0;
    const rt = make(w, { preflight: async () => (n++, { ok: true }) });
    expect((await rt.start()).started).toBe(true);
    await rt.stop();
    expect((await rt.start()).started).toBe(true);
    expect(n).toBe(2);
    await rt.stop();
  });
  it.each(["NOT_MIGRATED", "SCHEMA_MISMATCH", "UNAVAILABLE"] as const)("ok:false با کدِ %s ⇒ PREFLIGHT_FAILED با همان کد و حلقه شروع نمی‌شود", async (code) => {
    const w = await world();
    const spy = tracedOutbox(w.outbox);
    const rt = make(w, { outbox: spy, preflight: async () => ({ ok: false, code }) });
    expect(await rt.start()).toEqual({ started: false, reason: "PREFLIGHT_FAILED", code });
    expect(rt.status().state).toBe("idle");
    expect(w.timer.pending()).toBe(0);
    await w.timer.advance(GRACE * 2);
    expect(spy.count["claimDue"] ?? 0).toBe(0);
    expect(rt.health().health.status).toBe("down");
  });
  it.each([
    ["کدِ ناشناخته", { ok: false, code: "WEIRD" }],
    ["بی‌کد", { ok: false }],
    ["undefined", undefined],
    ["null", null],
    ["عدد", 5],
    ["رشته", "ok"],
    ["ok رشته‌ای", { ok: "true" }],
    ["شیء بی‌ok", {}],
    ["آرایه", [true]],
  ])("نتیجهٔ نامعتبر (%s) ⇒ UNAVAILABLE", async (_n, value) => {
    const w = await world();
    const rt = make(w, { preflight: async () => value });
    expect(await rt.start()).toEqual({ started: false, reason: "PREFLIGHT_FAILED", code: "UNAVAILABLE" });
    expect(w.timer.pending()).toBe(0);
  });
  it("پیش‌بازرسیِ همگام (غیر async) هم پذیرفته می‌شود", async () => {
    const w = await world();
    const rt = make(w, { preflight: () => ({ ok: true }) });
    expect((await rt.start()).started).toBe(true);
    await rt.stop();
  });
  it("پرتابِ همگام و ردِّ async ⇒ UNAVAILABLE بی‌نشتِ پیام", async () => {
    const w = await world();
    const a = make(w, {
      preflight: () => {
        throw new Error(CANARY);
      },
    });
    const b = make(w, { preflight: () => Promise.reject(new Error(CANARY)) });
    for (const rt of [a, b]) {
      const r = await rt.start();
      expect(r).toEqual({ started: false, reason: "PREFLIGHT_FAILED", code: "UNAVAILABLE" });
      expect(JSON.stringify([r, rt.health(), rt.status()])).not.toContain(CANARY);
    }
  });
  it("آویزان: با گذشتنِ startTimeoutMs (پیش‌فرض ۱۵٬۰۰۰) ⇒ UNAVAILABLE و تایمر لغو/پاک", async () => {
    const w = await world();
    const rt = make(w, { preflight: () => new Promise(NOOP) });
    let settled: unknown = null;
    const p = rt.start().then((r) => (settled = r));
    await flush();
    await w.timer.advance(14_999);
    expect(settled).toBeNull();
    expect(rt.status().state).toBe("starting");
    await w.timer.advance(1);
    await p;
    expect(settled).toEqual({ started: false, reason: "PREFLIGHT_FAILED", code: "UNAVAILABLE" });
    expect(rt.status().state).toBe("idle");
    expect(w.timer.pending()).toBe(0);
  });
  it("startTimeoutMs صریح اعمال می‌شود", async () => {
    const w = await world();
    const rt = make(w, { preflight: () => new Promise(NOOP), startTimeoutMs: 500 });
    const p = rt.start();
    await flush();
    await w.timer.advance(500);
    expect(await p).toMatchObject({ started: false, code: "UNAVAILABLE" });
  });
  it("پیش‌بازرسیِ دیررس (پس از مهلت) نادیده گرفته می‌شود و حلقه‌ای نمی‌سازد", async () => {
    const w = await world();
    const d = deferred<unknown>();
    const rt = make(w, { preflight: () => d.promise, startTimeoutMs: 100 });
    const p = rt.start();
    await flush();
    await w.timer.advance(100);
    await p;
    d.resolve({ ok: true });
    await flush();
    expect(rt.status().state).toBe("idle");
    expect(w.timer.pending()).toBe(0);
  });
  it("زمان‌سنجِ خراب (نمی‌تواند مهلت بسازد) ⇒ preflight اصلاً صدا زده نمی‌شود و UNAVAILABLE", async () => {
    const w = await world();
    let called = 0;
    const rt = make(w, { preflight: () => (called++, { ok: true }) });
    w.timer.failAfter(1);
    const r = await rt.start();
    expect(r).toEqual({ started: false, reason: "PREFLIGHT_FAILED", code: "UNAVAILABLE" });
    expect(called).toBe(0);
    expect(JSON.stringify(r)).not.toContain(CANARY);
  });
  it("پس از رفعِ مشکل، start دوباره موفق می‌شود (بدونِ حالتِ گیرکرده)", async () => {
    const w = await world();
    let healthy = false;
    const rt = make(w, { preflight: () => (healthy ? { ok: true } : { ok: false, code: "NOT_MIGRATED" }) });
    expect((await rt.start()).started).toBe(false);
    healthy = true;
    expect((await rt.start()).started).toBe(true);
    await rt.stop();
  });
  it("start هم‌زمان در میانهٔ پیش‌بازرسی ⇒ STARTING؛ فقط یک حلقه ساخته می‌شود", async () => {
    const w = await world();
    const d = deferred<unknown>();
    const rt = make(w, { preflight: () => d.promise });
    const first = rt.start();
    await flush();
    expect(rt.status().state).toBe("starting");
    expect(await rt.start()).toEqual({ started: false, reason: "STARTING", code: null });
    d.resolve({ ok: true });
    expect((await first).started).toBe(true);
    expect(w.timer.pending()).toBeGreaterThan(0);
    await rt.stop();
    expect(w.timer.pending()).toBe(0);
  });
  it("stop در میانهٔ پیش‌بازرسی شروع را لغو می‌کند (STOPPED_DURING_START) و حلقهٔ یتیم نمی‌ماند", async () => {
    const w = await world();
    const d = deferred<unknown>();
    const rt = make(w, { preflight: () => d.promise });
    const first = rt.start();
    await flush();
    expect(await rt.stop()).toEqual({ clean: true });
    d.resolve({ ok: true });
    expect(await first).toEqual({ started: false, reason: "STOPPED_DURING_START", code: null });
    expect(rt.status().state).toBe("idle");
    expect(w.timer.pending()).toBe(0);
    // لغوِ قبلی روی start بعدی اثر نمی‌گذارد
    const again = make(w, { preflight: () => ({ ok: true }) });
    expect((await again.start()).started).toBe(true);
    await again.stop();
  });
});

describe("settlement-runtime · سلامتِ همگام (ADR-0030 روی حلقهٔ واقعی)", () => {
  it("پیش از start: down با LOOP_STOPPED و ۵۰۳ (پروبِ راه‌اندازی)", async () => {
    const w = await world();
    const rt = make(w);
    expect(rt.health()).toMatchObject({ httpStatus: 503, health: { status: "down" } });
    expect(codes(rt)).toEqual(["LOOP_STOPPED"]);
  });
  it("حلقهٔ سالم در تمامِ زمان ok/۲۰۰ می‌ماند (۱۲۰ ثانیهٔ مجازی، هر ۱ ثانیه سنجیده)", async () => {
    const w = await world();
    const rt = make(w);
    await rt.start();
    for (let s = 0; s < 120; s++) {
      await w.timer.advance(1000);
      const h = rt.health();
      expect(h.health.status, `ثانیهٔ ${s}`).toBe("ok");
      expect(h.httpStatus).toBe(200);
    }
    await rt.stop();
  });
  it("بلافاصله پس از start (پیش از نخستین گذر) سالم است نه down (مرجعِ sinceMs)", async () => {
    const w = await world();
    const rt = make(w);
    await rt.start();
    expect(rt.health().health.status).not.toBe("down");
    await rt.stop();
  });
  it("شکستِ پیاپیِ outbox: degraded/۲۰۰ ⇒ پس از graceMs سکوت down/۵۰۳ ⇒ بهبود ⇒ ok", async () => {
    const w = await world();
    const spy = tracedOutbox(w.outbox, { claimDue: { fail: 10_000 } });
    const rt = make(w, { outbox: spy });
    await rt.start();
    await w.timer.advance(HALF);
    let h = rt.health();
    expect(h.health.status).toBe("degraded");
    expect(h.httpStatus).toBe(200);
    expect(codes(rt)).toContain("LOOP_FAULTING");
    expect(h.health.lastFault).toBe("LIST_FAILED");
    await w.timer.advance(GRACE);
    h = rt.health();
    expect(h.health.status).toBe("down");
    expect(h.httpStatus).toBe(503);
    spy.plan.claimDue = { fail: 0 };
    await w.timer.advance(HALF + 1);
    h = rt.health();
    expect(h.health.status).toBe("ok");
    expect(h.httpStatus).toBe(200);
    await rt.stop();
  });
  it("outboxی که از همان آغاز هرگز موفق نمی‌شود هم پس از graceMs down می‌شود (نه degraded برای همیشه)", async () => {
    const w = await world();
    const rt = make(w, { outbox: tracedOutbox(w.outbox, { claimDue: { fail: 10_000, mode: "throw" } }) });
    await rt.start();
    await w.timer.advance(GRACE + 1);
    expect(rt.health().health.status).toBe("down");
    expect(rt.health().httpStatus).toBe(503);
    await rt.stop();
  });
  it("stop ⇒ down/LOOP_STOPPED؛ ریستارتِ پس از سکوتِ طولانی سکوتِ قدیمی را به ارث نمی‌برد", async () => {
    const w = await world();
    const rt = make(w);
    await rt.start();
    await w.timer.advance(INTERVAL * 2);
    await rt.stop();
    expect(codes(rt)).toEqual(["LOOP_STOPPED"]);
    await w.timer.advance(1_000_000);
    await rt.start();
    expect(rt.health().health.status).toBe("ok"); // بدونِ sinceMs: سکوتِ ~۱٬۰۰۰٬۰۰۰ ⇒ down
    await rt.stop();
  });
  it("health بی‌I/O است: outbox را صدا نمی‌زند و چندین بار فراخوانی همیشه هم‌شکل است", async () => {
    const w = await world();
    const spy = tracedOutbox(w.outbox);
    const rt = make(w, { outbox: spy });
    await rt.start();
    await w.timer.advance(INTERVAL);
    const calls = JSON.stringify(spy.count);
    const a = JSON.stringify(rt.health());
    for (let i = 0; i < 50; i++) rt.health();
    expect(JSON.stringify(spy.count)).toBe(calls);
    expect(JSON.stringify(rt.health())).toBe(a);
    await rt.stop();
  });
  it("نتیجهٔ health منجمد، JSON-پذیر و فقط کد/عدد است", async () => {
    const w = await world();
    const rt = make(w, { outbox: tracedOutbox(w.outbox, { claimDue: { fail: 100, mode: "throw" } }) });
    await rt.start();
    await w.timer.advance(GRACE * 2);
    const h = rt.health();
    expect(Object.isFrozen(h)).toBe(true);
    expect(Object.isFrozen(h.health)).toBe(true);
    expect(JSON.stringify(h)).not.toContain(CANARY);
    expect(JSON.parse(JSON.stringify(h))).toEqual(h);
    await rt.stop();
  });
  it("ساعتِ خراب پس از شروع ⇒ down/CLOCK_INVALID بی‌پرتاب و بی‌نشت", async () => {
    const w = await world();
    let broken = false;
    const clock = {
      nowMs: () => {
        if (broken) throw new Error(CANARY);
        return w.timer.now();
      },
    };
    const rt = make(w, { clock });
    await rt.start();
    broken = true;
    const h = rt.health();
    expect(h.health.status).toBe("down");
    expect(h.httpStatus).toBe(503);
    expect(codes(rt)).toContain("CLOCK_INVALID");
    expect(JSON.stringify(h)).not.toContain(CANARY);
    broken = false;
    await rt.stop();
  });
  it("آستانه‌های health سفارشی روی حلقهٔ واقعی اعمال می‌شوند", async () => {
    const w = await world();
    const rt = make(w, { outbox: tracedOutbox(w.outbox, { claimDue: { fail: 10_000 } }), health: { degradedAfterMs: 1000, downAfterMs: 3000 } });
    await rt.start();
    await w.timer.advance(3001);
    expect(rt.health().health.status).toBe("down");
    await rt.stop();
  });
});

describe("settlement-runtime · زنگِ ماندگار (deadLetters)", () => {
  async function seedDead(w: World, ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      must(await w.outbox.begin({ ...KEY, reservationId: id, unit: UNIT, reserved: WORST, createdAtMs: 1, expiresAtMs: 2, dueAtMs: 3, orphanRemainder: "forfeit" }));
      must(await w.outbox.bury({ ...KEY, reservationId: id }, { reason: "EXPIRED_UNBILLED", errorCode: "RESERVATION_EXPIRED", atMs: 5 }));
    }
  }
  it("deliver برای هر مرده یک بار صدا زده و تأیید می‌شود (دست‌کم‌یک‌بار)", async () => {
    const w = await world();
    const seen: string[] = [];
    const rt = make(w, { deadLetters: { deliver: (l: { reservationId: string }) => void seen.push(l.reservationId) } });
    await seedDead(w, ["d1", "d2"]);
    await rt.start();
    await w.timer.advance(INTERVAL * 3);
    expect(seen.sort()).toEqual(["d1", "d2"]);
    expect(must(await w.outbox.listUnacknowledgedDead({ limit: 10 }))).toHaveLength(0);
    expect(rt.status().loop.deadLetters).toMatchObject({ enabled: true, delivered: 2, acknowledged: 2 });
    await rt.stop();
  });
  it("deadLetters:false ⇒ هرگز به outboxِ زنگ دست نمی‌زند", async () => {
    const w = await world();
    const spy = tracedOutbox(w.outbox);
    const rt = make(w, { outbox: spy, deadLetters: false });
    await seedDead(w, ["d1"]);
    await rt.start();
    await w.timer.advance(INTERVAL * 3);
    expect(spy.count["listUnacknowledgedDead"] ?? 0).toBe(0);
    expect(rt.status().loop.deadLetters.enabled).toBe(false);
    expect(must(await w.outbox.listUnacknowledgedDead({ limit: 10 }))).toHaveLength(1);
    await rt.stop();
  });
  it("deliver خراب ⇒ degraded با DEAD_DELIVER_FAILED (۲۰۰)؛ پس از رفع تحویل و ok", async () => {
    const w = await world();
    let healthy = false;
    const delivered: string[] = [];
    const rt = make(w, {
      deadLetters: {
        deliver: (l: { reservationId: string }) => {
          if (!healthy) throw new Error(CANARY);
          delivered.push(l.reservationId);
        },
      },
    });
    await seedDead(w, ["d1"]);
    await rt.start();
    await w.timer.advance(INTERVAL * 2);
    const h = rt.health();
    expect(h.health.status).toBe("degraded");
    expect(h.httpStatus).toBe(200);
    expect(h.health.lastFault).toBe("DEAD_DELIVER_FAILED");
    expect(JSON.stringify(h)).not.toContain(CANARY);
    healthy = true;
    await w.timer.advance(HALF + INTERVAL);
    expect(delivered).toEqual(["d1"]);
    expect(rt.health().health.status).toBe("ok");
    await rt.stop();
  });
  it("رفتگر و زنگ در یک اجرا با هم کار می‌کنند: رزروِ یتیم بسته و مردهٔ بذرشده تحویل می‌شود، پول سالم می‌ماند", async () => {
    const w = await world({ policy: "forfeit" });
    const seen: string[] = [];
    const rt = make(w, { deadLetters: { deliver: (l: { reservationId: string }) => void seen.push(l.reservationId) } });
    await orphan(w, "r1");
    await seedDead(w, ["x1"]);
    await rt.start();
    await w.timer.advance(GRACE + 3 * INTERVAL);
    expect(seen).toEqual(["x1"]);
    expect((await balance(w.ledger)).held).toBe(0);
    await audit(w.store);
    await rt.stop();
  });
});

describe("settlement-runtime · مشاهده‌گر و ناورداهای کلی", () => {
  it("observer.onReport با گزارشِ گذرها صدا زده می‌شود", async () => {
    const w = await world();
    const reports: number[] = [];
    const rt = make(w, { observer: { onReport: (r: { examined: number }) => void reports.push(r.examined) } });
    await orphan(w, "r1");
    await rt.start();
    await w.timer.advance(GRACE + 2 * INTERVAL);
    expect(reports.length).toBeGreaterThan(0);
    expect(reports.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    await rt.stop();
  });
  it("هیچ متدی نمی‌پرتابد حتی با مشاهده‌گرِ پرتابگر", async () => {
    const w = await world();
    const rt = make(w, {
      observer: {
        onReport: () => {
          throw new Error(CANARY);
        },
        onFault: () => {
          throw new Error(CANARY);
        },
      },
    });
    await orphan(w, "r1");
    await expect(rt.start()).resolves.toBeDefined();
    await w.timer.advance(GRACE + INTERVAL);
    expect(() => rt.health()).not.toThrow();
    expect(() => rt.status()).not.toThrow();
    expect((await balance(w.ledger)).held).toBe(0);
    await expect(rt.stop()).resolves.toBeDefined();
  });
  it("نتیجه‌های start/stop منجمدند و ports پایدار", async () => {
    const w = await world();
    const rt = make(w);
    const s = await rt.start();
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(rt.status())).toBe(true);
    expect(rt.ports).toBe(rt.ports);
    await rt.stop();
  });
  it("مسیرِ درخواست و اجرا outbox یکی را می‌بینند: ports.outbox همان outboxِ دفترِ ماندگار است", async () => {
    const w = await world();
    const rt = make(w);
    await w.durable.reserve(reserveInput("r1"));
    const got = must(await rt.ports.outbox.get({ ...KEY, reservationId: "r1" }));
    expect(got).toMatchObject({ state: "open" });
  });
});

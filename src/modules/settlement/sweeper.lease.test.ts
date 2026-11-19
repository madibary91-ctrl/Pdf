/**
 * رفتگر و اجارهٔ رکوردها (ADR-0029): با `leaseMs` رفتگر از `claimDue` می‌خواند و چند رفتگرِ هم‌زمان **کارِ تکراریِ دفتر** نمی‌کنند؛
 * بی‌آن رفتار دقیقاً مثلِ پیش است (`listDue`). اجاره قفلِ درستی نیست (ADR-0028 هنوز خطِ دفاعِ دوم است)؛ این‌جا فقط «کمتر کارِ تکراری» و
 * «هیچ‌چیز گم نمی‌شود» سنجیده می‌شود. پورتِ بیرونی ممکن است قدیمی/خراب باشد؛ رفتگر هرگز نمی‌پرتابد.
 */
import { describe, expect, it } from "vitest";
import { SETTLEMENT_LIMITS, createMemoryOutbox, createSettlementSweeper } from "./index";
import type { OutboxEntry, SettlementOutbox, Sweeper, SweepReport } from "./index";
import { GRACE, auditLedger, flakyLedger, ok, refOf, reserveInput, rig, type Rig } from "./test-kit";

const LEASE = 20_000; // < TTLِ رزرو (۶۰٬۰۰۰) تا جلو بردنِ ساعت رزرو را منقضی نکند

const ENTRY = async (outbox: SettlementOutbox, id: string): Promise<OutboxEntry> => {
  const e = ok(await outbox.get(refOf(id)));
  if (e === null) throw new Error("رکورد باید وجود می‌داشت");
  return e;
};
const make = (x: { ledger: Rig["ledger"]; outbox: SettlementOutbox; clock: { nowMs(): number } }, over: Record<string, unknown> = {}): Sweeper => {
  const s = createSettlementSweeper({ ledger: x.ledger, outbox: x.outbox, clock: x.clock, ...over });
  if (!s.ok) throw new Error(s.error.issues.join(";"));
  return s.value;
};
const sum = (rs: readonly SweepReport[], k: "examined" | "settled" | "retryLater" | "raced" | "outboxFailures" | "buried"): number => rs.reduce((n, r) => n + (k === "buried" ? r.buried.length : r[k]), 0);
const spy = (inner: SettlementOutbox) => {
  const calls: { method: string; arg: unknown }[] = [];
  const wrapped = {
    ...inner,
    listDue: (q: never) => (calls.push({ method: "listDue", arg: { ...(q as object) } }), inner.listDue(q)),
    claimDue: (q: never) => (calls.push({ method: "claimDue", arg: { ...(q as object) } }), (inner as unknown as { claimDue(q: never): unknown }).claimDue(q)),
  } as unknown as SettlementOutbox;
  return { outbox: wrapped, calls };
};
async function reserveMany(x: Rig, n: number): Promise<void> {
  for (let i = 0; i < n; i++) ok(await x.durable.reserve(reserveInput(`r${i}`)));
}

describe("settlement · رفتگر · اجاره · پیکربندی", () => {
  const base = async () => rig({});
  it("leaseMs معتبر پذیرفته می‌شود (مرزها: ۱ و ۸۶٬۴۰۰٬۰۰۰)", async () => {
    const x = await base();
    for (const leaseMs of [1, 60_000, 86_400_000]) expect(createSettlementSweeper({ ledger: x.ledger, outbox: x.outbox, clock: x.clock, leaseMs }).ok).toBe(true);
  });

  it.each([[0], [-1], [1.5], ["5"], [null], [Number.NaN], [Number.POSITIVE_INFINITY], [86_400_001], [{}], [true]])("leaseMs=%j ⇒ INVALID_CONFIG که فقط نامِ فیلد را می‌گوید", async (bad) => {
    const x = await base();
    const r = createSettlementSweeper({ ledger: x.ledger, outbox: x.outbox, clock: x.clock, leaseMs: bad });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_CONFIG");
      expect(r.error.issues.join(" ")).toContain("leaseMs");
      expect(JSON.stringify(r.error)).not.toContain("86400001");
    }
  });

  it("با leaseMs، outboxِ بی‌claimDue ⇒ INVALID_CONFIG (خاموش‌شدنِ بی‌صدای اجاره ممنوع)", async () => {
    const x = await base();
    const { claimDue: _drop, ...legacy } = x.outbox as unknown as Record<string, unknown>;
    const r = createSettlementSweeper({ ledger: x.ledger, outbox: legacy, clock: x.clock, leaseMs: 1_000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues.join(" ")).toContain("claimDue");
  });

  it("بی‌leaseMs، outboxِ قدیمی (بی‌claimDue) همچنان معتبر است و کار می‌کند", async () => {
    const x = await base();
    const { claimDue: _drop, ...legacy } = x.outbox as unknown as Record<string, unknown>;
    expect(createSettlementSweeper({ ledger: x.ledger, outbox: legacy, clock: x.clock }).ok).toBe(true);
    expect(createSettlementSweeper({ ledger: x.ledger, outbox: legacy, clock: x.clock, leaseMs: undefined }).ok).toBe(true);
  });

  it("سقفِ اجاره در SETTLEMENT_LIMITS هم‌خوان با اعتبارسنجی است (یک شبانه‌روز)", () => {
    expect(SETTLEMENT_LIMITS.maxLeaseMs).toBe(86_400_000);
  });

  it("کلیدِ ناشناخته هنوز رد می‌شود (leaseMs به فهرستِ مجاز افزوده شد، نه اینکه بررسی شل شود)", async () => {
    const x = await base();
    expect(createSettlementSweeper({ ledger: x.ledger, outbox: x.outbox, clock: x.clock, leaseMS: 5 }).ok).toBe(false);
  });
});

describe("settlement · رفتگر · اجاره · منبعِ فهرست", () => {
  it("بی‌leaseMs (یا undefined): فقط listDue، هرگز claimDue — رفتارِ پیشین", async () => {
    for (const over of [{}, { leaseMs: undefined }]) {
      const x = await rig({});
      const s = spy(x.outbox);
      await reserveMany(x, 2);
      x.clock.advance(GRACE);
      const r = await make({ ledger: x.ledger, outbox: s.outbox, clock: x.clock }, { limit: 7, ...over }).sweep();
      expect(r).toMatchObject({ examined: 2, settled: 2 });
      expect(s.calls.map((c) => c.method)).toEqual(["listDue"]);
      expect(s.calls[0]?.arg).toEqual({ nowMs: x.clock.nowMs(), limit: 7 });
    }
  });

  it("با leaseMs: فقط claimDue با {nowMs، limit، leaseMs}، هرگز listDue", async () => {
    const x = await rig({});
    const s = spy(x.outbox);
    await reserveMany(x, 2);
    x.clock.advance(GRACE);
    const now = x.clock.nowMs();
    const r = await make({ ledger: x.ledger, outbox: s.outbox, clock: x.clock }, { limit: 7, leaseMs: 5_000 }).sweep();
    expect(r).toMatchObject({ examined: 2, settled: 2, raced: 0 });
    expect(s.calls.map((c) => c.method)).toEqual(["claimDue"]);
    expect(s.calls[0]?.arg).toEqual({ nowMs: now, limit: 7, leaseMs: 5_000 });
  });

  it("ساعتِ خراب ⇒ listFailed و هیچ تماسی با outbox (با اجاره هم)", async () => {
    const x = await rig({});
    const s = spy(x.outbox);
    const r = await make({ ledger: x.ledger, outbox: s.outbox, clock: { nowMs: () => Number.NaN } }, { leaseMs: 1_000 }).sweep();
    expect(r).toMatchObject({ examined: 0, listFailed: true });
    expect(s.calls).toEqual([]);
  });
});

describe("settlement · رفتگر · اجاره · حذفِ کارِ تکراری", () => {
  async function trial(sweepers: number, n: number, leased: boolean) {
    let fl: ReturnType<typeof flakyLedger> | undefined;
    const x = await rig({ funds: 100_000, ledger: (l) => (fl = flakyLedger(l, {})) });
    await reserveMany(x, n);
    x.clock.advance(GRACE);
    const over = leased ? { leaseMs: LEASE } : {};
    const fleet = [x.sweeper, ...Array.from({ length: sweepers - 1 }, () => make(x, over))];
    // x.sweeper بی‌اجاره است؛ برای مقایسهٔ منصفانه همهٔ اعضای ناوگان را خودمان می‌سازیم.
    const all = leased ? fleet.map((_, i) => (i === 0 ? make(x, over) : (fleet[i] as Sweeper))) : fleet;
    const reps = await Promise.all(all.map((s) => s.sweep()));
    return { x, fl: fl as ReturnType<typeof flakyLedger>, reps };
  }

  it("پایه (بی‌اجاره): ۲ رفتگر روی ۴ رکورد ⇒ close روی دفتر بیش از ۴ بار (کارِ تکراریِ بی‌ضرر) — مسئلهٔ ADR-0029", async () => {
    const { fl, reps } = await trial(2, 4, false);
    expect(fl.count["close"]).toBeGreaterThan(4);
    expect(sum(reps, "examined")).toBe(8);
  });

  it.each([[2, 4], [3, 9], [6, 5], [4, 30]])("با اجاره: %i رفتگرِ هم‌زمان روی %i رکورد ⇒ هر رکورد یک‌بار بررسی، یک close روی دفتر، بی‌raced", async (sweepers, n) => {
    const { x, fl, reps } = await trial(sweepers, n, true);
    expect(sum(reps, "examined")).toBe(n);
    expect(sum(reps, "settled")).toBe(n);
    expect(sum(reps, "raced")).toBe(0);
    expect(fl.count["close"]).toBe(n);
    for (let i = 0; i < n; i++) expect((await ENTRY(x.outbox, `r${i}`)).state).toBe("done");
    await auditLedger(x.store);
  });

  it("limit کوچک و چند رفتگر: گذرهای پیاپی همهٔ رکوردها را (بی‌تکرار) می‌بندند", async () => {
    const x = await rig({});
    await reserveMany(x, 10);
    x.clock.advance(GRACE);
    const fleet = [make(x, { leaseMs: LEASE, limit: 3 }), make(x, { leaseMs: LEASE, limit: 3 }), make(x, { leaseMs: LEASE, limit: 3 })];
    const all: SweepReport[] = [];
    for (let round = 0; round < 5; round++) all.push(...(await Promise.all(fleet.map((s) => s.sweep()))));
    expect(sum(all, "settled")).toBe(10);
    expect(sum(all, "examined")).toBe(10);
  });

  it("رفتگرِ قدیمیِ بی‌اجاره (listDue) هم اجارهٔ دیگران را رعایت می‌کند: اجاره همان «سررسیدِ عقب‌رفته» است", async () => {
    const x = await rig({});
    await reserveMany(x, 3);
    x.clock.advance(GRACE);
    const claimer = x.outbox as unknown as { claimDue(q: unknown): Promise<unknown> };
    await claimer.claimDue({ nowMs: x.clock.nowMs(), limit: 10, leaseMs: LEASE });
    const legacy = make(x); // بی‌اجاره
    expect(await legacy.sweep()).toMatchObject({ examined: 0, settled: 0 });
    x.clock.advance(LEASE);
    expect(await legacy.sweep()).toMatchObject({ examined: 3, settled: 3 });
  });

  it("نوشتنِ درون‌خطی روی رکوردِ اجاره‌شده بسته نیست: durable.close کار می‌کند، رکورد done می‌شود و رفتگر پس از پایانِ اجاره چیزی برای کار نمی‌بیند", async () => {
    const x = await rig({});
    ok(await x.durable.reserve(reserveInput("r0")));
    x.clock.advance(GRACE);
    const claimer = x.outbox as unknown as { claimDue(q: unknown): Promise<unknown> };
    await claimer.claimDue({ nowMs: x.clock.nowMs(), limit: 10, leaseMs: LEASE });
    expect((await ENTRY(x.outbox, "r0")).dueAtMs).toBe(x.clock.nowMs() + LEASE);
    ok(await x.durable.close({ ...refOf("r0"), remainder: "release" }));
    expect(await ENTRY(x.outbox, "r0")).toMatchObject({ state: "done", close: { remainder: "release", origin: "caller" } });
    x.clock.advance(LEASE);
    expect(await make(x, { leaseMs: LEASE }).sweep()).toMatchObject({ examined: 0, settled: 0 });
    await auditLedger(x.store);
  });
});

describe("settlement · رفتگر · اجاره · پایانِ اجاره و مرگِ دارنده", () => {
  it("دارندهٔ اجاره مرد (فقط claimDue زد): رفتگرِ دیگر تا پایانِ اجاره چیزی نمی‌بیند؛ دقیقاً در now+lease همه را می‌بندد (بی‌پاکسازی)", async () => {
    const x = await rig({});
    await reserveMany(x, 3);
    x.clock.advance(GRACE);
    const claimer = x.outbox as unknown as { claimDue(q: unknown): Promise<unknown> };
    await claimer.claimDue({ nowMs: x.clock.nowMs(), limit: 10, leaseMs: 5_000 });
    const s = make(x, { leaseMs: 5_000 });
    expect(await s.sweep()).toMatchObject({ examined: 0 });
    x.clock.advance(4_999);
    expect(await s.sweep()).toMatchObject({ examined: 0 });
    x.clock.advance(1);
    expect(await s.sweep()).toMatchObject({ examined: 3, settled: 3, raced: 0 });
  });

  it("اجارهٔ یک رکورد وسطِ دسته تمام شد: بقیه رها می‌شوند (raced)، دست‌نخورده می‌مانند و گذرِ بعد آن‌ها را می‌بندد؛ مجموعاً بی‌تکرار", async () => {
    let fl: ReturnType<typeof flakyLedger> | undefined;
    const x = await rig({ ledger: (l) => (fl = flakyLedger(l, {})) });
    await reserveMany(x, 4);
    x.clock.advance(GRACE);
    // ledger.close کندِ جعلی: پس از نخستین تماس ساعت به اندازهٔ کلِ اجاره جلو می‌رود.
    const slow = { ...x.ledger, close: async (i: never) => { const r = await (x.ledger.close as (i: never) => Promise<unknown>)(i); x.clock.advance(LEASE); return r; } } as unknown as typeof x.ledger;
    const s1 = make({ ledger: slow, outbox: x.outbox, clock: x.clock }, { leaseMs: LEASE });
    const r1 = await s1.sweep();
    expect(r1).toMatchObject({ examined: 4, settled: 1, raced: 3 });
    for (let i = 1; i < 4; i++) expect((await ENTRY(x.outbox, `r${i}`))).toMatchObject({ state: "open", close: null }); // حتی resolveClose هم نشد
    const r2 = await make(x, { leaseMs: LEASE }).sweep();
    expect(r2).toMatchObject({ examined: 3, settled: 3 });
    expect(fl?.count["close"]).toBe(4);
    await auditLedger(x.store);
  });

  it("مرز: اگر ساعت تا یک میلی‌ثانیه مانده به پایانِ اجاره برسد، اجاره هنوز برقرار است؛ در خودِ پایان از دست رفته", async () => {
    for (const [advance, expected] of [[LEASE - 1, { settled: 2, raced: 0 }], [LEASE, { settled: 1, raced: 1 }]] as const) {
      const x = await rig({});
      await reserveMany(x, 2);
      x.clock.advance(GRACE);
      const slow = { ...x.ledger, close: async (i: never) => { const r = await (x.ledger.close as (i: never) => Promise<unknown>)(i); x.clock.advance(advance); return r; } } as unknown as typeof x.ledger;
      // پس از نخستین close ساعت advance جلو می‌رود؛ close دوم (اگر بشود) ساعت را باز هم جلو می‌برد ولی دیگر مهم نیست.
      const r = await make({ ledger: slow, outbox: x.outbox, clock: x.clock }, { leaseMs: LEASE }).sweep();
      expect(r).toMatchObject({ examined: 2, ...expected });
    }
  });

  it("ساعت وسطِ دسته خراب شد: اجارهٔ بقیه «ثابت‌نشده» است ⇒ رها (raced)، بی‌پرتاب", async () => {
    const x = await rig({});
    await reserveMany(x, 3);
    x.clock.advance(GRACE);
    let reads = 0;
    const flakyClock = { nowMs: () => { reads += 1; if (reads <= 2) return x.clock.nowMs(); throw new Error("clock down"); } };
    const r = await make({ ledger: x.ledger, outbox: x.outbox, clock: flakyClock }, { leaseMs: LEASE }).sweep();
    // خواندنِ ۱: آغازِ گذر؛ ۲: پیش از رکوردِ اول؛ از ۳ به بعد خراب.
    expect(r).toMatchObject({ examined: 3, settled: 1, raced: 2, listFailed: false });
  });
});

describe("settlement · رفتگر · اجاره · پورتِ خراب", () => {
  const failing = (inner: SettlementOutbox, claimDue: () => unknown): SettlementOutbox => ({ ...inner, claimDue } as unknown as SettlementOutbox);
  it.each([
    ["نتیجهٔ STORE_FAILURE", () => Promise.resolve({ ok: false, error: { code: "STORE_FAILURE", message: "LEAK-CANARY-7f3a" } })],
    ["INVALID_INPUT", () => Promise.resolve({ ok: false, error: { code: "INVALID_INPUT", message: "LEAK-CANARY-7f3a" } })],
    ["پرتاب", () => { throw new Error("boom LEAK-CANARY-7f3a"); }],
    ["رد‌شدنِ promise", () => Promise.reject(new Error("LEAK-CANARY-7f3a"))],
    ["undefined", () => Promise.resolve(undefined)],
    ["ok با ارزشِ غیرِ آرایه", () => Promise.resolve({ ok: true, value: "not-an-array" })],
    ["ok با ارزشِ شیء", () => Promise.resolve({ ok: true, value: { length: 3 } })],
  ])("claimDue: %s ⇒ listFailed بی‌پرتاب و بی‌کار روی دفتر", async (_n, impl) => {
    let fl: ReturnType<typeof flakyLedger> | undefined;
    const x = await rig({ ledger: (l) => (fl = flakyLedger(l, {})) });
    await reserveMany(x, 2);
    x.clock.advance(GRACE);
    const r = await make({ ledger: x.ledger, outbox: failing(x.outbox, impl), clock: x.clock }, { leaseMs: LEASE }).sweep();
    expect(r).toMatchObject({ examined: 0, settled: 0, listFailed: true });
    expect(JSON.stringify(r)).not.toContain("LEAK-CANARY");
    expect(fl?.count["close"]).toBe(0);
  });

  it("پس از خرابیِ گذرای claimDue، گذرِ بعد عادی کار می‌کند (هیچ حالتی گیر نمی‌کند)", async () => {
    const x = await rig({});
    await reserveMany(x, 2);
    x.clock.advance(GRACE);
    let n = 0;
    const inner = x.outbox as unknown as { claimDue(q: unknown): Promise<unknown> };
    const outbox = failing(x.outbox, () => (++n === 1 ? Promise.resolve({ ok: false, error: { code: "STORE_FAILURE", message: "m" } }) : inner.claimDue({ nowMs: x.clock.nowMs(), limit: 100, leaseMs: LEASE })));
    const s = make({ ledger: x.ledger, outbox, clock: x.clock }, { leaseMs: LEASE });
    expect(await s.sweep()).toMatchObject({ listFailed: true });
    expect(await s.sweep()).toMatchObject({ examined: 2, settled: 2, listFailed: false });
  });
});

describe("settlement · رفتگر · اجاره · با شکستِ گذرا", () => {
  it("اجاره با تلاشِ دوباره سازگار است: سررسیدِ تلاشِ دوباره جایگزینِ اجاره می‌شود و attempts در هر دور دقیقاً +۱ (بی‌raced)", async () => {
    const x = await rig({ maxAttempts: 10, retryDelayMs: 1_000, ledger: (l) => flakyLedger(l, { close: { fail: 99 } }) });
    ok(await x.durable.reserve(reserveInput("r0")));
    x.clock.advance(GRACE);
    const fleet = [make(x, { leaseMs: LEASE, maxAttempts: 10, retryDelayMs: 1_000 }), make(x, { leaseMs: LEASE, maxAttempts: 10, retryDelayMs: 1_000 })];
    for (let round = 1; round <= 3; round++) {
      const reps = await Promise.all(fleet.map((s) => s.sweep()));
      expect(sum(reps, "retryLater")).toBe(1);
      expect(sum(reps, "raced")).toBe(0);
      expect(sum(reps, "examined")).toBe(1);
      const e = await ENTRY(x.outbox, "r0");
      expect(e.attempts).toBe(round);
      expect(e.dueAtMs).toBe(x.clock.nowMs() + 1_000 * round); // نه now + LEASE
      x.clock.advance(1_000 * round);
    }
  });

  it("با اجاره، رکورد دقیقاً در دورِ سقف می‌میرد (ATTEMPTS_EXHAUSTED)، نه زودتر و نه دیرتر", async () => {
    const x = await rig({ maxAttempts: 3, retryDelayMs: 1_000, ledger: (l) => flakyLedger(l, { close: { fail: 99 } }) });
    ok(await x.durable.reserve(reserveInput("r0")));
    x.clock.advance(GRACE);
    const fleet = [make(x, { leaseMs: LEASE, maxAttempts: 3, retryDelayMs: 1_000 }), make(x, { leaseMs: LEASE, maxAttempts: 3, retryDelayMs: 1_000 })];
    for (let round = 1; round <= 2; round++) {
      await Promise.all(fleet.map((s) => s.sweep()));
      expect((await ENTRY(x.outbox, "r0")).state).not.toBe("dead");
      x.clock.advance(10_000);
    }
    const last = await Promise.all(fleet.map((s) => s.sweep()));
    expect(await ENTRY(x.outbox, "r0")).toMatchObject({ state: "dead", deadReason: "ATTEMPTS_EXHAUSTED", attempts: 2 });
    expect(sum(last, "buried")).toBe(1); // با اجاره فقط یک رفتگر رکورد را دید ⇒ زنگ هم یک‌بار
  });

  it("۴ رفتگرِ هم‌زمان با اجاره + ۳ خرابیِ گذرای دفتر: هر شکست یک‌بار تلاش دوباره می‌شود؛ مجموعِ close = N + ۳ و دفتر سالم", async () => {
    let fl: ReturnType<typeof flakyLedger> | undefined;
    const x = await rig({ maxAttempts: 10, retryDelayMs: 1_000, ledger: (l) => (fl = flakyLedger(l, { close: { fail: 3 } })) });
    const N = 12;
    await reserveMany(x, N);
    x.clock.advance(GRACE);
    const fleet = Array.from({ length: 4 }, () => make(x, { leaseMs: LEASE, maxAttempts: 10, retryDelayMs: 1_000 }));
    const all: SweepReport[] = [];
    for (let round = 0; round < 4; round++) {
      all.push(...(await Promise.all(fleet.map((s) => s.sweep()))));
      x.clock.advance(10_000);
    }
    expect(sum(all, "settled")).toBe(N);
    expect(sum(all, "retryLater")).toBe(3);
    expect(sum(all, "raced")).toBe(0);
    expect(fl?.count["close"]).toBe(N + 3);
    for (let i = 0; i < N; i++) expect((await ENTRY(x.outbox, `r${i}`)).state).toBe("done");
    await auditLedger(x.store);
  });
});

describe("settlement · رفتگر · اجاره · outbox حافظه‌ای مستقل", () => {
  it("createMemoryOutbox خودش DueClaimer است (claimDue تابع)", () => {
    expect(typeof createMemoryOutbox().claimDue).toBe("function");
  });
});

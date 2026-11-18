/**
 * یکپارچگی: دروازهٔ اندازه‌گیرِ **واقعی** (metering) روی دفتر تسویهٔ ماندگار + دفتر **واقعی** + رفتگر، روی هر دو ذخیره (حافظه‌ای و PostgreSQL).
 * اثبات اصلی: شکافی که تحویل ۰۰۲۰ گزارش کرد («شکستِ تسویه ⇒ رزرو با سررسید آزاد می‌شود ⇒ کاربر مجانی می‌گیرد») با رفتگر بسته می‌شود.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryStore } from "@/modules/ledger";
import type { AccountStore, Ledger } from "@/modules/ledger";
import { createMeteredGateway } from "@/modules/metering";
import type { MeteredResult } from "@/modules/metering";
import { createDurableMeteredGateway, createMemoryOutbox, createSettlementSweeper } from "./index";
import type { SettlementOutbox } from "./index";
import { GRACE, REQUEST, TTL, WORST, auditLedger, balance, durableConfig, errResult, fakeGateway, flakyLedger, flakyOutbox, fundedLedger, journal, ok, okResult, refOf, mutableClock } from "./test-kit";
import { dbDescribe, openPgStore } from "./test-db";

const meta = (r: MeteredResult) => (r.ok ? r.value.metering : r.error.metering);

type Open = () => Promise<{ store: AccountStore; dispose(): Promise<void> }>;
const openMemory: Open = async () => ({ store: createMemoryStore(), dispose: async () => undefined });
const openPg: Open = async () => {
  const pg = await openPgStore(10);
  return { store: pg.store, dispose: pg.dispose };
};

function suite(name: string, d: typeof describe | typeof describe.skip, open: Open): void {
  d(`settlement · یکپارچگی (${name})`, () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      while (cleanups.length > 0) await (cleanups.pop() as () => Promise<void>)();
    });

    async function setup(steps: Parameters<typeof fakeGateway>[0], o: { funds?: number; policy?: "forfeit" | "release"; ledger?: (l: Ledger) => Ledger; outbox?: (o: SettlementOutbox) => SettlementOutbox; scopeId?: string } = {}) {
      const opened = await open();
      cleanups.push(opened.dispose);
      const f = await fundedLedger(o.funds ?? 10_000, opened.store);
      const raw = o.ledger?.(f.ledger) ?? f.ledger;
      const mem = createMemoryOutbox();
      const outbox = o.outbox?.(mem) ?? mem;
      const gateway = fakeGateway(steps);
      const made = createDurableMeteredGateway(durableConfig(raw, gateway, outbox, f.clock, { onUnknownCost: o.policy ?? "forfeit", ...(o.scopeId !== undefined ? { scopeId: o.scopeId } : {}) }));
      if (!made.ok) throw new Error(made.error.issues.join(";"));
      const sweeper = createSettlementSweeper({ ledger: f.ledger, outbox: mem, clock: f.clock });
      if (!sweeper.ok) throw new Error(sweeper.error.issues.join(";"));
      return { ...f, gw: made.value, gateway, outbox: mem, sweeper: sweeper.value };
    }

    it("مسیر موفق: هزینه مصرف، رزرو آزاد، رکورد done؛ رفتگر کاری ندارد", async () => {
      const t = await setup([okResult(100)]);
      const r = await t.gw.complete(REQUEST);
      expect(r.ok).toBe(true);
      expect(meta(r)).toMatchObject({ outcome: "billed", reserved: WORST, charged: 100, alarms: [] });
      expect(ok(await t.outbox.counts())).toEqual({ open: 0, settling: 0, done: 1, dead: 0 });
      expect(await t.sweeper.sweep()).toMatchObject({ examined: 0 });
      expect(await auditLedger(t.store)).toMatchObject({ available: 10_000 - 100, held: 0, charged: 100 });
    });

    it("شکاف ۰۰۲۰: شکستِ تسویه — metering تنها ⇒ کاربر مجانی؛ با رفتگر ⇒ هزینه دقیقاً یک بار ثبت می‌شود", async () => {
      // ① بی‌outbox (وضعیت تحویل ۰۰۲۰): ۳ شکستِ charge ⇒ رزرو باز می‌ماند و با سررسید آزاد می‌شود ⇒ مصرف ۰
      const o = await open();
      cleanups.push(o.dispose);
      const base = await fundedLedger(10_000, o.store);
      const plain = createMeteredGateway({
        gateway: fakeGateway([okResult(100)]),
        ledger: flakyLedger(base.ledger, { charge: { fail: 3 } }),
        account: { tenantId: "tenant-s", accountId: "acct-s" },
        currency: "IRR",
        models: { main: { price: { currency: "IRR", inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 3_000_000, version: "test-v1" }, maxOutputTokens: 1000 } },
        scopeId: "plain-1",
        reservationTtlMs: TTL,
        maxProviderCalls: 1,
        perMessageOverheadTokens: 10,
        onUnknownCost: "forfeit",
      });
      if (!plain.ok) throw new Error("x");
      expect(meta(await plain.value.complete(REQUEST))).toMatchObject({ outcome: "settlement-failed", alarms: ["SETTLEMENT_PENDING"] });
      base.clock.advance(TTL + 1);
      expect(await balance(base.ledger)).toMatchObject({ available: 10_000, held: 0, totals: { charged: 0 } }); // مجانی

      // ② با دروازهٔ ماندگار: همان شکست، ولی رفتگر هزینه را می‌گیرد
      const t = await setup([okResult(100)], { ledger: (l) => flakyLedger(l, { charge: { fail: 3 } }) });
      const r = await t.gw.complete(REQUEST);
      expect(meta(r)).toMatchObject({ outcome: "settlement-failed", alarms: ["SETTLEMENT_PENDING"] });
      expect(await balance(t.ledger)).toMatchObject({ held: WORST, totals: { charged: 0 } });
      expect(await t.sweeper.sweep()).toMatchObject({ examined: 0 }); // هنوز در مهلتِ تماس
      t.clock.advance(GRACE);
      expect(await t.sweeper.sweep()).toMatchObject({ examined: 1, settled: 1, buried: [] });
      expect(await auditLedger(t.store)).toMatchObject({ available: 10_000 - 100, held: 0, charged: 100, forfeited: 0 });
      expect(ok(await t.outbox.counts())).toEqual({ open: 0, settling: 0, done: 1, dead: 0 });
    });

    it("مرگِ واقعیِ فرایند وسط تماس (تماس هرگز برنمی‌گردد): رفتگر رزروِ یتیم را طبق سیاست می‌بندد", async () => {
      for (const policy of ["forfeit", "release"] as const) {
        const t = await setup(() => new Promise(() => undefined), { policy });
        void t.gw.complete(REQUEST); // رها شد: فرایند مرد
        // قطعی (نه خوابِ ثابت): تماس به دروازهٔ درونی رسیده ⇒ رزرو و begin پیش‌تر انجام شده‌اند.
        for (let i = 0; i < 2000 && t.gateway.calls.length === 0; i++) await new Promise((res) => setTimeout(res, 1));
        expect(t.gateway.calls).toHaveLength(1);
        expect(ok(await t.outbox.counts())).toEqual({ open: 1, settling: 0, done: 0, dead: 0 });
        expect((await balance(t.ledger)).held).toBe(WORST);
        t.clock.advance(GRACE);
        expect(await t.sweeper.sweep()).toMatchObject({ settled: 1 });
        const b = await auditLedger(t.store);
        if (policy === "forfeit") expect(b).toMatchObject({ held: 0, forfeited: WORST, available: 10_000 - WORST });
        else expect(b).toMatchObject({ held: 0, forfeited: 0, available: 10_000 }); // تصمیمِ محصولیِ صریح: کاربر مجانی
      }
    });

    it("outbox پس از تماس از کار افتاد (قصد ثبت نشد): دفتر دست‌نخورده، سپس رفتگر (forfeit) کفِ امن را می‌گیرد", async () => {
      const t = await setup([okResult(100)], { outbox: (m) => flakyOutbox(m, { recordCharge: { fail: 99 } }) });
      const r = await t.gw.complete(REQUEST);
      expect(meta(r)).toMatchObject({ outcome: "settlement-failed", charged: 0 });
      expect((await journal(t.ledger)).filter((e) => e.type === "charge")).toHaveLength(0);
      t.clock.advance(GRACE);
      expect(await t.sweeper.sweep()).toMatchObject({ settled: 1 });
      expect(await auditLedger(t.store)).toMatchObject({ held: 0, forfeited: WORST });
    });

    it("هزینه ثبت ولی بستن شکست خورد (CLOSE_PENDING): رفتگر باقیمانده را آزاد می‌کند، هزینه دوباره گرفته نمی‌شود", async () => {
      const t = await setup([okResult(100)], { ledger: (l) => flakyLedger(l, { close: { fail: 3 } }) });
      const r = await t.gw.complete(REQUEST);
      expect(meta(r)).toMatchObject({ outcome: "billed", charged: 100, alarms: ["CLOSE_PENDING"] });
      expect((await balance(t.ledger)).held).toBe(WORST - 100);
      t.clock.advance(GRACE);
      expect(await t.sweeper.sweep()).toMatchObject({ settled: 1 });
      expect(await auditLedger(t.store)).toMatchObject({ available: 10_000 - 100, held: 0, charged: 100 });
    });

    it("هزینهٔ نامعلوم: سیاست forfeit درون‌خطی اعمال و رکورد done (بی‌کارِ رفتگر)", async () => {
      const t = await setup([okResult(null)]);
      const r = await t.gw.complete(REQUEST);
      expect(meta(r)).toMatchObject({ outcome: "forfeited", alarms: ["COST_UNKNOWN"] });
      expect(ok(await t.outbox.get(refOf("scope-1.r1")))).toMatchObject({ state: "done", close: { remainder: "forfeit", origin: "caller" } });
      expect(await t.sweeper.sweep()).toMatchObject({ examined: 0 });
    });

    it("اثباتاً بی‌تماس: release درون‌خطی و رکورد done", async () => {
      const t = await setup([errResult("INVALID_REQUEST")]);
      expect(meta(await t.gw.complete(REQUEST))).toMatchObject({ outcome: "released", charged: 0 });
      expect(ok(await t.outbox.counts()).done).toBe(1);
      expect(await auditLedger(t.store)).toMatchObject({ available: 10_000, held: 0 });
    });

    it("outbox هنگام begin خراب است ⇒ تماسی انجام نمی‌شود و رزرو برمی‌گردد (بی‌ردّ ماندگار، بی‌تماس پولی)", async () => {
      const t = await setup([okResult(100)], { outbox: (m) => flakyOutbox(m, { begin: { fail: 1 } }) });
      const r = await t.gw.complete(REQUEST);
      expect(meta(r)).toMatchObject({ outcome: "refused", refusal: { code: "RESERVE_FAILED" } });
      expect(t.gateway.calls).toHaveLength(0);
      expect(await auditLedger(t.store)).toMatchObject({ available: 10_000, held: 0 });
    });

    it("استفادهٔ دوبارهٔ scopeId ⇒ SCOPE_REUSED، رکورد تازه نمی‌سازد و تماسی نیست", async () => {
      const t = await setup([okResult(10)], { scopeId: "dup" });
      expect(meta(await t.gw.complete(REQUEST)).outcome).toBe("billed");
      const second = createDurableMeteredGateway(durableConfig(t.ledger, fakeGateway([okResult(10)]), t.outbox, t.clock, { scopeId: "dup" }));
      if (!second.ok) throw new Error("x");
      expect(meta(await second.value.complete(REQUEST))).toMatchObject({ outcome: "refused", refusal: { code: "SCOPE_REUSED" } });
      expect(ok(await t.outbox.counts())).toEqual({ open: 0, settling: 0, done: 1, dead: 0 });
    });

    it("رفتگر دیر آمد (پس از سررسید رزرو): مرگِ مستند EXPIRED_UNBILLED با زنگ؛ کاربر مجانی گرفته و در listDead است", async () => {
      const t = await setup([okResult(100)], { ledger: (l) => flakyLedger(l, { charge: { fail: 3 } }) });
      await t.gw.complete(REQUEST);
      t.clock.advance(TTL + 1);
      const rep = await t.sweeper.sweep();
      expect(rep.buried).toMatchObject([{ reservationId: "scope-1.r1", reason: "EXPIRED_UNBILLED" }]);
      expect(ok(await t.outbox.listDead({ limit: 5 }))).toHaveLength(1);
      expect(await auditLedger(t.store)).toMatchObject({ available: 10_000, held: 0, charged: 0 });
    });

    it("finish همیشه شکست می‌خورد: هزینه‌ها همه درست ثبت شده‌اند و رفتگر فقط رکوردها را می‌بندد (دفتر بی‌تغییر)", async () => {
      const t = await setup(() => okResult(50), { funds: 100_000, outbox: (m) => flakyOutbox(m, { finish: { fail: 99 } }) });
      for (let i = 0; i < 5; i++) await t.gw.complete(REQUEST);
      expect(ok(await t.outbox.counts())).toEqual({ open: 0, settling: 5, done: 0, dead: 0 });
      const n = (await journal(t.ledger)).length;
      t.clock.advance(GRACE);
      expect(await t.sweeper.sweep()).toMatchObject({ examined: 5, settled: 5 });
      expect((await journal(t.ledger)).length).toBe(n);
      expect(await auditLedger(t.store)).toMatchObject({ charged: 250, held: 0 });
    });

    it("۳۰ تماس موازی روی موجودیِ ≈۱۰ رزرو + خطای دفتر: هیچ هزینه‌ای گم نمی‌شود؛ پس از رفتگر مصرف = جمع هزینه‌ها", async () => {
      let sum = 0;
      const t = await setup(
        (n) => {
          const c = 20 + ((n * 37) % 250);
          sum += c;
          return okResult(c);
        },
        { funds: WORST * 10 + 7, ledger: (l) => flakyLedger(l, { charge: { fail: 6 } }) },
      );
      const results = await Promise.all(Array.from({ length: 30 }, () => t.gw.complete(REQUEST)));
      const reserved = results.filter((r) => meta(r).reservationId !== null).length;
      expect(reserved).toBeGreaterThanOrEqual(10);
      expect(reserved).toBeLessThan(30);
      expect(t.gateway.calls).toHaveLength(reserved);
      t.clock.advance(GRACE);
      for (let i = 0; i < 4; i++) {
        await t.sweeper.sweep();
        t.clock.advance(30_000 * (i + 1) < TTL - GRACE ? 1_000 : 0);
      }
      expect(ok(await t.outbox.counts())).toEqual({ open: 0, settling: 0, done: reserved, dead: 0 });
      const a = await auditLedger(t.store);
      expect(a).toMatchObject({ held: 0, forfeited: 0 });
      expect(a.charged).toBe(sum);
    });
  });
}

suite("حافظه‌ای", describe, openMemory);
suite("PostgreSQL", dbDescribe, openPg);

describe("settlement · پیکربندی دروازهٔ ماندگار", () => {
  const base = async () => {
    const f = await fundedLedger(1000);
    return { f, cfg: durableConfig(f.ledger, fakeGateway([]), createMemoryOutbox(), f.clock) };
  };
  it("پیکربندی کامل ⇒ دروازهٔ Gateway-سازگار (complete، limits)", async () => {
    const { cfg } = await base();
    const r = createDurableMeteredGateway(cfg);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.value).sort()).toEqual(["complete", "limits"]);
  });
  it.each([
    ["غیرشیء", null, /ساده/],
    ["بی‌outbox", { outbox: undefined }, /outbox/],
    ["بی‌graceMs", { graceMs: undefined }, /graceMs/],
    ["بی‌clock", { clock: undefined }, /clock/],
    ["ttl کمتر از ۲×graceMs", { reservationTtlMs: 19_999 }, /دو برابر/],
    ["onUnknownCost نبود (یک‌بار گزارش)", { onUnknownCost: undefined }, /onUnknownCost/],
    ["مشکل metering (ارز)", { currency: "x" }, /currency/],
    ["کلید ناشناخته", { bogus: 1 }, /ناشناخته/],
  ])("%s ⇒ INVALID_CONFIG", async (_n, over, re) => {
    const { cfg } = await base();
    const r = createDurableMeteredGateway(over === null ? null : { ...cfg, ...over });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_CONFIG");
      expect(r.error.issues.join(" ")).toMatch(re);
    }
  });
  it("مشکل مشترک (onUnknownCost) فقط یک‌بار گزارش می‌شود", async () => {
    const { cfg } = await base();
    const r = createDurableMeteredGateway({ ...cfg, onUnknownCost: undefined });
    if (r.ok) throw new Error("x");
    expect(r.error.issues.filter((i) => i.includes("onUnknownCost"))).toHaveLength(1);
  });
  it("هرگز نمی‌پرتابد (getter خصمانه)", () => {
    const evil = {
      get gateway(): never {
        throw new Error("x");
      },
    };
    expect(createDurableMeteredGateway(evil).ok).toBe(false);
  });
});

describe("settlement · ساعتِ مشترک", () => {
  it("mutableClock یکنواست (نگهبان کمک‌تست)", () => {
    const c = mutableClock(5);
    c.advance(3);
    expect(c.nowMs()).toBe(8);
  });
});

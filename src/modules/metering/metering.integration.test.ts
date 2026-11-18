/**
 * یکپارچگی: دروازهٔ اندازه‌گیر + دروازهٔ تاب‌آورِ **واقعی** + دفتر **واقعی**، روی هر دو ذخیره (حافظه‌ای و PostgreSQL).
 * هزینه‌ها همه از `report` واقعیِ دروازه می‌آیند (نه ساختگی). قیمت‌ها ساختگیِ آزمون‌اند (test-kit).
 */
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryStore } from "@/modules/ledger";
import type { AccountStore } from "@/modules/ledger";
import { createMeteredGateway } from "./index";
import type { MeteredGateway, MeteredResult } from "./index";
import { KEY, auditLedger, realResilientGateway, stepProvider } from "./integration-kit";
import type { Step } from "./integration-kit";
import { REQUEST, WORST, config, fakeGateway, fundedLedger, okResult } from "./test-kit";
import { dbDescribe, openPgStore } from "./test-db";

const meta = (r: MeteredResult) => (r.ok ? r.value.metering : r.error.metering);
const RESERVE_4 = 528 * 4; // بیشینهٔ main(۳۱۴) و alt(۵۲۸) × ۴ تلاش کل
const OK: Step = { reply: { inputTokens: 10, outputTokens: 50 } }; // main: ۱۰ + ۱۵۰ = ۱۶۰ ؛ alt: ۲۰ + ۲۵۰ = ۲۷۰
const UNAVAILABLE: Step = { fail: "unavailable" };

type Open = () => Promise<{ store: AccountStore; dispose(): Promise<void> }>;
const openMemory: Open = async () => ({ store: createMemoryStore(), dispose: async () => undefined });

function suite(name: string, d: typeof describe | typeof describe.skip, open: Open): void {
  d(`metering · یکپارچگی (${name})`, () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      while (cleanups.length > 0) await (cleanups.pop() as () => Promise<void>)();
    });
    async function rig(funds: number, p1: Step[], p2: Step[], over: Record<string, unknown> = {}) {
      const opened = await open();
      cleanups.push(opened.dispose);
      const f = await fundedLedger(funds, opened.store);
      const prov1 = stepProvider(p1);
      const prov2 = stepProvider(p2);
      const made = createMeteredGateway(config(f.ledger, realResilientGateway(prov1, prov2), { maxProviderCalls: 4, fallbacks: { main: ["alt"] }, ...over }));
      if (!made.ok) throw new Error(made.error.issues.join(";"));
      return { ...f, gw: made.value as MeteredGateway, prov1, prov2 };
    }

    it("موفقیت در نخستین تلاش: هزینهٔ واقعیِ report (۱۶۰) مصرف؛ رزرو = بدترین × ۴ برگشت می‌خورد", async () => {
      const t = await rig(10_000, [OK], []);
      const r = await t.gw.complete(REQUEST);
      expect(r.ok).toBe(true);
      expect(meta(r)).toMatchObject({ outcome: "billed", reserved: RESERVE_4, charged: 160, alarms: [] });
      expect(await auditLedger(t.store)).toMatchObject({ available: 10_000 - 160, held: 0, charged: 160 });
    });

    it("تلاش دوباره روی همان مدل (۱ ناموفق + ۱ موفق): کفِ معلوم ۱۶۰ مصرف؛ release ⇒ باقیمانده برمی‌گردد + COST_UNKNOWN", async () => {
      const t = await rig(10_000, [UNAVAILABLE, OK], [], { onUnknownCost: "release" });
      const r = await t.gw.complete(REQUEST);
      expect(r.ok).toBe(true);
      expect(meta(r)).toMatchObject({ outcome: "released", charged: 160, alarms: ["COST_UNKNOWN"] });
      expect(await auditLedger(t.store)).toMatchObject({ available: 10_000 - 160, held: 0, forfeited: 0 });
    });

    it("همان با forfeit: ۱۶۰ مصرف و باقیماندهٔ رزرو سوخته؛ جمع = کل رزرو", async () => {
      const t = await rig(10_000, [UNAVAILABLE, OK], [], { onUnknownCost: "forfeit" });
      const r = await t.gw.complete(REQUEST);
      expect(meta(r)).toMatchObject({ outcome: "forfeited", charged: 160, alarms: ["COST_UNKNOWN"] });
      expect(await auditLedger(t.store)).toMatchObject({ available: 10_000 - RESERVE_4, charged: 160, forfeited: RESERVE_4 - 160 });
    });

    it("سقوط به مدل جایگزین (۲ شکست بر main، موفقیت بر alt): هزینهٔ alt (۲۷۰) با قیمت خودش مصرف می‌شود", async () => {
      const t = await rig(10_000, [UNAVAILABLE, UNAVAILABLE], [OK], { onUnknownCost: "release" });
      const r = await t.gw.complete(REQUEST);
      expect(r.ok).toBe(true);
      expect(meta(r)).toMatchObject({ outcome: "released", charged: 270 });
      expect(t.prov1.calls).toHaveLength(2);
      expect(t.prov2.calls).toHaveLength(1);
      expect(await auditLedger(t.store)).toMatchObject({ available: 10_000 - 270, charged: 270 });
    });

    it("شکست در همهٔ زنجیره (۴ تماس بی‌هزینهٔ معلوم): نامعلوم، کف ۰؛ forfeit ⇒ کل رزرو سوخته، release ⇒ هیچ", async () => {
      const f = await rig(10_000, [UNAVAILABLE, UNAVAILABLE], [UNAVAILABLE, UNAVAILABLE], { onUnknownCost: "forfeit" });
      const r = await f.gw.complete(REQUEST);
      expect(r.ok).toBe(false);
      expect(meta(r)).toMatchObject({ outcome: "forfeited", charged: 0, alarms: ["COST_UNKNOWN"] });
      expect(await auditLedger(f.store)).toMatchObject({ available: 10_000 - RESERVE_4, forfeited: RESERVE_4 });
      const g = await rig(10_000, [UNAVAILABLE, UNAVAILABLE], [UNAVAILABLE, UNAVAILABLE], { onUnknownCost: "release" });
      expect(meta(await g.gw.complete(REQUEST))).toMatchObject({ outcome: "released", charged: 0 });
      expect(await auditLedger(g.store)).toMatchObject({ available: 10_000, forfeited: 0 });
    });

    it("درخواستی که دروازهٔ واقعی رد می‌کند (temperature بیرون بازه): هیچ تماسی با ارائه‌دهنده، رزرو کامل آزاد، بی‌زنگ", async () => {
      const t = await rig(10_000, [OK], []);
      const r = await t.gw.complete({ ...REQUEST, temperature: 99 });
      expect(r.ok).toBe(false);
      expect(meta(r)).toMatchObject({ outcome: "released", charged: 0, alarms: [] });
      expect(t.prov1.calls).toHaveLength(0);
      expect(await auditLedger(t.store)).toMatchObject({ available: 10_000, held: 0, charged: 0 });
    });

    it("دو تماس پیاپی (مثل ترمیم کنترل‌شده، همان requestId): دو رزرو و دو تلاش جدا؛ مجموع دقیق", async () => {
      const t = await rig(10_000, [OK, OK], []);
      const a = await t.gw.complete({ ...REQUEST, requestId: "same-request" });
      const b = await t.gw.complete({ ...REQUEST, requestId: "same-request" });
      expect([meta(a).reservationId, meta(b).reservationId]).toEqual(["scope-1.r1", "scope-1.r2"]);
      expect(await auditLedger(t.store)).toMatchObject({ available: 10_000 - 320, charged: 320 });
      const state = await t.store.read(KEY);
      expect(Object.keys(state?.reservations ?? {}).sort()).toEqual(["scope-1.r1", "scope-1.r2"]);
    });

    it("اعتبار کمتر از بدترین‌حالت (۴ تماس): رد پیش از هر تماس، حتی اگر هزینهٔ واقعی ارزان می‌بود", async () => {
      const t = await rig(RESERVE_4 - 1, [OK], []);
      const r = await t.gw.complete(REQUEST);
      expect(meta(r).refusal?.code).toBe("INSUFFICIENT_CREDIT");
      expect(t.prov1.calls).toHaveLength(0);
      expect(await auditLedger(t.store)).toMatchObject({ available: RESERVE_4 - 1, held: 0 });
    });

    it("هم‌زمانی: ۳۰ تماس موازی روی موجودی ≈ ۱۰ رزرو؛ هیچ تماسِ بی‌رزرو، هیچ مصرفِ بیش از موجودی، ناوردا سالم", async () => {
      const opened = await open();
      cleanups.push(opened.dispose);
      const funds = WORST * 10 + 5;
      const f = await fundedLedger(funds, opened.store);
      const inner = fakeGateway(async () => {
        await new Promise((res) => setTimeout(res, 1));
        return okResult(160);
      });
      const made = createMeteredGateway(config(f.ledger, inner));
      if (!made.ok) throw new Error("config");
      const rs = await Promise.all(Array.from({ length: 30 }, () => made.value.complete(REQUEST)));
      const billed = rs.filter((r) => meta(r).outcome === "billed");
      const refused = rs.filter((r) => meta(r).outcome === "refused");
      expect(billed.length + refused.length).toBe(30);
      expect(billed.length).toBeGreaterThanOrEqual(10);
      expect(billed.length).toBeLessThanOrEqual(19);
      expect(refused.every((r) => meta(r).refusal?.code === "INSUFFICIENT_CREDIT")).toBe(true);
      expect(inner.calls).toHaveLength(billed.length); // هر تماس به دروازه یک رزروِ موفق پشت سرش دارد
      const a = await auditLedger(opened.store);
      expect(a).toMatchObject({ charged: billed.length * 160, held: 0, available: funds - billed.length * 160 });
      expect(new Set(rs.map((r) => meta(r).reservationId).filter((x) => x !== null)).size).toBe(billed.length);
    });
  });
}

suite("حافظه‌ای", describe, openMemory);
suite("PostgreSQL", dbDescribe, async () => {
  const t = await openPgStore();
  return { store: t.store, dispose: t.dispose };
});

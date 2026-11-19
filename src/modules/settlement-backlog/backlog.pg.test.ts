/**
 * settlement-backlog روی PostgreSQL واقعی (ADR-0039): همان `listUnacknowledgedDead`ِ آداپتورِ تولیدی. ثابت می‌کند نمونه‌گیری با ذخیرهٔ واقعی
 * (ترتیب، تأییدِ ماندگار، بریدنِ فهرست با LIMIT، «فرایندِ دیگر»، قطعِ پایگاه) همان معنایی را می‌دهد که مدلِ حافظه‌ای.
 */
import { afterEach, expect, it } from "vitest";
import type { DeadReason } from "@/modules/settlement";
import { REF, T0, manualClock, monitorOf } from "./test-kit";
import { dbDescribe, openBacklogPg } from "./test-db";
import type { TestBacklogPg } from "./test-db";

dbDescribe("settlement-backlog · PostgreSQL واقعی", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await (cleanups.pop() as () => Promise<void>)();
  });
  async function pg(): Promise<TestBacklogPg> {
    const t = await openBacklogPg();
    cleanups.push(t.dispose);
    return t;
  }

  it("outboxِ تازه ⇒ پسماندِ صفر و ok", async () => {
    const t = await pg();
    expect(await monitorOf({}, t.outbox).check()).toMatchObject({ status: "ok", count: 0, oldestAgeMs: null });
  });

  it("شمار، قدیمی‌ترین زمانِ مرگ و تفکیکِ دلیل با ذخیرهٔ واقعی دقیق است؛ تأیید ماندگار است و از پسماند کم می‌کند", async () => {
    const t = await pg();
    const plan: Array<[number, DeadReason, number]> = [
      [1, "ATTEMPTS_EXHAUSTED", T0 - 900],
      [2, "EXPIRED_UNBILLED", T0 - 5_000],
      [3, "LEDGER_REJECTED", T0 - 300],
      [4, "EXPIRED_UNBILLED", T0 - 700],
    ];
    for (const [n, reason, at] of plan) await bury(t, n, reason, at);
    const m = monitorOf({}, t.outbox, manualClock(T0));
    expect(await m.sample()).toMatchObject({ ok: true, count: 4, truncated: false, oldestDeadAtMs: T0 - 5_000, undated: 0, byReason: { EXPIRED_UNBILLED: 2, ATTEMPTS_EXHAUSTED: 1, LEDGER_REJECTED: 1 } });
    const h = await m.check();
    expect(h.reasons.map((r) => r.code)).toEqual(["COUNT_HIGH", "OLDEST_AGED"]); // سنِ ۵۰۰۰ دقیقاً روی مرزِ down است (اکیداً «>»)
    expect(h.oldestAgeMs).toBe(5_000);

    expect((await t.outbox.acknowledgeDead(REF(2), { atMs: T0 })).ok).toBe(true);
    expect(await m.sample()).toMatchObject({ count: 3, oldestDeadAtMs: T0 - 900, byReason: { EXPIRED_UNBILLED: 1, ATTEMPTS_EXHAUSTED: 1, LEDGER_REJECTED: 1 } });
    // تأیید ماندگار است: فرایندِ دیگر هم همان را می‌بیند.
    const other = t.another();
    cleanups.push(other.close);
    expect(await monitorOf({}, other.outbox, manualClock(T0)).sample()).toMatchObject({ count: 3 });
  });

  it("بریدنِ فهرست با LIMITِ واقعی: truncated=true، count=سقف و قدیمی‌ترین دقیق", async () => {
    const t = await pg();
    for (let i = 1; i <= 8; i++) await bury(t, i, "ATTEMPTS_EXHAUSTED", T0 - i * 100);
    const m = monitorOf({ sampleLimit: 5, downCount: 5 }, t.outbox, manualClock(T0));
    expect(await m.sample()).toMatchObject({ ok: true, count: 5, truncated: true, oldestDeadAtMs: T0 - 800 });
    expect((await m.check()).status).toBe("down");
  });

  it("قطعِ پایگاه ⇒ نمونهٔ LIST_FAILED و degraded؛ نه پرتاب و نه ok", async () => {
    const t = await pg();
    await bury(t, 1, "ATTEMPTS_EXHAUSTED", T0 - 10);
    const m = monitorOf({}, t.outbox, manualClock(T0));
    expect(await m.sample()).toMatchObject({ ok: true, count: 1 });
    await t.killPrimary();
    expect(await m.sample()).toEqual({ ok: false, atMs: T0, code: "LIST_FAILED" });
    expect(await m.check()).toMatchObject({ status: "degraded", failure: "LIST_FAILED", count: null });
  });

  it("فقط‌خواندنی: پس از نمونه‌گیری و ارزیابی، ردیف‌های outbox و تأییدها دست‌نخورده‌اند", async () => {
    const t = await pg();
    await bury(t, 1, "LEDGER_REJECTED", T0 - 10);
    await bury(t, 2, "EXPIRED_UNBILLED", T0 - 20);
    await t.outbox.acknowledgeDead(REF(2), { atMs: T0 });
    const snap = async () => JSON.stringify([await t.outbox.listDead({ limit: 10 }), await t.outbox.listUnacknowledgedDead({ limit: 10 }), await t.outbox.counts()]);
    const before = await snap();
    const m = monitorOf({}, t.outbox, manualClock(T0));
    await m.sample();
    await m.check();
    expect(await snap()).toBe(before);
  });
});

async function bury(t: TestBacklogPg, n: number, reason: DeadReason, atMs: number): Promise<void> {
  const b = await t.outbox.begin({ ...REF(n), unit: "IRR_MICROS", reserved: 500, createdAtMs: 1_000, expiresAtMs: 61_000, dueAtMs: 11_000, orphanRemainder: "forfeit" });
  if (!b.ok) throw new Error(`begin: ${b.error.code}`);
  const d = await t.outbox.bury(REF(n), { reason, errorCode: null, atMs });
  if (!d.ok) throw new Error(`bury: ${d.error.code}`);
}

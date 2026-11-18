/**
 * هم‌زمانیِ واقعی روی PostgreSQL (ADR-0022): چند «فرایند» مستقل = چند استخرِ اتصالِ جدا روی یک شِما. قفلِ ردیف باید همهٔ تصمیم‌ها را سریال کند:
 * بی‌به‌روزرسانیِ گمشده، بی‌دو برنده، بی‌بن‌بست، و شرطِ مسابقهٔ رفتگر/درون‌خطی (ADR-0021 تصمیم ۳) که تنها با اتمی‌بودن بسته می‌شود.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { OutboxEntry, OutboxResult, ReservationRef, SettlementOutbox } from "../types";
import { dbDescribe, openPgOutbox, type TestOutbox } from "./test-db";

const REF = (id: string): ReservationRef => ({ tenantId: "t1", accountId: "a1", reservationId: id });
const BEGIN = (id: string, over: Record<string, unknown> = {}) => ({ ...REF(id), unit: "IRR_MICROS", reserved: 500, createdAtMs: 1_000, expiresAtMs: 61_000, dueAtMs: 11_000, orphanRemainder: "forfeit" as const, ...over });
const code = (r: OutboxResult<unknown>): string => (r.ok ? "ok" : r.error.code);
const must = <T>(r: OutboxResult<T>): T => {
  if (!r.ok) throw new Error(`انتظار موفقیت بود: ${r.error.code}`);
  return r.value;
};

dbDescribe("settlement/pg · هم‌زمانیِ چندفرایندی", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await (cleanups.pop() as () => Promise<void>)();
  });
  /** `n` «فرایند» (هر کدام استخرِ جدا) روی یک شِمای تازه. */
  async function processes(n: number): Promise<{ t: TestOutbox; procs: SettlementOutbox[] }> {
    const t = await openPgOutbox(4);
    cleanups.push(t.dispose);
    const procs: SettlementOutbox[] = [t.outbox];
    for (let i = 1; i < n; i++) {
      const r = await t.reopen();
      cleanups.push(r.close);
      procs.push(r.outbox);
    }
    return { t, procs };
  }

  it("۸ فرایند هم‌زمان begin یکسان ⇒ دقیقاً یکی replayed=false و یک ردیف", async () => {
    const { procs } = await processes(8);
    const rs = await Promise.all(procs.flatMap((p) => [p.begin(BEGIN("r1")), p.begin(BEGIN("r1"))]));
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(rs.filter((r) => r.ok && !r.value.replayed)).toHaveLength(1);
    expect(must(await (procs[0] as SettlementOutbox).counts())).toEqual({ open: 1, settling: 0, done: 0, dead: 0 });
  });

  it("begin هم‌زمانِ محتوای ناسازگار ⇒ یک برنده؛ بقیه CONFLICT (یا replayed برای هم‌محتوا)", async () => {
    const { procs } = await processes(6);
    const rs = await Promise.all(procs.map((p, i) => p.begin(BEGIN("r1", { reserved: 500 + (i % 2) }))));
    const winners = rs.filter((r) => r.ok && !r.value.replayed).length;
    expect(winners).toBe(1);
    expect(rs.every((r) => code(r) === "ok" || code(r) === "CONFLICT")).toBe(true);
    const e = must(await (procs[0] as SettlementOutbox).get(REF("r1"))) as OutboxEntry;
    expect([500, 501]).toContain(e.reserved);
  });

  it("۱۲ recordCharge با شناسهٔ متفاوت ⇒ یک برنده، بقیه CONFLICT؛ مصرفِ نهایی همان برنده است", async () => {
    const { procs } = await processes(6);
    await (procs[0] as SettlementOutbox).begin(BEGIN("r1"));
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => (procs[i % 6] as SettlementOutbox).recordCharge(REF("r1"), { attemptId: `a${i}`, amount: 10 + i })));
    const okIdx = rs.map((r, i) => (r.ok ? i : -1)).filter((i) => i >= 0);
    expect(okIdx).toHaveLength(1);
    expect(rs.filter((r) => code(r) === "CONFLICT")).toHaveLength(11);
    const e = must(await (procs[0] as SettlementOutbox).get(REF("r1"))) as OutboxEntry;
    expect(e.charge).toEqual({ attemptId: `a${okIdx[0]}`, amount: 10 + (okIdx[0] as number) });
    expect(e.state).toBe("settling");
  });

  it("۲۵ recordFailure هم‌زمان ⇒ attempts دقیقاً ۲۵ (بی‌به‌روزرسانیِ گمشده)؛ شمارش‌ها همه یکتا و پیوسته", async () => {
    const { procs } = await processes(5);
    await (procs[0] as SettlementOutbox).begin(BEGIN("r1"));
    const rs = await Promise.all(Array.from({ length: 25 }, (_, i) => (procs[i % 5] as SettlementOutbox).recordFailure(REF("r1"), { errorCode: "STORE_FAILURE", dueAtMs: 20_000 + i })));
    const attempts = rs.map((r) => must(r).attempts).sort((a, b) => a - b);
    expect(attempts).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect((must(await (procs[0] as SettlementOutbox).get(REF("r1"))) as OutboxEntry).attempts).toBe(25);
  });

  it("مسابقهٔ رفتگر/درون‌خطی (۶۰ دور، فرایندهای جدا): هرگز «مصرفِ ثبت‌شده + سوخت» نمی‌شود؛ نتیجهٔ هر دو سو با رکورد هم‌خوان است", async () => {
    const { procs } = await processes(2);
    const [inline, sweeper] = procs as [SettlementOutbox, SettlementOutbox];
    let chargeWon = 0;
    let sweeperWon = 0;
    for (let i = 0; i < 60; i++) {
      const id = `race${i}`;
      await inline.begin(BEGIN(id, { orphanRemainder: "forfeit" }));
      const [c, r] = await Promise.all([inline.recordCharge(REF(id), { attemptId: "a1", amount: 100 }), sweeper.resolveClose(REF(id))]);
      const e = must(await inline.get(REF(id))) as OutboxEntry;
      expect(e.close, `دور ${i}`).not.toBeNull();
      expect(e.close?.origin).toBe("sweeper");
      if (code(c) === "ok") {
        chargeWon += 1;
        expect(e.charge).toEqual({ attemptId: "a1", amount: 100 });
        expect(e.close?.remainder, `دور ${i}: با مصرفِ ثبت‌شده فقط release`).toBe("release");
      } else {
        sweeperWon += 1;
        expect(code(c)).toBe("CONFLICT");
        expect(e.charge).toBeNull();
        expect(e.close?.remainder).toBe("forfeit");
      }
      expect(must(r).close).toEqual(e.close); // رفتگر همان را دید که ماند
    }
    expect(chargeWon + sweeperWon).toBe(60);
  });

  it("مسابقهٔ recordClose(درون‌خطی) با resolveClose(رفتگر): همیشه یک قصدِ بستن؛ بازنده یا replayed (هم‌باقیمانده) یا CONFLICT", async () => {
    const { procs } = await processes(2);
    const [a, b] = procs as [SettlementOutbox, SettlementOutbox];
    for (let i = 0; i < 30; i++) {
      const id = `cl${i}`;
      await a.begin(BEGIN(id, { orphanRemainder: i % 2 === 0 ? "forfeit" : "release" }));
      const [c, r] = await Promise.all([a.recordClose(REF(id), { remainder: "release", origin: "caller" }), b.resolveClose(REF(id))]);
      const e = must(await a.get(REF(id))) as OutboxEntry;
      expect(e.close).not.toBeNull();
      expect(must(r).close).toEqual(e.close);
      if (code(c) === "ok") expect(c.ok && c.value.replayed ? e.close?.origin === "sweeper" : e.close?.origin === "caller").toBe(true);
      else expect(code(c)).toBe("CONFLICT");
    }
  });

  it("finish هم‌زمان ⇒ یک برنده؛ bury در برابر finish ⇒ دقیقاً یکی برنده و حالتِ نهایی هم‌خوان", async () => {
    const { procs } = await processes(4);
    const o = procs[0] as SettlementOutbox;
    await o.begin(BEGIN("f1"));
    await o.recordClose(REF("f1"), { remainder: "release", origin: "caller" });
    const fs = await Promise.all(procs.flatMap((p) => [p.finish(REF("f1"), 5), p.finish(REF("f1"), 5)]));
    expect(fs.every((r) => r.ok)).toBe(true);
    expect(fs.filter((r) => r.ok && !r.value.replayed)).toHaveLength(1);

    for (let i = 0; i < 20; i++) {
      const id = `fb${i}`;
      await o.begin(BEGIN(id));
      await o.recordClose(REF(id), { remainder: "release", origin: "caller" });
      const [f, b] = await Promise.all([(procs[1] as SettlementOutbox).finish(REF(id), 9), (procs[2] as SettlementOutbox).bury(REF(id), { reason: "LEDGER_REJECTED", errorCode: null, atMs: 9 })]);
      const e = must(await o.get(REF(id))) as OutboxEntry;
      expect([code(f), code(b)].filter((c) => c === "ok")).toHaveLength(1);
      expect(e.state).toBe(code(f) === "ok" ? "done" : "dead");
      expect(code(f) === "ok" ? code(b) : code(f)).toBe("NOT_ACTIVE");
    }
  });

  it("۱۰۰ begin موازی روی شناسه‌های متفاوت + صفحه‌بندیِ listDue: همه می‌آیند، ترتیب قطعی و بی‌تکرار", async () => {
    const { procs } = await processes(5);
    const ids = Array.from({ length: 100 }, (_, i) => `r${String(i).padStart(3, "0")}`);
    const rs = await Promise.all(ids.map((id, i) => (procs[i % 5] as SettlementOutbox).begin(BEGIN(id, { dueAtMs: 1_000 + (i % 7) }))));
    expect(rs.every((r) => r.ok && !r.value.replayed)).toBe(true);
    const o = procs[0] as SettlementOutbox;
    expect(must(await o.counts()).open).toBe(100);
    const all = must(await o.listDue({ nowMs: 5_000, limit: 1000 }));
    expect(all).toHaveLength(100);
    expect(all.map((e) => [e.dueAtMs, e.reservationId])).toEqual([...all.map((e) => [e.dueAtMs, e.reservationId] as [number, string])].sort((x, y) => x[0] - y[0] || (x[1] < y[1] ? -1 : 1)));
    expect(must(await o.listDue({ nowMs: 5_000, limit: 10 })).map((e) => e.reservationId)).toEqual(all.slice(0, 10).map((e) => e.reservationId));
    expect(must(await o.listDue({ nowMs: 1_002, limit: 1000 })).every((e) => e.dueAtMs <= 1_002)).toBe(true);
  });

  it("بی‌بن‌بست: عملیاتِ آمیختهٔ تصادفی روی ۵ رکورد از ۶ فرایند (۳۶۰ عملیات) در مهلتِ کوتاه تمام می‌شود و ناوردا برقرار است", async () => {
    const { procs } = await processes(6);
    const o = procs[0] as SettlementOutbox;
    for (let r = 0; r < 5; r++) await o.begin(BEGIN(`d${r}`));
    let seed = 12345;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
    const ops: Array<Promise<OutboxResult<unknown>>> = [];
    for (let i = 0; i < 360; i++) {
      const p = procs[rnd(6)] as SettlementOutbox;
      const ref = REF(`d${rnd(5)}`);
      switch (rnd(7)) {
        case 0: ops.push(p.recordCharge(ref, { attemptId: "a1", amount: 5 })); break;
        case 1: ops.push(p.recordClose(ref, { remainder: rnd(2) === 0 ? "release" : "forfeit", origin: "caller" })); break;
        case 2: ops.push(p.resolveClose(ref)); break;
        case 3: ops.push(p.finish(ref, 9)); break;
        case 4: ops.push(p.recordFailure(ref, { errorCode: "STORE_FAILURE", dueAtMs: 50 })); break;
        case 5: ops.push(p.bury(ref, { reason: "ATTEMPTS_EXHAUSTED", errorCode: null, atMs: 9 })); break;
        default: ops.push(p.listDue({ nowMs: 1_000_000, limit: 50 }));
      }
    }
    const res = await Promise.all(ops);
    expect(res.every((r) => r.ok || ["CONFLICT", "NOT_ACTIVE", "NOT_FOUND"].includes(code(r)))).toBe(true);
    expect(res.some((r) => code(r) === "STORE_FAILURE")).toBe(false);
    for (let r = 0; r < 5; r++) {
      const e = must(await o.get(REF(`d${r}`))) as OutboxEntry;
      if (e.state === "done") expect(e.close).not.toBeNull();
      if (e.state === "dead") expect(e.deadReason).toBe("ATTEMPTS_EXHAUSTED");
      if (e.charge !== null && e.close?.origin === "sweeper") expect(e.close.remainder).toBe("release");
      if (e.state === "open") expect(e.charge === null && e.close === null).toBe(true);
    }
  }, 60_000);

  it("قفل فقط همان ردیف را می‌گیرد: نوشتن روی رکورد A به نوشتن روی رکورد B وابسته نیست (تراکنشِ باز روی A، B بی‌انتظار)", async () => {
    const { t, procs } = await processes(2);
    const [x, y] = procs as [SettlementOutbox, SettlementOutbox];
    await x.begin(BEGIN("A"));
    await x.begin(BEGIN("B"));
    let release!: () => void;
    const held = t.session(async (q) => {
      await q("SELECT 1 FROM {{s}}.settlement_outbox WHERE reservation_id = 'A' FOR UPDATE");
      await new Promise<void>((res) => {
        release = res;
      });
    });
    await new Promise((res) => setTimeout(res, 100)); // قفلِ A گرفته شد
    const onB = await y.recordCharge(REF("B"), { attemptId: "a1", amount: 1 });
    expect(onB).toEqual({ ok: true, value: { replayed: false } });
    let aDone = false;
    const onA = y.recordCharge(REF("A"), { attemptId: "a1", amount: 1 }).then((r) => ((aDone = true), r));
    await new Promise((res) => setTimeout(res, 150));
    expect(aDone, "نوشتن روی A باید پشتِ قفل بماند").toBe(false);
    release();
    await held;
    expect(await onA).toEqual({ ok: true, value: { replayed: false } });
  });
});

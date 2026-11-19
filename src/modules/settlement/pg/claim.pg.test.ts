/**
 * اجارهٔ رکوردهای سررسیده روی PostgreSQL واقعی (ADR-0029):
 *  ۱) همان قراردادِ مشترکِ outbox حافظه‌ای، بی‌تغییر؛
 *  ۲) هم‌زمانیِ واقعی: چند «فرایند» (استخرِ جدا) هم‌زمان می‌گیرند ⇒ هر رکورد دقیقاً یک‌بار، بی‌بن‌بست؛
 *  ۳) `SKIP LOCKED`: ردیفِ قفل‌شده توسط تراکنشِ دیگر منتظر نمی‌ماند و رد می‌شود؛
 *  ۴) رقابت با bury/recordFailure/نوشتنِ درون‌خطی: هرگز خطا، هرگز رکوردِ مرده‌ای گرفته نمی‌شود؛
 *  ۵) ماندگاری: اجاره از ریستارت جان به در می‌برد؛ بی‌مهاجرتِ تازه؛ نقشهٔ اجرا از ایندکسِ جزئی می‌خواند؛
 *  ۶) آزمون تفاضلی: همان دنبالهٔ تصادفی روی حافظه‌ای و PostgreSQL نتایج و وضعیتِ یکسان بدهد.
 */
import { afterEach, describe, expect, it } from "vitest";
import { describeClaimContract } from "../contract/claim-contract";
import { createMemoryOutbox } from "../memory-outbox";
import type { DueClaimer, OutboxEntry, OutboxResult, ReservationRef, SettlementOutbox } from "../types";
import { MIGRATIONS } from "./migrations";
import { dbDescribe, openPgOutbox, type TestOutbox } from "./test-db";

dbDescribe("settlement/pg · اجاره (claimDue)", () => {
  describeClaimContract("postgres", async () => {
    const t = await openPgOutbox(6);
    return { outbox: t.outbox, dispose: t.dispose };
  });
});

const must = <T>(r: OutboxResult<T>): T => {
  if (!r.ok) throw new Error(`انتظار موفقیت بود: ${r.error.code}`);
  return r.value;
};
const REF = (id: string): ReservationRef => ({ tenantId: "t1", accountId: "a1", reservationId: id });
const BEGIN = (id: string, dueAtMs = 1_000) => ({ ...REF(id), unit: "IRR_MICROS", reserved: 500, createdAtMs: 1_000, expiresAtMs: 61_000, dueAtMs, orphanRemainder: "forfeit" as const });
const entry = async (o: SettlementOutbox, id: string): Promise<OutboxEntry> => {
  const e = must(await o.get(REF(id)));
  if (e === null) throw new Error("رکورد باید وجود می‌داشت");
  return e;
};
type Claimer = SettlementOutbox & DueClaimer;

dbDescribe("settlement/pg · اجاره (claimDue) · هم‌زمانیِ چندفرایندی", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await (cleanups.pop() as () => Promise<void>)();
  });
  async function processes(n: number): Promise<{ t: TestOutbox; procs: Claimer[] }> {
    const t = await openPgOutbox(4);
    cleanups.push(t.dispose);
    const procs: Claimer[] = [t.outbox];
    for (let i = 1; i < n; i++) {
      const r = await t.reopen();
      cleanups.push(r.close);
      procs.push(r.outbox);
    }
    return { t, procs };
  }

  it("۶ فرایندِ هم‌زمان روی ۶۰ رکورد (limit=۷): اجتماعِ گرفته‌ها = همهٔ رکوردها، بی‌اشتراک (هر رکورد دقیقاً یک‌بار)", async () => {
    const { procs } = await processes(6);
    const p0 = procs[0] as Claimer;
    for (let i = 0; i < 60; i++) must(await p0.begin(BEGIN(`r${String(i).padStart(2, "0")}`, 1_000 + i)));
    const seen: string[] = [];
    for (let round = 0; round < 12; round++) {
      const got = await Promise.all(procs.map((p) => p.claimDue({ nowMs: 100_000, limit: 7, leaseMs: 60_000 })));
      const flat = got.flatMap((g) => must(g));
      for (const e of flat) {
        expect(e.dueAtMs).toBe(160_000);
        seen.push(e.reservationId);
      }
      if (flat.length === 0) break;
    }
    expect(seen).toHaveLength(60);
    expect(new Set(seen).size).toBe(60);
    expect(must(await p0.listDue({ nowMs: 100_000, limit: 1000 }))).toEqual([]);
    expect(must(await p0.listDue({ nowMs: 160_000, limit: 1000 }))).toHaveLength(60);
  });

  it("۶ فرایندِ هم‌زمان با limit=۱۰۰۰ روی ۲۰ رکورد: مجموعاً ۲۰ (نه ۲۰×۶)؛ هر گذر سهمِ جدا و ناهم‌پوشان", async () => {
    const { procs } = await processes(6);
    const p0 = procs[0] as Claimer;
    for (let i = 0; i < 20; i++) must(await p0.begin(BEGIN(`q${i}`, 500 + i)));
    const got = (await Promise.all(procs.map((p) => p.claimDue({ nowMs: 5_000, limit: 1000, leaseMs: 10_000 })))).map(must);
    const all = got.flat().map((e) => e.reservationId);
    expect(all).toHaveLength(20);
    expect(new Set(all).size).toBe(20);
    // هر پاسخ به ترتیبِ (سررسید، شناسه) است.
    for (const g of got) {
      const keys = g.map((e) => e.reservationId);
      const sorted = [...keys].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
      expect(keys).toEqual(sorted);
    }
  });

  it("SKIP LOCKED: ردیفی که تراکنشِ دیگری قفل کرده منتظر نمی‌ماند؛ بقیه گرفته می‌شوند و پس از آزادشدنِ قفل، همان ردیف هم", async () => {
    const t = await openPgOutbox(4);
    cleanups.push(t.dispose);
    for (const id of ["a", "b", "c"]) must(await t.outbox.begin(BEGIN(id, 1_000)));
    let during: readonly OutboxEntry[] = [];
    let blocked = false;
    await t.session(async (query) => {
      await query("SELECT 1 FROM {{s}}.settlement_outbox WHERE reservation_id = 'b' FOR UPDATE");
      const timer = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 4_000));
      const claim = t.outbox.claimDue({ nowMs: 10_000, limit: 10, leaseMs: 30_000 });
      const first = await Promise.race([claim, timer]);
      if (first === "timeout") blocked = true;
      else during = must(first);
    });
    expect(blocked).toBe(false);
    expect(during.map((e) => e.reservationId)).toEqual(["a", "c"]);
    expect((await entry(t.outbox, "b")).dueAtMs).toBe(1_000);
    expect(must(await t.outbox.claimDue({ nowMs: 10_000, limit: 10, leaseMs: 30_000 })).map((e) => e.reservationId)).toEqual(["b"]);
  }, 30_000);

  it("نوشتنِ درون‌خطیِ در حال انجام (قفلِ ردیف) رفتگر را نمی‌بندد و رفتگر نوشتنِ درون‌خطی را نمی‌بندد (بی‌بن‌بست)", async () => {
    const { procs } = await processes(3);
    const [a, b, c] = procs as [Claimer, Claimer, Claimer];
    for (let i = 0; i < 30; i++) must(await a.begin(BEGIN(`w${i}`, 100 + i)));
    const work: Promise<unknown>[] = [];
    for (let i = 0; i < 30; i++) {
      work.push(b.recordCharge(REF(`w${i}`), { attemptId: "x1", amount: 5 }));
      work.push(c.claimDue({ nowMs: 10_000, limit: 5, leaseMs: 20_000 }));
      work.push(a.recordFailure(REF(`w${i}`), { errorCode: "STORE_FAILURE", dueAtMs: 50_000 + i }));
    }
    const rs = (await Promise.all(work)) as OutboxResult<unknown>[];
    for (const r of rs) expect(r.ok, JSON.stringify(r)).toBe(true);
    for (let i = 0; i < 30; i++) expect(await entry(a, `w${i}`)).toMatchObject({ state: "settling", attempts: 1 });
  });

  it("رقابتِ گرفتن با bury (۴۰ دور): گرفتن هرگز خطا نمی‌دهد و رکوردِ مرده هرگز گرفته/دست‌کاری نمی‌شود", async () => {
    const { procs } = await processes(2);
    const [a, b] = procs as [Claimer, Claimer];
    let claimedFirst = 0;
    let buriedFirst = 0;
    for (let i = 0; i < 40; i++) {
      must(await a.begin(BEGIN(`d${i}`, 1_000)));
      const [cl, bu] = await Promise.all([a.claimDue({ nowMs: 9_000, limit: 5, leaseMs: 50_000 }), b.bury(REF(`d${i}`), { reason: "ATTEMPTS_EXHAUSTED", errorCode: "STORE_FAILURE", atMs: 9_500 })]);
      expect(bu.ok).toBe(true);
      const got = must(cl);
      const e = await entry(a, `d${i}`);
      expect(e.state).toBe("dead");
      if (got.length === 1) {
        claimedFirst += 1;
        expect(e.dueAtMs).toBe(59_000);
      } else {
        buriedFirst += 1;
        expect(got).toEqual([]);
        expect(e.dueAtMs).toBe(1_000);
      }
    }
    expect(claimedFirst + buriedFirst).toBe(40);
  });

  it("رقابتِ دو گرفتنِ هم‌زمان و recordFailure با CAS: شمارنده فقط +۱؛ عکسِ گرفته‌شده برای CAS معتبر است", async () => {
    const { procs } = await processes(4);
    const p0 = procs[0] as Claimer;
    must(await p0.begin(BEGIN("c1", 1_000)));
    const claims = (await Promise.all(procs.map((p) => p.claimDue({ nowMs: 9_000, limit: 5, leaseMs: 30_000 })))).map(must);
    const owner = claims.findIndex((g) => g.length === 1);
    expect(claims.filter((g) => g.length === 1)).toHaveLength(1);
    const snap = (claims[owner] as readonly OutboxEntry[])[0] as OutboxEntry;
    const rs = (await Promise.all(procs.map((p) => p.recordFailure(REF("c1"), { errorCode: "STORE_FAILURE", dueAtMs: 20_000, expectedAttempts: snap.attempts })))).map(must);
    expect(rs.filter((r) => r.replayed === false)).toHaveLength(1);
    expect((await entry(p0, "c1")).attempts).toBe(1);
  });

  it("ماندگاری: اجاره از ریستارت جان به در می‌برد (استخرِ تازه هم رکوردِ اجاره‌شده را نمی‌گیرد) و پس از پایانِ اجاره می‌گیرد", async () => {
    const t = await openPgOutbox(4);
    cleanups.push(t.dispose);
    must(await t.outbox.begin(BEGIN("p1", 1_000)));
    must(await t.outbox.claimDue({ nowMs: 10_000, limit: 5, leaseMs: 30_000 }));
    await t.kill();
    const again = await t.reopen();
    cleanups.push(again.close);
    expect(must(await again.outbox.claimDue({ nowMs: 39_999, limit: 5, leaseMs: 30_000 }))).toEqual([]);
    expect(must(await again.outbox.listDue({ nowMs: 39_999, limit: 5 }))).toEqual([]);
    expect(must(await again.outbox.claimDue({ nowMs: 40_000, limit: 5, leaseMs: 30_000 })).map((e) => e.reservationId)).toEqual(["p1"]);
  });

  it("بی‌مهاجرتِ تازه: همان مهاجرت‌های موجود؛ ستونی اضافه نشده و TRIGGER ناوردای «شمارنده کم نمی‌شود» همچنان برقرار است", async () => {
    expect(MIGRATIONS.map((m) => m.name)).toEqual(["0001_init", "0002_dead_ack"]);
    const t = await openPgOutbox(2);
    cleanups.push(t.dispose);
    const cols = await t.raw("SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'settlement_outbox' ORDER BY ordinal_position", [t.schema]);
    expect(cols.map((c) => c["column_name"])).toEqual([
      "tenant_id", "account_id", "reservation_id", "unit", "reserved", "created_at_ms", "expires_at_ms", "due_at_ms", "orphan_remainder", "state",
      "charge_attempt_id", "charge_amount", "close_remainder", "close_origin", "attempts", "last_error_code", "dead_reason", "settled_at_ms",
    ]);
    must(await t.outbox.begin(BEGIN("m1", 1_000)));
    must(await t.outbox.recordFailure(REF("m1"), { errorCode: "STORE_FAILURE", dueAtMs: 2_000 }));
    must(await t.outbox.claimDue({ nowMs: 5_000, limit: 5, leaseMs: 100 }));
    expect((await entry(t.outbox, "m1")).attempts).toBe(1);
  });

  it("رکوردِ نهایی (done/dead) حتی با سررسیدِ گذشته هرگز گرفته نمی‌شود و TRIGGERِ نهایی‌بودن دست‌نخورده می‌ماند", async () => {
    const t = await openPgOutbox(2);
    cleanups.push(t.dispose);
    must(await t.outbox.begin(BEGIN("f1", 1)));
    must(await t.outbox.begin(BEGIN("f2", 1)));
    must(await t.outbox.recordClose(REF("f1"), { remainder: "release", origin: "caller" }));
    must(await t.outbox.finish(REF("f1"), 5));
    must(await t.outbox.bury(REF("f2"), { reason: "LEDGER_REJECTED", errorCode: null, atMs: 5 }));
    expect(must(await t.outbox.claimDue({ nowMs: 100, limit: 10, leaseMs: 10 }))).toEqual([]);
    expect(await t.raw("SELECT due_at_ms FROM {{s}}.settlement_outbox ORDER BY reservation_id")).toEqual([{ due_at_ms: "1" }, { due_at_ms: "1" }]);
  });

  it("نقشهٔ اجرا: انتخابِ رکوردها از ایندکسِ جزئیِ سررسید می‌خواند و مرتب‌سازیِ جداگانه ندارد (مقیاس‌پذیر)", async () => {
    const t = await openPgOutbox(2);
    cleanups.push(t.dispose);
    for (let i = 0; i < 300; i++) must(await t.outbox.begin(BEGIN(`x${i}`, 1_000 + i)));
    const plan = await t.session(async (query) => {
      await query("ANALYZE {{s}}.settlement_outbox");
      await query("SET LOCAL enable_seqscan = off");
      await query("SET LOCAL enable_bitmapscan = off");
      const rows = await query(`EXPLAIN SELECT tenant_id, account_id, reservation_id, due_at_ms FROM {{s}}.settlement_outbox
        WHERE state IN ('open', 'settling') AND due_at_ms <= 5000
        ORDER BY due_at_ms, tenant_id, account_id, reservation_id LIMIT 10 FOR UPDATE SKIP LOCKED`);
      return rows.map((r) => String(r["QUERY PLAN"])).join("\n");
    });
    expect(plan).toContain("settlement_outbox_due_idx");
    expect(plan).not.toMatch(/\bSort\b/);
  });
});

dbDescribe("settlement/pg · اجاره (claimDue) · تفاضلی (حافظه‌ای در برابر PostgreSQL)", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await (cleanups.pop() as () => Promise<void>)();
  });
  function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let x = a;
      x = Math.imul(x ^ (x >>> 15), x | 1);
      x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }
  const IDS = ["a", "B", "c.1", "d", "E2", "f"];

  it.each(Array.from({ length: 16 }, (_, i) => [i + 1]))("بذر %i: ۷۰ گامِ تصادفی (begin/claimDue/listDue/recordFailure/finish/bury) نتیجه و وضعیتِ یکسان", async (seed) => {
    const t = await openPgOutbox(3);
    cleanups.push(t.dispose);
    const mem = createMemoryOutbox();
    const r = rng(seed * 104_729);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
    let now = 1_000;
    const kinds = new Set<string>();
    for (let step = 0; step < 70; step++) {
      now += Math.floor(r() * 3_000);
      const id = pick(IDS);
      const w = r();
      let a: unknown;
      let b: unknown;
      if (w < 0.2) {
        const input = BEGIN(id, Math.max(0, now - 1_500 + Math.floor(r() * 4_000)));
        a = await mem.begin(input);
        b = await t.outbox.begin(input);
      } else if (w < 0.55) {
        const q = { nowMs: now, limit: 1 + Math.floor(r() * 4), leaseMs: 1 + Math.floor(r() * 6_000) };
        a = await mem.claimDue(q);
        b = await t.outbox.claimDue(q);
        kinds.add(`claim:${(a as { value?: unknown[] }).value?.length ?? "err"}`);
      } else if (w < 0.65) {
        const q = { nowMs: now, limit: 1 + Math.floor(r() * 6) };
        a = await mem.listDue(q);
        b = await t.outbox.listDue(q);
      } else if (w < 0.85) {
        const input = { errorCode: "STORE_FAILURE", dueAtMs: now + Math.floor(r() * 4_000) };
        a = await mem.recordFailure(REF(id), input);
        b = await t.outbox.recordFailure(REF(id), input);
      } else if (w < 0.93) {
        await mem.recordClose(REF(id), { remainder: "release", origin: "caller" });
        await t.outbox.recordClose(REF(id), { remainder: "release", origin: "caller" });
        a = await mem.finish(REF(id), now);
        b = await t.outbox.finish(REF(id), now);
      } else {
        const burial = { reason: "LEDGER_REJECTED" as const, errorCode: null, atMs: now };
        a = await mem.bury(REF(id), burial);
        b = await t.outbox.bury(REF(id), burial);
      }
      expect(b, `بذر ${seed} گام ${step}`).toEqual(a);
      if (step % 10 === 9) for (const k of IDS) expect(await entry(t.outbox, k).catch(() => null), `بذر ${seed} گام ${step} رکورد ${k}`).toEqual(await entry(mem, k).catch(() => null));
    }
    expect(kinds.size).toBeGreaterThanOrEqual(1);
  }, 60_000);
});

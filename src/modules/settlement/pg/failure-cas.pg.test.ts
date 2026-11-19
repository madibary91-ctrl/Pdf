/**
 * ثبتِ شکستِ تکرارپذیر روی PostgreSQL واقعی (ADR-0028):
 *  ۱) همان قراردادِ مشترکِ outbox حافظه‌ای، بی‌تغییر؛
 *  ۲) هم‌زمانیِ واقعی: چند «فرایند» (استخرِ جدا) با همان عکس ⇒ دقیقاً یک برنده، شمارنده n+1 (نه n+k)؛
 *  ۳) ماندگاری: نتیجهٔ ثبت از ریستارت جان به در می‌برد و تکرارِ پس از ریستارت `replayed` است؛
 *  ۴) بی‌مهاجرتِ تازه: همان مهاجرت‌های موجود، و مسیرِ بی‌expectedAttempts هنوز می‌شمارد (۲۵ هم‌زمان ⇒ ۲۵)؛
 *  ۵) آزمون تفاضلی: همان دنبالهٔ تصادفی روی حافظه‌ای و PostgreSQL نتایج و وضعیتِ یکسان بدهد.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { describeFailureCasContract } from "../contract/failure-cas-contract";
import { createMemoryOutbox } from "../memory-outbox";
import type { OutboxEntry, OutboxResult, ReservationRef, SettlementOutbox } from "../types";
import { MIGRATIONS } from "./migrations";
import { dbDescribe, openPgOutbox, type TestOutbox } from "./test-db";

dbDescribe("settlement/pg · ثبتِ شکستِ تکرارپذیر", () => {
  describeFailureCasContract("postgres", async () => {
    const t = await openPgOutbox(6);
    return { outbox: t.outbox, dispose: t.dispose };
  });
});

const must = <T>(r: OutboxResult<T>): T => {
  if (!r.ok) throw new Error(`انتظار موفقیت بود: ${r.error.code}`);
  return r.value;
};
const REF = (id: string): ReservationRef => ({ tenantId: "t1", accountId: "a1", reservationId: id });
const BEGIN = (id: string) => ({ ...REF(id), unit: "IRR_MICROS", reserved: 500, createdAtMs: 1_000, expiresAtMs: 61_000, dueAtMs: 11_000, orphanRemainder: "forfeit" as const });
const entry = async (o: SettlementOutbox, id: string): Promise<OutboxEntry> => {
  const e = must(await o.get(REF(id)));
  if (e === null) throw new Error("رکورد باید وجود می‌داشت");
  return e;
};

dbDescribe("settlement/pg · ثبتِ شکستِ تکرارپذیر · هم‌زمانیِ چندفرایندی", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await (cleanups.pop() as () => Promise<void>)();
  });
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

  it("۳۰ فراخوانِ هم‌زمان از ۶ فرایند با همان expectedAttempts ⇒ دقیقاً یک برنده، attempts نهایی n+1؛ سررسید و کد از همان برنده", async () => {
    const { procs } = await processes(6);
    const p0 = procs[0] as SettlementOutbox;
    must(await p0.begin(BEGIN("r1")));
    for (let i = 0; i < 2; i++) must(await p0.recordFailure(REF("r1"), { errorCode: "STORE_FAILURE", dueAtMs: 100 + i, expectedAttempts: i }));
    const rs = (await Promise.all(Array.from({ length: 30 }, (_, i) => (procs[i % 6] as SettlementOutbox).recordFailure(REF("r1"), { errorCode: i % 2 === 0 ? "STORE_FAILURE" : "INTERNAL_ERROR", dueAtMs: 10_000 + i, expectedAttempts: 2 })))).map(must);
    expect(rs.filter((r) => r.replayed === false)).toHaveLength(1);
    expect(rs.filter((r) => r.replayed === true)).toHaveLength(29);
    expect(rs.every((r) => r.attempts === 3)).toBe(true);
    const e = await entry(p0, "r1");
    expect(e.attempts).toBe(3);
    // دقیقاً یکی از فراخوان‌ها نوشته است: (سررسید ↔ کد) جفتِ همان فراخوان است، نه مخلوط.
    const i = e.dueAtMs - 10_000;
    expect(e.lastErrorCode).toBe(i % 2 === 0 ? "STORE_FAILURE" : "INTERNAL_ERROR");
  });

  it("۱۰ رکورد × ۶ فراخوانِ هم‌زمان (شکستِ منطقیِ یکسان) ⇒ هر رکورد دقیقاً +۱؛ بی‌بن‌بست", async () => {
    const { procs } = await processes(4);
    const p0 = procs[0] as SettlementOutbox;
    for (let k = 0; k < 10; k++) must(await p0.begin(BEGIN(`m${k}`)));
    const rs = await Promise.all(Array.from({ length: 60 }, (_, i) => (procs[i % 4] as SettlementOutbox).recordFailure(REF(`m${i % 10}`), { errorCode: "STORE_FAILURE", dueAtMs: 20_000 + i, expectedAttempts: 0 })));
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(rs.filter((r) => r.ok && r.value.replayed === false)).toHaveLength(10);
    for (let k = 0; k < 10; k++) expect((await entry(p0, `m${k}`)).attempts).toBe(1);
  });

  it("رقابتِ CAS با bury: یا ثبت و سپس مرگ، یا مرگ و NOT_ACTIVE؛ هرگز شمارنده‌ای روی رکوردِ مرده (۴۰ دور)", async () => {
    const { procs } = await processes(2);
    const [a, b] = procs as [SettlementOutbox, SettlementOutbox];
    let recordedFirst = 0;
    let buriedFirst = 0;
    for (let i = 0; i < 40; i++) {
      must(await a.begin(BEGIN(`b${i}`)));
      const [rf, bu] = await Promise.all([a.recordFailure(REF(`b${i}`), { errorCode: "STORE_FAILURE", dueAtMs: 5_000, expectedAttempts: 0 }), b.bury(REF(`b${i}`), { reason: "ATTEMPTS_EXHAUSTED", errorCode: "STORE_FAILURE", atMs: 9_000 })]);
      expect(bu.ok).toBe(true);
      const e = await entry(a, `b${i}`);
      expect(e.state).toBe("dead");
      if (rf.ok) {
        recordedFirst += 1;
        expect(e.attempts).toBe(1);
      } else {
        buriedFirst += 1;
        expect(rf.error.code).toBe("NOT_ACTIVE");
        expect(e.attempts).toBe(0);
      }
    }
    expect(recordedFirst + buriedFirst).toBe(40);
  });

  it("مسیرِ بی‌expectedAttempts هم‌زمان هنوز می‌شمارد: ۲۵ فراخوان ⇒ attempts دقیقاً ۲۵ و بی‌replayed (سازگاریِ رو به عقب)", async () => {
    const { procs } = await processes(5);
    const p0 = procs[0] as SettlementOutbox;
    must(await p0.begin(BEGIN("r1")));
    const rs = (await Promise.all(Array.from({ length: 25 }, (_, i) => (procs[i % 5] as SettlementOutbox).recordFailure(REF("r1"), { errorCode: "STORE_FAILURE", dueAtMs: 20_000 + i })))).map(must);
    expect(rs.every((r) => !("replayed" in r))).toBe(true);
    expect(rs.map((r) => r.attempts).sort((x, y) => x - y)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });
});

dbDescribe("settlement/pg · ثبتِ شکستِ تکرارپذیر · ماندگاری و مهاجرت", () => {
  const opened: TestOutbox[] = [];
  afterAll(async () => {
    for (const t of opened) await t.dispose();
  });

  it("ثبت از ریستارتِ فرایند جان به در می‌برد؛ تکرار پس از ریستارت (قطعِ مبهمِ پس از commit) replayed است و چیزی نمی‌نویسد", async () => {
    const t = await openPgOutbox(3);
    opened.push(t);
    must(await t.outbox.begin(BEGIN("r1")));
    expect(must(await t.outbox.recordFailure(REF("r1"), { errorCode: "STORE_FAILURE", dueAtMs: 31_000, expectedAttempts: 0 }))).toEqual({ attempts: 1, replayed: false });
    await t.kill();
    const again = await t.reopen();
    try {
      expect(await entry(again.outbox, "r1")).toMatchObject({ attempts: 1, lastErrorCode: "STORE_FAILURE", dueAtMs: 31_000 });
      expect(must(await again.outbox.recordFailure(REF("r1"), { errorCode: "INTERNAL_ERROR", dueAtMs: 99_000, expectedAttempts: 0 }))).toEqual({ attempts: 1, replayed: true });
      expect(await entry(again.outbox, "r1")).toMatchObject({ attempts: 1, lastErrorCode: "STORE_FAILURE", dueAtMs: 31_000 });
    } finally {
      await again.close();
    }
  });

  it("هیچ مهاجرتِ تازه‌ای لازم نبود: فهرستِ مهاجرت‌ها همان دو تاست و وضعیتِ شِما کامل است", async () => {
    const t = await openPgOutbox(2);
    opened.push(t);
    expect(MIGRATIONS.map((m) => m.name)).toEqual(["0001_init", "0002_dead_ack"]);
    expect(await t.outbox.status()).toMatchObject({ ok: true, value: { pending: [] } });
  });

  it("فراخوانِ CAS روی رکوردِ مرده با ناورداهای پایگاه سازگار است: NOT_ACTIVE و ردیف دست‌نخورده", async () => {
    const t = await openPgOutbox(2);
    opened.push(t);
    must(await t.outbox.begin(BEGIN("r1")));
    must(await t.outbox.bury(REF("r1"), { reason: "LEDGER_REJECTED", errorCode: null, atMs: 20_000 }));
    const before = await t.raw("SELECT * FROM {{s}}.settlement_outbox WHERE reservation_id = 'r1'");
    const r = await t.outbox.recordFailure(REF("r1"), { errorCode: "STORE_FAILURE", dueAtMs: 1, expectedAttempts: 0 });
    expect(r).toMatchObject({ ok: false, error: { code: "NOT_ACTIVE" } });
    expect(await t.raw("SELECT * FROM {{s}}.settlement_outbox WHERE reservation_id = 'r1'")).toEqual(before);
  });
});

// ───────── آزمون تفاضلی ─────────
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

dbDescribe("settlement/pg · ثبتِ شکستِ تکرارپذیر · تفاضلی (حافظه‌ای ⇄ PostgreSQL)", () => {
  const opened: TestOutbox[] = [];
  afterAll(async () => {
    for (const t of opened) await t.dispose();
  });
  const IDS = ["r1", "r2", "r3"];

  it.each(Array.from({ length: 16 }, (_, i) => i + 1))("بذر %i: ۷۰ عملیاتِ تصادفیِ CAS/بی‌CAS/bury، نتیجه و وضعیتِ هر گام یکسان", async (seed) => {
    const t = await openPgOutbox(3);
    opened.push(t);
    const mem = createMemoryOutbox();
    const r = rng(seed * 6007);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
    for (const id of IDS) {
      expect(await t.outbox.begin(BEGIN(id))).toEqual(await mem.begin(BEGIN(id)));
    }
    const kinds = new Set<string>();
    for (let step = 0; step < 70; step++) {
      const id = pick(IDS);
      const w = r();
      let a: unknown;
      let b: unknown;
      if (w < 0.07) {
        const burial = { reason: "LEDGER_REJECTED" as const, errorCode: null, atMs: step };
        a = await mem.bury(REF(id), burial);
        b = await t.outbox.bury(REF(id), burial);
      } else {
        const cur = must(await mem.get(REF(id)));
        const n = cur?.attempts ?? 0;
        const input = { errorCode: pick(["STORE_FAILURE", "INTERNAL_ERROR"]), dueAtMs: 200 + step, ...(w < 0.2 ? {} : { expectedAttempts: w < 0.55 ? n : w < 0.8 ? Math.max(0, n - 1) : n + 1 + Math.floor(r() * 2) }) };
        a = await mem.recordFailure(REF(id), input);
        b = await t.outbox.recordFailure(REF(id), input);
        const ra = a as { ok: boolean; value?: { replayed?: boolean }; error?: { code: string } };
        kinds.add(ra.ok ? `ok:${String(ra.value?.replayed)}` : `err:${ra.error?.code}`);
      }
      expect(b, `بذر ${seed} گام ${step}`).toEqual(a);
      for (const k of IDS) expect(await entry(t.outbox, k), `بذر ${seed} گام ${step} رکورد ${k}`).toEqual(await entry(mem, k));
    }
    expect(kinds.size).toBeGreaterThanOrEqual(3);
  });
});

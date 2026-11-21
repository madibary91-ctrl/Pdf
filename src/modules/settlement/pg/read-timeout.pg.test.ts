/**
 * settlement/pg · سقفِ زمانِ سمتِ پایگاه روی PostgreSQL واقعی (ADR-0045، م۳‑ه‑۴‑الف‑۲‑۴‑آ).
 * روش: یک اتصالِ دیگر `LOCK TABLE … ACCESS EXCLUSIVE` روی جدولِ outbox می‌گیرد؛ خواندنِ پایش پشتِ قفل می‌ماند (دقیقاً «پرسشِ آویزان»ِ ADR-0044).
 * ثابت می‌کند: (۱) **بی‌گزینه** پرسش در پایگاه می‌ماند و منتظرِ قفل است (پیش‌فرضِ مشکل)؛ (۲) **با گزینه** پایگاه همان پرسش را لغو می‌کند، آداپتور
 * `STORE_FAILURE` برمی‌گرداند و هیچ بک‌اندِ منتظری از این فرایند نمی‌ماند؛ (۳) سقف فقط در همان تراکنش است و به اتصالِ استخر نشت نمی‌کند (استخرِ تک‌اتصالی)؛
 * (۴) مقدارِ درون‌تراکنش همان است که خواستیم؛ (۵) خواندنِ سالم و نوشتن‌ها دست‌نخورده‌اند. شِمای یک‌بارمصرفِ `settlement_test_*`.
 */
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import type { LedgerDatabase } from "@/modules/ledger";
import type { OutboxResult } from "../types";
import { createPgSettlementOutbox } from "./store";
import type { PgSettlementOutbox } from "./types";
import { TEST_APP_NAME, TEST_DB_URL, TEST_POOL_IDLE_MS, dbDescribe, openPgOutbox, type TestOutbox } from "./test-db";

const must = <T>(r: OutboxResult<T>): T => {
  if (!r.ok) throw new Error(`انتظار موفقیت بود: ${r.error.code}`);
  return r.value;
};
const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
const STORE_FAILURE = { ok: false, error: { code: "STORE_FAILURE", message: "ذخیرهٔ outbox در دسترس نیست." } };

dbDescribe("settlement/pg · readStatementTimeoutMs · PostgreSQL", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await (cleanups.pop() as () => Promise<void>)();
  });

  async function rig(poolSize: number, readStatementTimeoutMs?: number) {
    const t: TestOutbox = await openPgOutbox(poolSize);
    cleanups.push(t.dispose);
    const made = createPgSettlementOutbox(t.db, { schema: t.schema, ...(readStatementTimeoutMs === undefined ? {} : { readStatementTimeoutMs }) });
    if (!made.ok) throw new Error(made.error.code);
    const outbox: PgSettlementOutbox = made.value;
    /** اتصالِ جدا که جدولِ outbox را قفلِ انحصاری می‌کند تا `release()`. */
    const lock = async () => {
      const pool = new Pool({ connectionString: TEST_DB_URL, max: 1, idleTimeoutMillis: TEST_POOL_IDLE_MS });
      const client = await pool.connect();
      await client.query("BEGIN");
      await client.query(`LOCK TABLE "${t.schema}"."settlement_outbox" IN ACCESS EXCLUSIVE MODE`);
      let released = false;
      const release = async (): Promise<void> => {
        if (released) return;
        released = true;
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
        await pool.end();
      };
      cleanups.push(release);
      return { release };
    };
    /** بک‌اندهای همین فرایندِ آزمون که روی جدولِ outbox منتظرِ قفل‌اند (از اتصالِ جدا دیده می‌شود). */
    const waiting = async (): Promise<number> => {
      const probe = new Pool({ connectionString: TEST_DB_URL, max: 1, idleTimeoutMillis: TEST_POOL_IDLE_MS });
      try {
        const res = await probe.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND state = 'active' AND wait_event_type = 'Lock' AND query LIKE $2`,
          [TEST_APP_NAME, `%${t.schema}%settlement_outbox%`],
        );
        return Number((res.rows[0] as { n: number }).n);
      } finally {
        await probe.end();
      }
    };
    const untilWaiting = async (want: number): Promise<void> => {
      for (let i = 0; i < 200; i++) {
        if ((await waiting()) === want) return;
        await sleep(25);
      }
      throw new Error(`شمارِ بک‌اندهای منتظر به ${want} نرسید (اکنون ${await waiting()}).`);
    };
    return { t, outbox, lock, waiting, untilWaiting };
  }

  it("بی‌گزینه (پیش‌فرضِ مشکل): پرسشِ خواندن پشتِ قفل در پایگاه می‌ماند و تا آزادشدنِ قفل برنمی‌گردد؛ پس از آزادشدن موفق می‌شود", async () => {
    const r = await rig(4);
    const held = await r.lock();
    let settled = false;
    const call = r.t.outbox.listUnacknowledgedDead({ limit: 10 }).then((v) => {
      settled = true;
      return v;
    });
    await r.untilWaiting(1); // پرسش واقعاً در پایگاه منتظرِ قفل است
    await sleep(400);
    expect(settled).toBe(false);
    expect(await r.waiting()).toBe(1);
    await held.release();
    expect(must(await call)).toEqual([]);
    expect(await r.waiting()).toBe(0);
  });

  it("با گزینه: پایگاه همان پرسشِ پشتِ قفل را لغو می‌کند ⇒ STORE_FAILURE، زود، و هیچ بک‌اندِ منتظری نمی‌ماند (قفل هنوز در دست است)", async () => {
    const r = await rig(4, 300);
    const held = await r.lock();
    const t0 = Date.now();
    const res = await r.outbox.listUnacknowledgedDead({ limit: 10 });
    const elapsed = Date.now() - t0;
    expect(res).toEqual(STORE_FAILURE);
    expect(elapsed).toBeGreaterThanOrEqual(250); // سقف زودتر از موعد نزد
    expect(elapsed).toBeLessThan(5_000); // و آویزان نماند
    expect(await r.waiting()).toBe(0); // مهم‌ترین گزاره: «رها شد» نه «در پایگاه ادامه دارد»
    await held.release();
  });

  it("همهٔ خواندن‌های فقط‌خواندنی (listDead، counts، get) هم پشتِ قفل لغو می‌شوند؛ سپرِ مهاجرت هم زیرِ سقف است", async () => {
    const r = await rig(4, 200);
    const held = await r.lock();
    const results = await Promise.all([r.outbox.listDead({ limit: 5 }), r.outbox.counts(), r.outbox.get({ tenantId: "t", accountId: "a", reservationId: "r" })]);
    for (const x of results) expect(x).toEqual(STORE_FAILURE);
    expect(await r.waiting()).toBe(0);
    await held.release();
  });

  it("سقف به اتصالِ استخر نشت نمی‌کند: استخرِ تک‌اتصالی، پس از خواندنِ لغوشده و خواندنِ سالم، statement_timeout همان پیش‌فرضِ سرور است", async () => {
    const r = await rig(1, 250);
    const base = (await r.t.raw("SHOW statement_timeout"))[0]?.["statement_timeout"];
    const held = await r.lock();
    expect(await r.outbox.listUnacknowledgedDead({ limit: 10 })).toEqual(STORE_FAILURE); // لغو ⇒ rollback
    expect((await r.t.raw("SHOW statement_timeout"))[0]?.["statement_timeout"]).toBe(base);
    await held.release();
    expect(must(await r.outbox.listUnacknowledgedDead({ limit: 10 }))).toEqual([]); // commit
    expect((await r.t.raw("SHOW statement_timeout"))[0]?.["statement_timeout"]).toBe(base);
    // و نوشتنِ بعدی روی همان اتصال سقفی نمی‌گیرد.
    const begin = { tenantId: "t1", accountId: "a1", reservationId: "w1", unit: "IRR_MICROS", reserved: 5, createdAtMs: 1, expiresAtMs: 100, dueAtMs: 50, orphanRemainder: "forfeit" as const };
    expect(must(await r.outbox.begin(begin))).toEqual({ replayed: false });
  });

  it("درونِ تراکنشِ خواندن مقدارِ statement_timeout دقیقاً همان گزینه است؛ درونِ تراکنشِ نوشتن دست‌نخورده", async () => {
    const t: TestOutbox = await openPgOutbox(2);
    cleanups.push(t.dispose);
    const seen: Array<{ readOnly: boolean; value: unknown }> = [];
    const probing: LedgerDatabase = {
      execute: (q) => t.db.execute(q),
      transaction: (run, config) =>
        t.db.transaction(
          (tx) =>
            run({
              execute: async (q) => {
                const out = await tx.execute(q);
                // پس از هر دستور مقدارِ مؤثر را می‌خوانیم؛ آخرین مقدارِ دیده‌شده در همان تراکنش معیار است.
                const cur = await tx.execute(sql`SELECT current_setting('statement_timeout') AS v`);
                seen.push({ readOnly: config?.accessMode === "read only", value: cur.rows[0]?.["v"] });
                return out;
              },
            }),
          config,
        ),
    };
    const made = createPgSettlementOutbox(probing, { schema: t.schema, readStatementTimeoutMs: 1_234 });
    if (!made.ok) throw new Error(made.error.code);
    must(await made.value.listUnacknowledgedDead({ limit: 5 }));
    const reads = seen.splice(0);
    expect(reads.length).toBeGreaterThan(1);
    expect(reads.every((x) => x.readOnly && x.value === "1234ms")).toBe(true);
    must(await made.value.begin({ tenantId: "t1", accountId: "a1", reservationId: "w2", unit: "IRR_MICROS", reserved: 5, createdAtMs: 1, expiresAtMs: 100, dueAtMs: 50, orphanRemainder: "forfeit" }));
    const writes = seen.splice(0);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((x) => !x.readOnly && x.value !== "1234ms")).toBe(true);
  });

  it("خواندنِ سالم با سقفِ بزرگ همان نتیجهٔ نمونهٔ بی‌سقف را می‌دهد (هم‌ارزی روی داده‌ای با مرده‌های تأییدشده/تأییدنشده)", async () => {
    const r = await rig(4, 60_000);
    const mk = async (id: string, atMs: number) => {
      const ref = { tenantId: "t1", accountId: "a1", reservationId: id };
      must(await r.t.outbox.begin({ ...ref, unit: "IRR_MICROS", reserved: 5, createdAtMs: 1, expiresAtMs: 100, dueAtMs: 50, orphanRemainder: "forfeit" }));
      must(await r.t.outbox.bury(ref, { reason: "ATTEMPTS_EXHAUSTED", errorCode: null, atMs }));
      return ref;
    };
    const a = await mk("d1", 1_000);
    await mk("d2", 2_000);
    await mk("d3", 3_000);
    must(await r.t.outbox.acknowledgeDead(a, { atMs: 5_000 }));
    const bounded = must(await r.outbox.listUnacknowledgedDead({ limit: 10 }));
    const plain = must(await r.t.outbox.listUnacknowledgedDead({ limit: 10 }));
    expect(bounded).toEqual(plain);
    expect(bounded.map((e) => e.reservationId)).toEqual(["d2", "d3"]);
    expect(must(await r.outbox.counts())).toEqual(must(await r.t.outbox.counts()));
  });
});

/**
 * بودجهٔ اتصال و خرابیِ گذرای پایگاه (ADR-0024، تحویل ۰۰۲۴) — ریشهٔ `STORE_FAILURE`های تصادفیِ تحویل ۰۰۲۳.
 *
 * ریشه (بازتولیدشده): آزمون تفاضلی برای هر بذر یک `openPgOutbox(4)` باز می‌کرد و همه را فقط در `afterAll` می‌بست؛ استخرِ بیکار اتصال‌ها را ۱۰ ثانیه
 * نگه می‌دارد، پس ۲۴ بذر × ۴ اتصال = ۹۶ اتصالِ زنده تا پایانِ فایل. سقفِ سرور ۱۰۰ (۹۷ برای غیرمدیر) است و فایل‌های موازیِ دیگر `53300` می‌گرفتند.
 * آداپتور درست رفتار کرده بود (`53300` ⇒ `STORE_FAILURE` ثابت و بی‌جزئیات)؛ عیب در **کمک‌تست** بود، نه در محصول.
 *
 * بخش ۱ نشتِ اتصال را مستقیم می‌سنجد (با برچسبِ `application_name`، پس هم‌زمانیِ فایل‌های دیگر اثری ندارد).
 * بخش ۲ پیامدِ همین خطا را در محصول می‌سنجد: ردِ اتصال (پیش از تراکنش) و قطعِ اتصال **پس از commit** (نتیجهٔ مبهم: نوشتن شد ولی فراخوان خطا گرفت)
 * هر دو `STORE_FAILURE`ِ بی‌نشت‌اند، چیزی نیمه‌نوشته نمی‌مانَد و تکرارِ فراخوان (همان کاری که رفتگر می‌کند) به همان وضعیتِ نهاییِ مدلِ مرجع می‌رسد.
 */
import { afterAll, describe, expect, it } from "vitest";
import type { LedgerDatabase } from "@/modules/ledger";
import { createMemoryOutbox } from "../memory-outbox";
import type { OutboxResult, ReservationRef, SettlementOutbox } from "../types";
import { createPgSettlementOutbox } from "./store";
import { TEST_APP_NAME, TEST_POOL_IDLE_MS, countOwnConnections, dbDescribe, openPgOutbox, type TestOutbox } from "./test-db";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** تا برقراری شرط یا گذشتنِ مهلت؛ نشدن ⇒ false. */
async function until(cond: () => Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    if (await cond()) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(25);
  }
}

const REF = (id: string): ReservationRef => ({ tenantId: "t1", accountId: "a1", reservationId: id });
const BEGIN = (id: string) => ({ ...REF(id), unit: "IRR_MICROS", reserved: 500, createdAtMs: 1_000, expiresAtMs: 61_000, dueAtMs: 11_000, orphanRemainder: "forfeit" as const });
const STORE_FAILURE_MESSAGE = "ذخیرهٔ outbox در دسترس نیست.";

dbDescribe("settlement/pg · بودجهٔ اتصال (ریشهٔ ۵۳۳۰۰)", () => {
  const opened: TestOutbox[] = [];
  afterAll(async () => {
    for (const t of opened) await t.dispose();
  });

  it("برچسبِ application_name روی اتصال‌های این فرایند می‌نشیند و شمارنده فقط آن‌ها را می‌شمارد", async () => {
    const t = await openPgOutbox(2);
    opened.push(t);
    expect(TEST_APP_NAME).toMatch(/^settlement-test-\d+-[0-9a-f]{6}$/);
    const inside = await t.session(async (q) => {
      await q("SELECT 1");
      return countOwnConnections();
    });
    expect(inside).toBeGreaterThanOrEqual(1);
  });

  it("استخرِ بازِ آزمون اتصالِ بیکار را پس می‌دهد (بی‌dispose)، و outbox پس از آن همچنان کار می‌کند", async () => {
    const t = await openPgOutbox(4);
    opened.push(t);
    await Promise.all(["r1", "r2", "r3", "r4"].map((id) => t.outbox.get(REF(id))));
    expect(await until(async () => (await countOwnConnections()) === 0)).toBe(true);
    expect(await t.outbox.begin(BEGIN("r1"))).toEqual({ ok: true, value: { replayed: false } });
    expect(await t.outbox.get(REF("r1"))).toMatchObject({ ok: true });
  });

  it("الگوی آزمونِ تفاضلی: ۱۶ outbox که تا پایان باز می‌مانند ⇒ اوجِ اتصال کوچک می‌ماند (پیش از اصلاح ≥ ۶۴ بود)", async () => {
    const SEEDS = 16;
    let peak = 0;
    for (let seed = 0; seed < SEEDS; seed++) {
      const t = await openPgOutbox(4);
      opened.push(t);
      await Promise.all(["r1", "r2", "r3", "r4"].map((id) => t.outbox.get(REF(id)))); // مثلِ snapshot: چهار اتصالِ هم‌زمان
      await sleep(TEST_POOL_IDLE_MS * 3); // بدنهٔ آزمون کار می‌کند؛ استخر بیکار است
      peak = Math.max(peak, await countOwnConnections());
    }
    expect(peak).toBeLessThanOrEqual(8);
    expect(await until(async () => (await countOwnConnections()) === 0)).toBe(true);
  }, 60_000);
});

/** پایگاهِ خرابیِ برنامه‌پذیر روی پایگاهِ واقعی: `before` = ردِ اتصال (۵۳۳۰۰)؛ `after` = commit شد ولی اتصال پیش از پاسخ قطع شد (۰۸۰۰۶). */
type Fault = "none" | "before" | "after";
function faulty(real: LedgerDatabase, plan: () => Fault, counters: { before: number; after: number }): LedgerDatabase {
  return {
    execute: (q) => real.execute(q),
    transaction: async (run, config) => {
      const f = plan();
      if (f === "before") {
        counters.before++;
        throw Object.assign(new Error("sorry, too many clients already LEAK-CANARY-53300"), { code: "53300" });
      }
      const result = await real.transaction(run, config);
      if (f === "after") {
        counters.after++;
        throw Object.assign(new Error("terminating connection LEAK-CANARY-08006"), { code: "08006" });
      }
      return result;
    },
  };
}

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

const isStoreFailure = (r: unknown): boolean => (r as { ok: boolean }).ok === false && (r as { error: { code: string } }).error.code === "STORE_FAILURE";
const leaks = (r: unknown): boolean => /LEAK-CANARY|53300|08006|too many clients|terminating/i.test(JSON.stringify(r));

dbDescribe("settlement/pg · خرابیِ گذرای پایگاه (ردِ اتصال و قطعِ پس از commit)", () => {
  const opened: TestOutbox[] = [];
  afterAll(async () => {
    for (const t of opened) await t.dispose();
  });

  async function withFaults(plan: () => Fault): Promise<{ t: TestOutbox; outbox: SettlementOutbox; counters: { before: number; after: number } }> {
    const t = await openPgOutbox(4);
    opened.push(t);
    const counters = { before: 0, after: 0 };
    const made = createPgSettlementOutbox(faulty(t.db, plan, counters), { schema: t.schema });
    if (!made.ok) throw new Error(`createPgSettlementOutbox failed: ${made.error.code}`);
    return { t, outbox: made.value, counters };
  }
  const rowCount = async (t: TestOutbox): Promise<number> => Number((await t.raw("SELECT count(*)::int AS n FROM {{s}}.settlement_outbox"))[0]?.["n"]);

  it("ردِ اتصال (۵۳۳۰۰) ⇒ STORE_FAILUREِ ثابت و بی‌نشت، هیچ ردیفی نوشته نمی‌شود، و بازیابی بی‌اثرِ جانبی است", async () => {
    let left = 3;
    const { t, outbox } = await withFaults(() => (left-- > 0 ? "before" : "none"));
    for (let i = 0; i < 3; i++) {
      const r = await outbox.begin(BEGIN("r1"));
      expect(r).toEqual({ ok: false, error: { code: "STORE_FAILURE", message: STORE_FAILURE_MESSAGE } });
      expect(leaks(r)).toBe(false);
    }
    expect(await rowCount(t)).toBe(0);
    expect(await outbox.begin(BEGIN("r1"))).toEqual({ ok: true, value: { replayed: false } });
    expect(await rowCount(t)).toBe(1);
  });

  it("قطعِ اتصال پس از commit ⇒ STORE_FAILURE ولی نوشتن ماندگار است؛ تکرارِ همان فراخوان replayed=true می‌دهد (نه CONFLICT)", async () => {
    let next: Fault = "none";
    const { t, outbox } = await withFaults(() => next);
    const ambiguous = async <T,>(call: () => Promise<OutboxResult<T>>): Promise<OutboxResult<T>> => {
      next = "after";
      const first = await call();
      next = "none";
      expect(isStoreFailure(first)).toBe(true);
      expect(leaks(first)).toBe(false);
      return call();
    };

    expect(await ambiguous(() => outbox.begin(BEGIN("r1")))).toEqual({ ok: true, value: { replayed: true } });
    expect(await rowCount(t)).toBe(1);
    expect(await ambiguous(() => outbox.recordCharge(REF("r1"), { attemptId: "a1", amount: 5 }))).toEqual({ ok: true, value: { replayed: true } });
    expect(await ambiguous(() => outbox.recordClose(REF("r1"), { remainder: "release", origin: "caller" }))).toEqual({ ok: true, value: { replayed: true } });
    expect(await ambiguous(() => outbox.finish(REF("r1"), 40))).toEqual({ ok: true, value: { replayed: true } });
    expect(await outbox.get(REF("r1"))).toMatchObject({ ok: true, value: { state: "done", charge: { attemptId: "a1", amount: 5 }, close: { remainder: "release" } } });

    expect(await outbox.begin(BEGIN("r2"))).toEqual({ ok: true, value: { replayed: false } });
    const swept = await ambiguous(() => outbox.resolveClose(REF("r2")));
    expect(swept).toMatchObject({ ok: true, value: { state: "settling", close: { remainder: "forfeit", origin: "sweeper" } } });
    expect(await ambiguous(() => outbox.bury(REF("r2"), { reason: "ATTEMPTS_EXHAUSTED", errorCode: null, atMs: 9 }))).toEqual({ ok: true, value: { replayed: true } });
    expect(await outbox.get(REF("r2"))).toMatchObject({ ok: true, value: { state: "dead", deadReason: "ATTEMPTS_EXHAUSTED" } });
    expect(await outbox.counts()).toEqual({ ok: true, value: { open: 0, settling: 0, done: 1, dead: 1 } });
  });

  const SEEDS = Array.from({ length: 8 }, (_, i) => i + 1);
  it.each(SEEDS)("بذر %i: ۶۰ عملیاتِ تصادفی با خرابیِ تصادفی + تکرارِ رفتگرگونه ⇒ همان وضعیتِ نهاییِ مدلِ مرجع، بی‌نشت", async (seed) => {
    const r = rng(seed * 104729);
    const faultRng = rng(seed * 7 + 13);
    const plan = (): Fault => {
      const x = faultRng();
      return x < 0.55 ? "none" : x < 0.8 ? "before" : "after";
    };
    const { t, outbox, counters } = await withFaults(plan);
    const model = createMemoryOutbox();
    const refs = ["r1", "r2", "r3"].map(REF);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;

    type Call = Readonly<{ kind: string; run: (o: SettlementOutbox) => Promise<OutboxResult<unknown>> }>;
    const gen = (): Call => {
      const ref = pick(refs);
      const w = r();
      if (w < 0.25) {
        const b = { ...BEGIN(ref.reservationId), reserved: pick([500, 500, 501]) }; // تصادف بیرون از بستار: هر تکرار دقیقاً همان ورودی را بفرستد
        return { kind: "begin", run: (o) => o.begin(b) };
      }
      if (w < 0.45) {
        const c = { attemptId: pick(["a1", "a1", "a2"]), amount: pick([0, 5, 9]) };
        return { kind: "recordCharge", run: (o) => o.recordCharge(ref, c) };
      }
      if (w < 0.6) {
        const c = { remainder: pick(["release", "forfeit"] as const), origin: pick(["caller", "sweeper"] as const) };
        return { kind: "recordClose", run: (o) => o.recordClose(ref, c) };
      }
      if (w < 0.7) return { kind: "resolveClose", run: (o) => o.resolveClose(ref) };
      if (w < 0.85) {
        const at = pick([0, 7, 40]);
        return { kind: "finish", run: (o) => o.finish(ref, at) };
      }
      if (w < 0.95) {
        const b = { reason: pick(["EXPIRED_UNBILLED", "ATTEMPTS_EXHAUSTED"] as const), errorCode: null, atMs: pick([1, 9]) };
        return { kind: "bury", run: (o) => o.bury(ref, b) };
      }
      return { kind: "get", run: (o) => o.get(ref) };
    };
    // نتیجهٔ نوشتن پس از تکرارِ ناشی از قطعِ مبهم ممکن است replayed=true باشد؛ پس برای نوشتن‌ها فقط ok/کدِ خطا مقایسه می‌شود، نه پرچم.
    const norm = (kind: string, res: OutboxResult<unknown>): unknown => (res.ok ? (kind === "get" || kind === "resolveClose" ? res : "ok") : res.error.code);

    const failures: unknown[] = [];
    for (let step = 0; step < 60; step++) {
      const call = gen();
      const expected = norm(call.kind, await call.run(model));
      let actual: OutboxResult<unknown> | null = null;
      for (let tries = 0; tries < 40 && actual === null; tries++) {
        const res = await call.run(outbox);
        if (isStoreFailure(res)) failures.push(res);
        else actual = res;
      }
      expect(actual, `بذر ${seed} گام ${step}: ${call.kind} پس از ۴۰ تلاش هم پاسخ نگرفت`).not.toBeNull();
      expect(norm(call.kind, actual as OutboxResult<unknown>), `بذر ${seed} گام ${step}: ${call.kind}`).toEqual(expected);
    }

    expect(counters.before + counters.after, "خرابی واقعاً تزریق شده باشد").toBeGreaterThan(5);
    expect(failures).toHaveLength(counters.before + counters.after);
    for (const f of failures) {
      expect(f).toEqual({ ok: false, error: { code: "STORE_FAILURE", message: STORE_FAILURE_MESSAGE } });
      expect(leaks(f)).toBe(false);
    }
    const clean = createPgSettlementOutbox(t.db, { schema: t.schema });
    if (!clean.ok) throw new Error("createPgSettlementOutbox failed");
    for (const ref of refs) expect(await clean.value.get(ref), `بذر ${seed} وضعیتِ نهایی ${ref.reservationId}`).toEqual(await model.get(ref));
    expect(await clean.value.counts()).toEqual(await model.counts());
  });
});

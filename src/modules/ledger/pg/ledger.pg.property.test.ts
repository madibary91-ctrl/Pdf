/**
 * آزمون خاصیتی روی PostgreSQL واقعی (ADR-0019 تصمیم ۸): همان سرویس و موتور ل۱ با ذخیرهٔ PostgreSQL و با ذخیرهٔ حافظه‌ای
 * (مرجع ل۱) **هم‌زمان** اجرا می‌شوند؛ پس از **هر** عملیات: نتیجه‌ها برابرند، `read`/`journal` دو ذخیره برابرند،
 * و در پایان `audit` سالم است. هر بذر یک مستأجر مستقل است.
 * «ادعای پوشش» در پایان: همهٔ نوع‌های موفقیت، بازتکرار و کدهای خطای اصلی واقعاً دیده شده‌اند (تا آزمون تهی نباشد).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStore } from "../memory-store";
import type { AccountKey, AccountState, Ledger, LedgerResult } from "../types";
import { UNIT, mutableClock, prng, setup } from "../test-kit";
import { dbDescribe, openTestLedgerDb, type TestLedgerDb } from "./test-db";

const SEEDS = 40;
const OPS = 50;

type Op = { name: string; run: (l: Ledger) => Promise<LedgerResult<unknown>> };

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)] as T;
}

/** همهٔ انتخاب‌های تصادفی پیش از ساخت closure ثابت می‌شوند؛ اجرای دوباره روی دو دفتر دقیقاً همان فرمان است. */
type Hint = Readonly<{ reservationId: string; attemptId: string }> | null;

function randomOp(r: () => number, tenantId: string, hint: Hint): { op: Op; key: AccountKey; advance: number } {
  const key: AccountKey = { tenantId, accountId: r() < 0.95 ? "a1" : "a2" }; // a2 هرگز باز نمی‌شود
  const reservationId = pick(r, ["r0", "r1", "r2", "r3", "r4"]);
  const attemptId = pick(r, ["x0", "x1", "x2"]);
  // «بازگشتِ هدایت‌شده»: نیمی از بازگشت‌ها آخرین تلاشِ موفق را هدف می‌گیرند (وگرنه refund معتبر تقریباً هرگز ساخته نمی‌شود).
  const guided = hint !== null && r() < 0.6;
  const refundReservation = guided ? hint.reservationId : reservationId;
  const refundAttempt = guided ? hint.attemptId : attemptId;
  const unit = r() < 0.05 ? "OTHER" : UNIT;
  const amount1 = pick(r, [1, 1, 10, 40, 100, 1_000, 5_000]);
  const amount0 = pick(r, [0, 1, 3, 10, 40, 100, 1_000]);
  const ttlMs = pick(r, [1_000, 2_000, 5_000, 60_000, 5]);
  const grantId = pick(r, ["g0", "g1", "g2", "g3"]);
  const refundId = pick(r, ["f0", "f1", "f2", "f3", "f4", "f5"]);
  const refundAmount = pick(r, [1, 2, 3, 10, 60]);
  const source = pick(r, ["purchase", "promo", "adjustment"] as const);
  const remainder = pick(r, ["release", "forfeit"] as const);
  const advance = pick(r, [0, 0, 0, 300, 1_500, 5_000, 70_000]);
  const roll = r();
  const op: Op =
    roll < 0.03
      ? { name: "open", run: (l) => l.openAccount({ ...key, unit }) }
      : roll < 0.16
        ? { name: "grant", run: (l) => l.grant({ ...key, grantId, unit, amount: amount1, source }) }
        : roll < 0.4
          ? { name: "reserve", run: (l) => l.reserve({ ...key, reservationId, unit, amount: amount1, ttlMs }) }
          : roll < 0.66
            ? { name: "charge", run: (l) => l.charge({ ...key, reservationId, attemptId, unit, amount: amount0 }) }
            : roll < 0.74
              ? { name: "close", run: (l) => l.close({ ...key, reservationId, remainder }) }
              : roll < 0.9
                ? { name: "refund", run: (l) => l.refund({ ...key, refundId, reservationId: refundReservation, attemptId: refundAttempt, unit, amount: refundAmount }) }
                : roll < 0.96
                  ? { name: "balance", run: (l) => l.balance(key) }
                  : { name: "journal", run: (l) => l.journal(key) };
  return { op, key, advance };
}

const seen = { ok: new Map<string, number>(), replayed: 0, codes: new Map<string, number>(), commits: 0 };
const bump = (m: Map<string, number>, k: string): void => void m.set(k, (m.get(k) ?? 0) + 1);

dbDescribe("ledger/pg · آزمون خاصیتی: PostgreSQL ≡ ذخیرهٔ حافظه‌ای (موتور واقعی)", () => {
  let t: TestLedgerDb;
  // باز کردن در beforeAll (نه هنگام جمع‌آوری): `describe.skip` بدنه‌اش را اجرا می‌کند ولی hook‌هایش را نه؛ باز کردنِ زودهنگام بدون پایگاه
  // یک promise ردشدهٔ بی‌دستگیره می‌ساخت (Unhandled Rejection).
  beforeAll(async () => {
    t = await openTestLedgerDb();
  });
  afterAll(async () => {
    await t?.drop();
  });

  for (let seed = 1; seed <= SEEDS; seed++) {
    it(`بذر ${seed}: ${OPS} عملیات تصادفی/خصمانه`, async () => {
      const r = prng(seed * 7919);
      const tenantId = `s${seed}`;
      const clock = mutableClock();
      const mem = createMemoryStore();
      const memLedger = setup(mem, clock).ledger;
      const pgLedger = setup(t.store, clock).ledger;
      const keys: AccountKey[] = [
        { tenantId, accountId: "a1" },
        { tenantId, accountId: "a2" },
      ];

      // مقدمه: حساب باز و دارای اعتبار (وگرنه اغلب عملیات فقط ACCOUNT_NOT_FOUND می‌دیدند).
      const prelude: Op[] = [
        { name: "open", run: (l) => l.openAccount({ ...keys[0]!, unit: UNIT }) },
        { name: "grant", run: (l) => l.grant({ ...keys[0]!, grantId: "g-pre", unit: UNIT, amount: 5_000, source: "purchase" }) },
      ];
      let hint: Hint = null;
      for (let i = 0; i < OPS + prelude.length; i++) {
        const planned = i < prelude.length ? { op: prelude[i] as Op, key: keys[0] as AccountKey, advance: 0 } : randomOp(r, tenantId, hint);
        const { op, key, advance } = planned;
        clock.advance(advance);
        const expected = await op.run(memLedger);
        const actual = await op.run(pgLedger);
        if (actual.ok && op.name === "charge") {
          const v = actual.value as { reservationId: string; attemptId: string };
          hint = { reservationId: v.reservationId, attemptId: v.attemptId };
        }
        expect(actual, `بذر ${seed} عملیات ${i} ${op.name}`).toEqual(expected);
        if (actual.ok) {
          bump(seen.ok, op.name);
          if ((actual.value as { replayed?: boolean }).replayed === true) seen.replayed += 1;
        } else bump(seen.codes, actual.error.code);

        const [pgState, memState] = [await t.store.read(key), await mem.read(key)];
        expect(pgState, `بذر ${seed} عملیات ${i}: حالت`).toEqual(memState);
        expect(await t.store.journal(key), `بذر ${seed} عملیات ${i}: ژورنال`).toEqual(await mem.journal(key));
      }

      for (const k of keys) {
        expect(await t.store.read(k)).toEqual(await mem.read(k));
        const audit = await t.store.audit(k);
        expect(audit, `بذر ${seed}: ممیزی ${k.accountId}`).toMatchObject({ ok: true, value: { ok: true, problems: [] } });
        const s = (await t.store.read(k)) as AccountState | null;
        if (s !== null) {
          seen.commits += s.seq;
          expect((await t.store.journal(k)).length).toBe(s.seq);
        }
      }
    });
  }

  it("ادعای پوشش: همهٔ نوع‌های موفقیت، بازتکرار و کدهای خطای اصلی واقعاً دیده شده‌اند", () => {
    const info = JSON.stringify({ ok: Object.fromEntries(seen.ok), replayed: seen.replayed, codes: Object.fromEntries(seen.codes), commits: seen.commits });
    for (const k of ["open", "grant", "reserve", "charge", "close", "refund", "balance", "journal"]) expect(seen.ok.get(k) ?? 0, `${k} ${info}`).toBeGreaterThanOrEqual(10);
    expect(seen.replayed, info).toBeGreaterThanOrEqual(10);
    for (const c of ["INSUFFICIENT_CREDIT", "ACCOUNT_NOT_FOUND", "UNIT_MISMATCH", "INVALID_INPUT", "RESERVATION_NOT_FOUND", "RESERVATION_EXPIRED", "IDEMPOTENCY_CONFLICT", "REFUND_EXCEEDS_CHARGE"]) {
      expect(seen.codes.get(c) ?? 0, `${c} ${info}`).toBeGreaterThanOrEqual(1);
    }
    expect(seen.commits, info).toBeGreaterThanOrEqual(500);
  });
});

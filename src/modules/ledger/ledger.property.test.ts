/**
 * آزمون خاصیتی (ADR-0018 §۸): ۲۰۰ بذر × ۶۰ عملیات تصادفی/خصمانه روی سرویس واقعی + ذخیرهٔ حافظه‌ای.
 * پس از **هر** عملیات: ناوردای بقا، بازپخش ژورنال، جداسازی (حساب‌های دیگر دست‌نخورده)، و بی‌اثری بازتکرار.
 * در پایان «ادعای پوشش»: همهٔ شاخه‌های مهم واقعاً دیده شده‌اند (تا آزمون تهی نباشد).
 */
import { describe, expect, it } from "vitest";
import { checkInvariants, foldJournal } from "./index";
import type { AccountKey, AccountState, AccountStore, JournalEntry, Ledger, LedgerResult } from "./index";
import { UNIT, mutableClock, prng, setup } from "./test-kit";

const SEEDS = 200;
const OPS = 60;
const ACCOUNTS: AccountKey[] = [
  { tenantId: "t1", accountId: "a1" },
  { tenantId: "t1", accountId: "a2" },
  { tenantId: "t2", accountId: "a1" },
  { tenantId: "t2", accountId: "a2" }, // عمداً هرگز باز نمی‌شود
];
const OPENED = ACCOUNTS.slice(0, 3);

type Op = { kind: string; run: (l: Ledger) => Promise<LedgerResult<{ replayed: boolean }>> };

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)] as T;
}

/** همهٔ انتخاب‌های تصادفی **پیش از** ساختن closure ثابت می‌شوند؛ اجرای دوبارهٔ `run` دقیقاً همان فرمان را می‌فرستد. */
function randomOp(r: () => number): { op: Op; target: AccountKey } {
  const target = pick(r, ACCOUNTS);
  const reservationId = pick(r, ["r0", "r1", "r2", "r3", "r4"]);
  const attemptId = pick(r, ["x0", "x1", "x2"]);
  const amount = pick(r, [0, 1, 3, 10, 40, 100, 1_000, 5_000]);
  const unit = r() < 0.04 ? "OTHER" : UNIT;
  const grantId = pick(r, ["g0", "g1", "g2", "g3"]);
  const refundId = pick(r, ["f0", "f1", "f2", "f3", "f4", "f5", "f6", "f7"]);
  const refundAmount = pick(r, [1, 1, 2, 3, 10, 60]);
  const source = pick(r, ["purchase", "promo", "adjustment"] as const);
  const ttlMs = pick(r, [1_000, 2_000, 5_000, 60_000]);
  const remainder = pick(r, ["release", "forfeit"] as const);
  const openUnit = r() < 0.1 ? "OTHER" : UNIT;
  const roll = r();
  const pos = Math.max(1, amount);
  if (roll < 0.12) return { target, op: { kind: "grant", run: (l) => l.grant({ ...target, grantId, unit, amount: pos, source }) } };
  if (roll < 0.30) return { target, op: { kind: "reserve", run: (l) => l.reserve({ ...target, reservationId, unit, amount: pos, ttlMs }) } };
  if (roll < 0.56) return { target, op: { kind: "charge", run: (l) => l.charge({ ...target, reservationId, attemptId, unit, amount }) } };
  if (roll < 0.66) return { target, op: { kind: "close", run: (l) => l.close({ ...target, reservationId, remainder }) } };
  if (roll < 0.94) return { target, op: { kind: "refund", run: (l) => l.refund({ ...target, refundId, reservationId, attemptId, unit, amount: refundAmount }) } };
  return { target, op: { kind: "open", run: (l) => l.openAccount({ ...target, unit: openUnit }) } };
}


/** بازگشتِ «هدایت‌شده» به یک تلاشِ واقعاً مصرف‌شده (وگرنه بازگشتِ معتبر تقریباً هرگز تصادفی ساخته نمی‌شود). */
function guidedRefund(snaps: readonly { state: AccountState | null }[], r: () => number): { op: Op; target: AccountKey } | null {
  const idx = Math.floor(r() * OPENED.length);
  const state = snaps[idx]?.state ?? null;
  const target = OPENED[idx] as AccountKey;
  if (state === null) return null;
  const pairs = Object.values(state.reservations).flatMap((res) => Object.entries(res.attempts).filter(([, a]) => a.charged - a.refunded > 0).map(([att, a]) => ({ reservationId: res.id, attemptId: att, room: a.charged - a.refunded })));
  if (pairs.length === 0) return null;
  const p = pick(r, pairs);
  const amount = Math.max(1, Math.min(p.room + (r() < 0.2 ? 1 : 0), 1 + Math.floor(r() * p.room)));
  const refundId = pick(r, ["gf0", "gf1", "gf2", "gf3", "gf4", "gf5", "gf6", "gf7", "gf8", "gf9"]);
  return { target, op: { kind: "refund", run: (l) => l.refund({ ...target, refundId, reservationId: p.reservationId, attemptId: p.attemptId, unit: UNIT, amount }) } };
}

async function snapshot(store: AccountStore): Promise<{ state: AccountState | null; journal: readonly JournalEntry[] }[]> {
  return Promise.all(ACCOUNTS.map(async (k) => ({ state: await store.read(k), journal: await store.journal(k) })));
}

describe("ledger · پایداری تصادفی (۲۰۰ بذر × ۶۰ عملیات)", () => {
  it("ناوردای بقا، بازپخش ژورنال، جداسازی و بی‌اثری بازتکرار پس از هر عملیات برقرار است", async () => {
    const okByKind = new Map<string, number>();
    const errors = new Map<string, number>();
    let replays = 0;
    let shortfalls = 0;
    const entryTypes = new Set<string>();
    let lazyExpiryOnFailure = 0;

    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = prng(seed);
      const clock = mutableClock(1_000_000);
      const { ledger, store } = setup(undefined, clock);
      for (const k of OPENED) {
        await ledger.openAccount({ ...k, unit: UNIT });
        await ledger.grant({ ...k, grantId: "seed-grant", unit: UNIT, amount: pick(r, [50, 500, 5_000]), source: "purchase" });
      }

      for (let i = 0; i < OPS; i++) {
        if (r() < 0.35) clock.advance(Math.floor(r() * 3_000));
        if (r() < 0.03) clock.advance(-Math.floor(r() * 5_000)); // ساعت عقب‌رفته
        const before = await snapshot(store);
        const { op, target } = (r() < 0.2 ? guidedRefund(before, r) : null) ?? randomOp(r);
        const result = await op.run(ledger);
        const after = await snapshot(store);
        const where = `seed=${seed} op#${i} ${op.kind}`;

        if (result.ok) {
          okByKind.set(op.kind, (okByKind.get(op.kind) ?? 0) + 1);
          if (result.value.replayed) replays += 1;
        } else {
          errors.set(result.error.code, (errors.get(result.error.code) ?? 0) + 1);
        }

        // ۱) ناوردا‌ها روی همهٔ حساب‌ها
        for (const [idx, snap] of after.entries()) {
          if (snap.state === null) {
            expect(snap.journal, where).toEqual([]);
            continue;
          }
          expect(checkInvariants(snap.state), `${where} acct#${idx}`).toEqual([]);
          const f = foldJournal(snap.journal);
          expect(f.ok, `${where} acct#${idx} fold`).toBe(true);
          if (f.ok) expect(f.value, `${where} acct#${idx}`).toEqual({ available: snap.state.available, held: snap.state.held, totals: snap.state.totals, seq: snap.state.seq });
          for (const e of snap.journal) entryTypes.add(e.type);
          expect(snap.state.totals.shortfall >= 0).toBe(true);
          if (snap.state.totals.shortfall > 0) shortfalls += 1;
        }

        // ۲) جداسازی: فقط حسابِ هدف می‌تواند عوض شود
        for (const [idx, k] of ACCOUNTS.entries()) {
          if (k.tenantId === target.tenantId && k.accountId === target.accountId) continue;
          expect(after[idx], `${where} حساب بی‌ربط عوض شد`).toEqual(before[idx]);
        }

        // ۳) ژورنال فقط‌افزودنی (پیشوند قبلی دست‌نخورده) و در شکست فقط انقضای تنبل اضافه می‌شود
        const ti = ACCOUNTS.findIndex((k) => k.tenantId === target.tenantId && k.accountId === target.accountId);
        const bj = before[ti]?.journal ?? [];
        const aj = after[ti]?.journal ?? [];
        expect(aj.slice(0, bj.length), `${where} ژورنال بازنویسی شد`).toEqual(bj);
        if (!result.ok) {
          const added = aj.slice(bj.length);
          expect(
            added.every((e) => e.type === "expire"),
            `${where} شکست نباید جز انقضا چیزی بنویسد`,
          ).toBe(true);
          if (added.length > 0) lazyExpiryOnFailure += 1;
        }
        if (result.ok && result.value.replayed) expect(after[ti], `${where} بازتکرار حالت را عوض کرد`).toEqual(before[ti]);

        // ۴) بازتکرار فوریِ هر موفقیت: replayed، همان رسید، بی‌تغییر
        if (result.ok && !result.value.replayed) {
          const state = await snapshot(store);
          const again = await op.run(ledger);
          expect(again.ok, `${where} بازتکرار`).toBe(true);
          if (again.ok) expect(again.value).toEqual({ ...result.value, replayed: true });
          expect(await snapshot(store), `${where} بازتکرار اثر گذاشت`).toEqual(state);
        }
      }
    }

    // ادعای پوشش
    for (const k of ["grant", "reserve", "charge", "close", "refund", "open"]) expect(okByKind.get(k) ?? 0, `موفقیت ${k}`).toBeGreaterThan(20);
    for (const c of ["INSUFFICIENT_CREDIT", "RESERVATION_NOT_FOUND", "RESERVATION_CLOSED", "RESERVATION_EXPIRED", "IDEMPOTENCY_CONFLICT", "REFUND_EXCEEDS_CHARGE", "CHARGE_NOT_FOUND", "ACCOUNT_NOT_FOUND", "UNIT_MISMATCH"]) {
      expect(errors.get(c) ?? 0, `خطای ${c}`).toBeGreaterThan(0);
    }
    expect(replays).toBeGreaterThan(50);
    expect(shortfalls).toBeGreaterThan(0);
    expect(lazyExpiryOnFailure).toBeGreaterThan(0);
    for (const t of ["grant", "reserve", "charge", "release", "forfeit", "expire", "refund"]) expect(entryTypes.has(t), `ورودی ژورنال ${t}`).toBe(true);
  }, 120_000);
});

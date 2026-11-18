/**
 * ledger — ناوردا‌های دفتر (ADR-0018 §۸): بررسی حالت و بازپخش ژورنال. خالص؛ برای تست خاصیتی، ممیزی و پایش ل۲.
 */
import type { AccountState, JournalEntry, Totals } from "./types";

const safe = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** فهرست تخطی‌ها؛ تهی = سالم. */
export function checkInvariants(s: AccountState): string[] {
  const v: string[] = [];
  if (!safe(s.available)) v.push("available نامعتبر");
  if (!safe(s.held)) v.push("held نامعتبر");
  for (const [k, n] of Object.entries(s.totals)) if (!safe(n)) v.push(`totals.${k} نامعتبر`);
  let heldSum = 0;
  let charged = 0;
  let refunded = 0;
  let shortfall = 0;
  for (const r of Object.values(s.reservations)) {
    let attemptCharged = 0;
    for (const [id, a] of Object.entries(r.attempts)) {
      if (![a.requested, a.charged, a.shortfall, a.refunded].every(safe)) v.push(`تلاش ${id} نامعتبر`);
      if (a.charged + a.shortfall !== a.requested) v.push(`تلاش ${id}: مصرف + کسری ≠ درخواست`);
      if (a.refunded > a.charged) v.push(`تلاش ${id}: بازگشت بیش از مصرف`);
      attemptCharged += a.charged;
      refunded += a.refunded;
      shortfall += a.shortfall;
    }
    if (attemptCharged !== r.charged) v.push(`رزرو ${r.id}: charged ≠ Σ تلاش‌ها`);
    if (r.amount !== r.charged + r.remaining + r.closedAmount) v.push(`رزرو ${r.id}: amount ≠ charged + remaining + closedAmount`);
    if (r.status === "open") {
      heldSum += r.remaining;
      if (r.closedBy !== null || r.closedAtMs !== null || r.closedAmount !== 0) v.push(`رزرو باز ${r.id} نشانهٔ بستن دارد`);
    } else if (r.remaining !== 0 || r.closedBy === null || r.closedAtMs === null) v.push(`رزرو بستهٔ ${r.id} ناسازگار است`);
    charged += r.charged;
  }
  if (heldSum !== s.held) v.push("held ≠ Σ باقیماندهٔ رزروهای باز");
  if (charged !== s.totals.charged) v.push("totals.charged ≠ Σ رزروها");
  if (refunded !== s.totals.refunded) v.push("totals.refunded ≠ Σ تلاش‌ها");
  if (shortfall !== s.totals.shortfall) v.push("totals.shortfall ≠ Σ تلاش‌ها");
  if (s.totals.granted + s.totals.refunded !== s.available + s.held + s.totals.charged + s.totals.forfeited) {
    v.push("ناوردای بقا: granted + refunded ≠ available + held + charged + forfeited");
  }
  return v;
}

export type Folded = Readonly<{ available: number; held: number; totals: Readonly<Totals>; seq: number }>;

/** ژورنال را از صفر بازپخش می‌کند؛ ناپیوستگی `seq` یا ناسازگاریِ `availableAfter/heldAfter` ⇒ `ok: false`. */
export function foldJournal(entries: readonly JournalEntry[]): Readonly<{ ok: true; value: Folded }> | Readonly<{ ok: false; reason: string }> {
  let available = 0;
  let held = 0;
  const totals: Totals = { granted: 0, charged: 0, forfeited: 0, refunded: 0, shortfall: 0 };
  let seq = 0;
  for (const e of entries) {
    seq += 1;
    if (e.seq !== seq) return { ok: false, reason: `seq ناپیوسته در ورودی ${seq}` };
    if (!safe(e.amount) || !safe(e.shortfall)) return { ok: false, reason: `مبلغ نامعتبر در ورودی ${seq}` };
    switch (e.type) {
      case "grant":
        available += e.amount;
        totals.granted += e.amount;
        break;
      case "reserve":
        available -= e.amount;
        held += e.amount;
        break;
      case "charge":
        held -= e.amount;
        totals.charged += e.amount;
        totals.shortfall += e.shortfall;
        break;
      case "release":
      case "expire":
        held -= e.amount;
        available += e.amount;
        break;
      case "forfeit":
        held -= e.amount;
        totals.forfeited += e.amount;
        break;
      case "refund":
        available += e.amount;
        totals.refunded += e.amount;
        break;
    }
    if (available < 0 || held < 0) return { ok: false, reason: `موجودی منفی پس از ورودی ${seq}` };
    if (e.availableAfter !== available || e.heldAfter !== held) return { ok: false, reason: `availableAfter/heldAfter ناسازگار در ورودی ${seq}` };
  }
  return { ok: true, value: { available, held, totals, seq } };
}

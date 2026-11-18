/**
 * نوشتنِ یک commit (داخلی) — داخل تراکنشِ `transact` و پس از گرفتن قفل حساب.
 * تفاضلی است و **سابقه را سخت می‌سنجد**: هیچ رزرو/کلید یکتاییِ پیشین حذف یا دگرگون نمی‌شود؛ وگرنه `COMMIT_REJECTED` و تراکنش برمی‌گردد.
 * (پایگاه هم همین‌ها را با TRIGGER اجرا می‌کند؛ این‌جا بررسیِ زودهنگام با پیام روشن است.)
 */
import { sql } from "drizzle-orm";
import { checkInvariants } from "../invariants";
import type { AccountKey, AccountState, Commit, JournalEntry, Reservation } from "../types";
import { rejected } from "./errors";
import { tableRef } from "./naming";
import { processedCanon, reservationCanon } from "./rows";
import type { LedgerExecutor } from "./types";

/** مقدار عددیِ قابل‌نوشتن: صحیح ایمنِ نامنفی (پیش از رسیدن به SQL؛ دامنهٔ پایگاه همان را دوباره می‌سنجد). */
function n(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw rejected("مقدار عددیِ نامعتبر در commit (باید صحیح ایمن و نامنفی باشد).");
  return v;
}

const json = (v: unknown): ReturnType<typeof sql> => sql`${JSON.stringify(v)}::jsonb`;

async function writeAccount(tx: LedgerExecutor, schema: string, s: AccountState, insert: boolean): Promise<void> {
  const t = tableRef(schema, "account");
  if (insert) {
    await tx.execute(sql`INSERT INTO ${t} (tenant_id, account_id, unit, created_at_ms, last_at_ms, seq, available, held, granted, charged, forfeited, refunded, shortfall)
      VALUES (${s.tenantId}, ${s.accountId}, ${s.unit}, ${n(s.createdAtMs)}, ${n(s.lastAtMs)}, ${n(s.seq)}, ${n(s.available)}, ${n(s.held)},
              ${n(s.totals.granted)}, ${n(s.totals.charged)}, ${n(s.totals.forfeited)}, ${n(s.totals.refunded)}, ${n(s.totals.shortfall)})`);
    return;
  }
  await tx.execute(sql`UPDATE ${t} SET last_at_ms = ${n(s.lastAtMs)}, seq = ${n(s.seq)}, available = ${n(s.available)}, held = ${n(s.held)},
      granted = ${n(s.totals.granted)}, charged = ${n(s.totals.charged)}, forfeited = ${n(s.totals.forfeited)}, refunded = ${n(s.totals.refunded)}, shortfall = ${n(s.totals.shortfall)}
    WHERE tenant_id = ${s.tenantId} AND account_id = ${s.accountId}`);
}

async function insertReservation(tx: LedgerExecutor, schema: string, key: AccountKey, r: Reservation): Promise<void> {
  await tx.execute(sql`INSERT INTO ${tableRef(schema, "reservation")}
      (tenant_id, account_id, reservation_id, amount, remaining, charged, closed_amount, status, closed_by, created_at_ms, expires_at_ms, closed_at_ms, attempts)
    VALUES (${key.tenantId}, ${key.accountId}, ${r.id}, ${n(r.amount)}, ${n(r.remaining)}, ${n(r.charged)}, ${n(r.closedAmount)}, ${r.status}, ${r.closedBy},
            ${n(r.createdAtMs)}, ${n(r.expiresAtMs)}, ${r.closedAtMs === null ? null : n(r.closedAtMs)}, ${json(r.attempts)})`);
}

async function updateReservation(tx: LedgerExecutor, schema: string, key: AccountKey, r: Reservation): Promise<void> {
  await tx.execute(sql`UPDATE ${tableRef(schema, "reservation")}
    SET remaining = ${n(r.remaining)}, charged = ${n(r.charged)}, closed_amount = ${n(r.closedAmount)}, status = ${r.status}, closed_by = ${r.closedBy},
        closed_at_ms = ${r.closedAtMs === null ? null : n(r.closedAtMs)}, attempts = ${json(r.attempts)}
    WHERE tenant_id = ${key.tenantId} AND account_id = ${key.accountId} AND reservation_id = ${r.id}`);
}

async function insertEntry(tx: LedgerExecutor, schema: string, key: AccountKey, e: JournalEntry): Promise<void> {
  await tx.execute(sql`INSERT INTO ${tableRef(schema, "journal")}
      (tenant_id, account_id, seq, at_ms, type, amount, shortfall, reservation_id, attempt_id, ref_id, available_after, held_after)
    VALUES (${key.tenantId}, ${key.accountId}, ${n(e.seq)}, ${n(e.atMs)}, ${e.type}, ${n(e.amount)}, ${n(e.shortfall)},
            ${e.reservationId}, ${e.attemptId}, ${e.refId}, ${n(e.availableAfter)}, ${n(e.heldAfter)})`);
}

export async function writeCommit(
  tx: LedgerExecutor,
  schema: string,
  key: AccountKey,
  before: AccountState | null,
  commit: Commit,
  semanticGuards: boolean,
): Promise<void> {
  const { state, entries } = commit;
  if (state.tenantId !== key.tenantId || state.accountId !== key.accountId) throw rejected("کلید حالتِ commit با کلید تراکنش یکی نیست.");
  if (semanticGuards && checkInvariants(state).length > 0) throw rejected("حالتِ commit ناوردای دفتر را می‌شکند؛ نوشته نشد.");
  if (before !== null && (state.unit !== before.unit || state.createdAtMs !== before.createdAtMs)) throw rejected("واحد و زمان ساخت حساب تغییرناپذیرند.");

  await writeAccount(tx, schema, state, before === null);

  const baseRes = before?.reservations ?? {};
  for (const id of Object.keys(baseRes)) if (!Object.hasOwn(state.reservations, id)) throw rejected("رزروها هرگز حذف نمی‌شوند.");
  for (const [id, r] of Object.entries(state.reservations)) {
    if (r.id !== id) throw rejected("شناسهٔ رزرو با کلیدش یکی نیست.");
    const old = Object.hasOwn(baseRes, id) ? (baseRes[id] as Reservation) : undefined;
    if (old === undefined) {
      await insertReservation(tx, schema, key, r);
    } else if (reservationCanon(old) !== reservationCanon(r)) {
      if (old.amount !== r.amount || old.createdAtMs !== r.createdAtMs || old.expiresAtMs !== r.expiresAtMs) throw rejected("مبلغ و سررسید رزرو تغییرناپذیرند.");
      await updateReservation(tx, schema, key, r);
    }
  }

  const baseProc = before?.processed ?? {};
  for (const k of Object.keys(baseProc)) if (!Object.hasOwn(state.processed, k)) throw rejected("کلیدهای یکتایی هرگز حذف نمی‌شوند.");
  for (const [k, p] of Object.entries(state.processed)) {
    if (Object.hasOwn(baseProc, k)) {
      if (processedCanon(baseProc[k] as (typeof state.processed)[string]) !== processedCanon(p)) throw rejected("کلید یکتایی پس از ثبت تغییرناپذیر است.");
      continue;
    }
    await tx.execute(sql`INSERT INTO ${tableRef(schema, "processed")} (tenant_id, account_id, op_key, fingerprint, receipt)
      VALUES (${key.tenantId}, ${key.accountId}, ${k}, ${p.fingerprint}, ${json(p.receipt)})`);
  }

  for (const e of entries) await insertEntry(tx, schema, key, e);
}

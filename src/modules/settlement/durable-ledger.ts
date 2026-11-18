/**
 * دفتر تسویهٔ ماندگار (ADR-0021): یک `Ledger`-سازگار که روی دفتر واقعی می‌نشیند و **پیش از هر تغییرِ مالی قصدِ آن را در outbox ثبت می‌کند**.
 *  - `reserve` موفق ⇒ `begin` (اگر ناموفق: رزرو آزاد می‌شود و خطا برمی‌گردد؛ پس تماسِ مدل هرگز بی‌ردّ ماندگار انجام نمی‌شود).
 *  - `charge` ⇒ `recordCharge` سپس دفتر؛ `close` ⇒ `recordClose` سپس دفتر و `finish`. ثبتِ ناموفق ⇒ دفتر **دست‌نخورده** (بسته‌شکست).
 * metering بی‌تغییر روی آن کار می‌کند (فقط `Ledger` می‌شناسد). ساعت و تصادف ندارد؛ ساعت تزریق می‌شود. هرگز نمی‌پرتابد.
 */
import { parseCommand } from "@/modules/ledger";
import type { Clock, Ledger } from "@/modules/ledger";
import { resolveDurableLedgerConfig } from "./config";
import { safeLedger, safeOutbox, toLedgerError } from "./ports";
import { markDecoratedLedger } from "./decorated";
import type { DurableLedgerConfig, SettlementResult } from "./types";

const refuse = (code: "INVALID_INPUT" | "INTERNAL_ERROR" | "STORE_FAILURE", message: string): { ok: false; error: { code: typeof code; message: string } } => ({
  ok: false,
  error: Object.freeze({ code, message }),
});

function readClock(clock: Clock): number | null {
  try {
    const t = clock.nowMs();
    return Number.isSafeInteger(t) && t >= 0 ? t : null;
  } catch {
    return null;
  }
}

export function buildDurableLedger(cfg: DurableLedgerConfig): Ledger {
  const { ledger, outbox } = cfg;

  const durable: Ledger = Object.freeze({
    openAccount: (input) => ledger.openAccount(input),
    grant: (input) => ledger.grant(input),
    refund: (input) => ledger.refund(input),
    balance: (key) => ledger.balance(key),
    journal: (key) => ledger.journal(key),

    async reserve(input) {
      const cmd = parseCommand("reserve", input);
      if (!cmd.ok) return cmd;
      const c = cmd.value;
      if (c.kind !== "reserve") return refuse("INTERNAL_ERROR", "فرمان رزرو نامعتبر شد.");
      // نیمی از عمرِ رزرو باید برای رفتگر بماند؛ وگرنه «هزینه شد ولی دیگر قابل ثبت نیست» ساختاری می‌شود.
      if (c.ttlMs < 2 * cfg.graceMs) return refuse("INVALID_INPUT", "عمر رزرو باید دست‌کم دو برابر graceMs باشد.");
      const body = { tenantId: c.tenantId, accountId: c.accountId, reservationId: c.reservationId, unit: c.unit, amount: c.amount, ttlMs: c.ttlMs };
      const res = await safeLedger(() => ledger.reserve(body));
      // بازتکرار: رزرو پیشتر بوده (و رکوردش هم)؛ دست نمی‌زنیم. metering خودش `SCOPE_REUSED` می‌دهد.
      if (!res.ok || res.value.replayed) return res;
      const now = readClock(cfg.clock);
      const begun =
        now === null
          ? refuse("INTERNAL_ERROR", "ساعت نامعتبر بود.")
          : await safeOutbox(() =>
              outbox.begin({
                tenantId: c.tenantId,
                accountId: c.accountId,
                reservationId: c.reservationId,
                unit: c.unit,
                reserved: res.value.amount,
                createdAtMs: now,
                expiresAtMs: res.value.expiresAtMs,
                dueAtMs: now + cfg.graceMs,
                orphanRemainder: cfg.onUnknownCost,
              }),
            );
      if (!begun.ok) {
        // بی‌ردّ ماندگار تماس مجاز نیست: رزرو را (تا جای ممکن) برمی‌گردانیم؛ اگر آن هم نشد با سررسید آزاد می‌شود. هیچ تماسِ پولی انجام نمی‌شود.
        await safeLedger(() => ledger.close({ tenantId: c.tenantId, accountId: c.accountId, reservationId: c.reservationId, remainder: "release" }));
        return refuse("STORE_FAILURE", "ثبت ماندگارِ رزرو در outbox ناموفق بود؛ رزرو برگردانده شد.");
      }
      return res;
    },

    async charge(input) {
      const cmd = parseCommand("charge", input);
      if (!cmd.ok) return cmd;
      const c = cmd.value;
      if (c.kind !== "charge") return refuse("INTERNAL_ERROR", "فرمان مصرف نامعتبر شد.");
      const ref = { tenantId: c.tenantId, accountId: c.accountId, reservationId: c.reservationId };
      const rec = await safeOutbox(() => outbox.recordCharge(ref, { attemptId: c.attemptId, amount: c.amount }));
      if (!rec.ok) return toLedgerError(rec.error);
      return safeLedger(() => ledger.charge({ ...ref, attemptId: c.attemptId, unit: c.unit, amount: c.amount }));
    },

    async close(input) {
      const cmd = parseCommand("close", input);
      if (!cmd.ok) return cmd;
      const c = cmd.value;
      if (c.kind !== "close") return refuse("INTERNAL_ERROR", "فرمان بستن نامعتبر شد.");
      const ref = { tenantId: c.tenantId, accountId: c.accountId, reservationId: c.reservationId };
      const rec = await safeOutbox(() => outbox.recordClose(ref, { remainder: c.remainder, origin: "caller" }));
      if (!rec.ok) return toLedgerError(rec.error);
      const res = await safeLedger(() => ledger.close({ ...ref, remainder: c.remainder }));
      if (res.ok) {
        // پایانِ رکورد؛ شکستش بی‌خطر است (رفتگر با تکرارِ idempotent می‌بندد) و نتیجهٔ دفتر را عوض نمی‌کند.
        const now = readClock(cfg.clock);
        if (now !== null) await safeOutbox(() => outbox.finish(ref, now));
      }
      return res;
    },
  });
  markDecoratedLedger(durable);
  return durable;
}

export function createDurableLedger(raw: unknown): SettlementResult<Ledger> {
  const resolved = resolveDurableLedgerConfig(raw);
  if (!resolved.ok) return resolved;
  return { ok: true, value: buildDurableLedger(resolved.value) };
}

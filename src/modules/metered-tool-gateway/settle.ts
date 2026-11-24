/**
 * تسویهٔ یک رزرو (ADR-0062). **همان قاعده‌های `metered-gateway`** (ADR-0020 تصمیم‌های ۵ تا ۷)؛ نسخهٔ metering داخلی است و بدونِ
 * تغییرِ آزمون‌های موجود قابل‌اشتراک نبود، پس اینجا بازنویسی شده و **آزمونِ همسانی** (`parity.test.ts`) انحراف را می‌گیرد.
 */
import type { LedgerErrorCode, LedgerResult, Ledger, AccountKey } from "@/modules/ledger";
import { ATTEMPT_ID, SETTLE_ATTEMPTS, type MeteringAlarm, type MeteringOutcome, type MeteringReceipt, type Observed, type OnUnknownCost } from "@/modules/metering";

const TRANSIENT: ReadonlySet<LedgerErrorCode> = new Set(["STORE_FAILURE", "INTERNAL_ERROR"]);

export type SettleConfig = Readonly<{ ledger: Ledger; account: AccountKey; unit: string; onUnknownCost: OnUnknownCost }>;

export function makeReceipt(unit: string, r: Omit<MeteringReceipt, "unit" | "alarms"> & { alarms?: readonly MeteringAlarm[] }): MeteringReceipt {
  return Object.freeze({ ...r, unit, alarms: Object.freeze([...(r.alarms ?? [])]) });
}

async function settleCall<T>(op: () => Promise<LedgerResult<T>>): Promise<LedgerResult<T>> {
  let last: LedgerResult<T> = { ok: false, error: { code: "INTERNAL_ERROR", message: "تسویه اجرا نشد." } };
  for (let i = 0; i < SETTLE_ATTEMPTS; i++) {
    try {
      last = await op();
    } catch {
      last = { ok: false, error: { code: "INTERNAL_ERROR", message: "تسویه اجرا نشد." } };
    }
    if (last.ok || !TRANSIENT.has(last.error.code)) return last;
  }
  return last;
}

export async function settleStep(cfg: SettleConfig, reservationId: string, reserved: number, observed: Observed): Promise<MeteringReceipt> {
  const key = cfg.account;
  const alarms: MeteringAlarm[] = [];
  const base = { reservationId, reserved };
  const receipt = (r: Omit<MeteringReceipt, "unit" | "alarms"> & { alarms?: readonly MeteringAlarm[] }): MeteringReceipt => makeReceipt(cfg.unit, r);
  const close = (remainder: "release" | "forfeit") => settleCall(() => cfg.ledger.close({ ...key, reservationId, remainder }));

  if (observed.kind === "known") {
    const ch = await settleCall(() => cfg.ledger.charge({ ...key, reservationId, attemptId: ATTEMPT_ID, unit: cfg.unit, amount: observed.micros }));
    if (!ch.ok) {
      if (ch.error.code === "RESERVATION_EXPIRED") return receipt({ ...base, outcome: "unbilled", charged: 0, shortfall: 0, alarms: ["UNBILLED"] });
      return receipt({ ...base, outcome: "settlement-failed", charged: 0, shortfall: 0, alarms: ["SETTLEMENT_PENDING"] });
    }
    if (ch.value.shortfall > 0) alarms.push("SHORTFALL");
    const cl = await close("release");
    if (!cl.ok) alarms.push("CLOSE_PENDING");
    return receipt({ ...base, outcome: "billed", charged: ch.value.charged, shortfall: ch.value.shortfall, alarms });
  }

  const remainder = observed.kind === "none" ? "release" : cfg.onUnknownCost;
  let charged = 0;
  let shortfall = 0;
  if (observed.kind === "unknown") {
    alarms.push("COST_UNKNOWN");
    if (observed.lowerBound > 0) {
      const ch = await settleCall(() => cfg.ledger.charge({ ...key, reservationId, attemptId: ATTEMPT_ID, unit: cfg.unit, amount: observed.lowerBound }));
      if (!ch.ok) {
        if (ch.error.code === "RESERVATION_EXPIRED") return receipt({ ...base, outcome: "unbilled", charged: 0, shortfall: 0, alarms: [...alarms, "UNBILLED"] });
        return receipt({ ...base, outcome: "settlement-failed", charged: 0, shortfall: 0, alarms: [...alarms, "SETTLEMENT_PENDING"] });
      }
      charged = ch.value.charged;
      shortfall = ch.value.shortfall;
      if (shortfall > 0) alarms.push("SHORTFALL");
    }
  }
  const cl = await close(remainder);
  const outcome: MeteringOutcome = remainder === "forfeit" ? "forfeited" : "released";
  if (cl.ok) return receipt({ ...base, outcome, charged, shortfall, alarms });
  if (cl.error.code === "RESERVATION_EXPIRED") return receipt({ ...base, outcome: "unbilled", charged, shortfall, alarms: [...alarms, "UNBILLED"] });
  return receipt({ ...base, outcome: "settlement-failed", charged, shortfall, alarms: [...alarms, "SETTLEMENT_PENDING"] });
}

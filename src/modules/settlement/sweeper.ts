/**
 * رفتگر تسویه (ADR-0021): رکوردهای سررسیدشدهٔ outbox را با تکرارِ idempotentِ همان شناسه‌ها روی دفتر خام می‌بندد.
 * یک گذر (`sweep`) = بی‌تایمر و بی‌ساعتِ سراسری؛ زمان‌بندی (هر چند ثانیه) کار ریشهٔ ترکیب است. هرگز نمی‌پرتابد.
 *
 * تصمیمِ بستنِ رزروِ یتیم با خودِ outbox است (`resolveClose`، اتمی)؛ رفتگر فقط آنچه ثبت شده را اجرا می‌کند:
 *   قصدِ مصرف (اگر هست) ← `charge`؛ سپس `close` با باقیماندهٔ ثبت‌شده؛ سپس `finish`.
 */
import { resolveSweeperConfig } from "./config";
import type { ResolvedSweeperConfig } from "./config";
import { safeLedger, safeOutbox } from "./ports";
import type { BuriedItem, DeadReason, OutboxEntry, SettlementResult, Sweeper, SweepReport } from "./types";

const TRANSIENT: ReadonlySet<string> = new Set(["STORE_FAILURE", "INTERNAL_ERROR"]);

type Step =
  | Readonly<{ kind: "settled" }>
  | Readonly<{ kind: "retry" }>
  | Readonly<{ kind: "buried"; reason: DeadReason; code: string }>
  | Readonly<{ kind: "raced" }>
  | Readonly<{ kind: "outbox-failure" }>;

const EMPTY: SweepReport = Object.freeze({ examined: 0, settled: 0, retryLater: 0, raced: 0, outboxFailures: 0, buried: Object.freeze([]), listFailed: false });

function readClock(clock: ResolvedSweeperConfig["clock"]): number | null {
  try {
    const t = clock.nowMs();
    return Number.isSafeInteger(t) && t >= 0 ? t : null;
  } catch {
    return null;
  }
}

export function createSettlementSweeper(raw: unknown): SettlementResult<Sweeper> {
  const resolved = resolveSweeperConfig(raw);
  if (!resolved.ok) return resolved;
  const cfg = resolved.value;

  /** خطای دفتر ⇒ تلاش دوباره (گذرا)، یا مرگِ مستند (انقضا/ردِ دائمی). */
  async function onLedgerError(e: OutboxEntry, code: string, now: number): Promise<Step> {
    if (TRANSIENT.has(code)) {
      if (e.attempts + 1 < cfg.maxAttempts) {
        const rf = await safeOutbox(() => cfg.outbox.recordFailure(e, { errorCode: code, dueAtMs: now + cfg.retryDelayMs * (e.attempts + 1) }));
        return rf.ok ? { kind: "retry" } : { kind: "outbox-failure" };
      }
      return bury(e, "ATTEMPTS_EXHAUSTED", code, now);
    }
    return bury(e, code === "RESERVATION_EXPIRED" ? "EXPIRED_UNBILLED" : "LEDGER_REJECTED", code, now);
  }

  async function bury(e: OutboxEntry, reason: DeadReason, code: string, now: number): Promise<Step> {
    const b = await safeOutbox(() => cfg.outbox.bury(e, { reason, errorCode: code, atMs: now }));
    if (b.ok) return { kind: "buried", reason, code };
    return b.error.code === "NOT_ACTIVE" || b.error.code === "CONFLICT" ? { kind: "raced" } : { kind: "outbox-failure" };
  }

  async function settleEntry(listed: OutboxEntry, now: number): Promise<Step> {
    const rc = await safeOutbox(() => cfg.outbox.resolveClose(listed));
    if (!rc.ok) return rc.error.code === "STORE_FAILURE" ? { kind: "outbox-failure" } : { kind: "raced" };
    const e = rc.value;
    const close = e.close;
    if (close === null) return { kind: "outbox-failure" }; // قراردادِ resolveClose نقض شد؛ دست نمی‌زنیم.

    if (e.charge !== null) {
      const intent = e.charge;
      const c = await safeLedger(() => cfg.ledger.charge({ tenantId: e.tenantId, accountId: e.accountId, reservationId: e.reservationId, attemptId: intent.attemptId, unit: e.unit, amount: intent.amount }));
      if (!c.ok) return onLedgerError(e, c.error.code, now);
    }
    const cl = await safeLedger(() => cfg.ledger.close({ tenantId: e.tenantId, accountId: e.accountId, reservationId: e.reservationId, remainder: close.remainder }));
    if (!cl.ok) return onLedgerError(e, cl.error.code, now);
    const fin = await safeOutbox(() => cfg.outbox.finish(e, now));
    if (!fin.ok) return fin.error.code === "STORE_FAILURE" ? { kind: "outbox-failure" } : { kind: "raced" };
    return { kind: "settled" };
  }

  const sweeper: Sweeper = Object.freeze({
    async sweep(): Promise<SweepReport> {
      const now = readClock(cfg.clock);
      if (now === null) return Object.freeze({ ...EMPTY, listFailed: true });
      const listed = await safeOutbox(() => cfg.outbox.listDue({ nowMs: now, limit: cfg.limit }));
      if (!listed.ok) return Object.freeze({ ...EMPTY, listFailed: true });

      let settled = 0;
      let retryLater = 0;
      let raced = 0;
      let outboxFailures = 0;
      const buried: BuriedItem[] = [];
      for (const entry of listed.value) {
        let step: Step;
        try {
          step = await settleEntry(entry, now);
        } catch {
          step = { kind: "retry" }; // خطای برنامه‌نویسی؛ رکورد دست‌نخورده می‌ماند و گذر بعد دوباره می‌بیند.
        }
        if (step.kind === "settled") settled += 1;
        else if (step.kind === "retry") retryLater += 1;
        else if (step.kind === "raced") raced += 1;
        else if (step.kind === "outbox-failure") outboxFailures += 1;
        else buried.push(Object.freeze({ tenantId: entry.tenantId, accountId: entry.accountId, reservationId: entry.reservationId, reason: step.reason, errorCode: step.code }));
      }
      return Object.freeze({ examined: listed.value.length, settled, retryLater, raced, outboxFailures, buried: Object.freeze(buried), listFailed: false });
    },
  });
  return { ok: true, value: sweeper };
}

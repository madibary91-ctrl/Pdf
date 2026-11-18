/**
 * ممیزی یک حساب (داخلی): حالت و ژورنال در **یک اسنپ‌شات REPEATABLE READ** خوانده می‌شوند؛ سپس
 *  - `checkInvariants(حالت)` تهی باشد؛
 *  - بازپخش ژورنال از صفر دقیقاً برابر `available/held/totals/seq` حالت باشد؛
 *  - شمار ورودی‌های ژورنال برابر `seq` باشد.
 * گزارش هیچ مبلغی نمی‌آورد؛ فقط شمارش و پیام‌های ثابت.
 */
import { checkInvariants, foldJournal } from "../invariants";
import type { AccountKey } from "../types";
import { assertCurrent } from "./migrate";
import { toStoreError } from "./errors";
import { assertKey, loadJournal, loadState } from "./read";
import type { AccountAudit, LedgerDatabase, PgStoreResult } from "./types";

export async function auditAccount(db: LedgerDatabase, schema: string, key: AccountKey): Promise<PgStoreResult<AccountAudit>> {
  try {
    assertKey(key);
    const report = await db.transaction(
      async (tx): Promise<AccountAudit> => {
        await assertCurrent(tx, schema);
        const state = await loadState(tx, schema, key, false);
        const entries = await loadJournal(tx, schema, key);
        const problems: string[] = [];
        if (state === null) {
          if (entries.length > 0) problems.push("ژورنال بدون حساب.");
          return { exists: false, ok: problems.length === 0, journalEntries: entries.length, problems };
        }
        problems.push(...checkInvariants(state));
        const folded = foldJournal(entries);
        if (!folded.ok) {
          problems.push(`ژورنال ناسازگار است: ${folded.reason}`);
        } else {
          const f = folded.value;
          if (f.available !== state.available) problems.push("بازپخش ژورنال: available با حالت نمی‌خواند.");
          if (f.held !== state.held) problems.push("بازپخش ژورنال: held با حالت نمی‌خواند.");
          for (const k of ["granted", "charged", "forfeited", "refunded", "shortfall"] as const) {
            if (f.totals[k] !== state.totals[k]) problems.push(`بازپخش ژورنال: totals.${k} با حالت نمی‌خواند.`);
          }
          if (f.seq !== state.seq) problems.push("بازپخش ژورنال: seq با حالت نمی‌خواند.");
        }
        return { exists: true, ok: problems.length === 0, journalEntries: entries.length, problems };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    return { ok: true, value: report };
  } catch (e) {
    return { ok: false, error: toStoreError(e).error };
  }
}

/**
 * آزمون قرارداد پورت `AccountStore` (ADR-0018 §۹) روی PostgreSQL واقعی — **همان `describeStoreContract` بی‌تغییر**.
 * این آزمون حالت‌های ساختگیِ ناسازگار با بقا (`available: 1` بی‌اعطا) commit می‌کند چون مکانیکِ پورت را می‌سنجد؛
 * پس در این اجرا فقط نگهبان‌های معناییِ فروشگاه و قید بقای شِمای آزمون خاموش‌اند (ADR-0019 تصمیم ۸).
 * همهٔ آزمون‌های دیگر ledger/pg با پیکربندی محصول اجرا می‌شوند.
 */
import { it } from "vitest";
import { describeStoreContract } from "../store-contract";
import { HAS_DB, dbDescribe, openTestLedgerDb } from "./test-db";

if (HAS_DB) {
  describeStoreContract("PostgreSQL", async () => {
    const t = await openTestLedgerDb({ semanticGuards: false, relaxConservation: true });
    return { store: t.store, dispose: t.drop };
  });
} else {
  dbDescribe("ledger/AccountStore · قرارداد · PostgreSQL", () => {
    it("بدون پایگاه اجرا نمی‌شود", () => undefined);
  });
}

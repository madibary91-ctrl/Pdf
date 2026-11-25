/**
 * آداپتور PostgreSQL پورتِ PolicyVersionStore همان آزمونِ قراردادِ ذخیره‌سازِ حافظه‌ای را می‌گذراند (ADR-0069/0070):
 * یک قرارداد، دو پیاده‌سازی. در tooling است چون آزمونِ قرارداد از رابط عمومیِ tool-policy-admin صادر نمی‌شود (قاعدهٔ ۳).
 */
import { describePolicyStoreContract } from "../src/modules/tool-policy-admin/store-contract";
import { dbDescribe, openPgPolicyStore } from "../src/modules/tool-policy-store-pg/test-db";

dbDescribe("tool-policy-store-pg · قرارداد", () => {
  describePolicyStoreContract("PostgreSQL", async () => {
    const h = await openPgPolicyStore({ poolSize: 10 });
    return { store: h.store, dispose: () => h.dispose() };
  });
});

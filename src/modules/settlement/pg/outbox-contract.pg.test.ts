import { describeOutboxContract } from "../outbox-contract";
import { dbDescribe, openPgOutbox } from "./test-db";

/** همان قراردادِ پورت که outbox حافظه‌ای را سنجیده، **بی‌هیچ تغییری** روی PostgreSQL واقعی (اتصال‌های جدا ⇒ مسابقه‌های واقعی). */
dbDescribe("settlement/pg", () => {
  describeOutboxContract("postgres", async () => {
    const t = await openPgOutbox();
    return { outbox: t.outbox, dispose: t.dispose };
  });
});

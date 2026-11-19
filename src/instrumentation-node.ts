/**
 * ترکیبِ سمتِ Node برای رفتگرِ تسویه (ADR-0033). تنها جایی که `process.env`، `globalThis`، `console` و `@/db` کنار هم می‌آیند؛
 * سیاست (env، بوتِ بی‌مسدودی، خاموشی) همه در ماژول‌های آزموده است.
 *  - پیش‌فرضِ `SETTLEMENT_HOST` خاموش است ⇒ بدونِ تنظیمِ صریح هیچ رفتگر/اتصالِ تازه‌ای نیست و رفتارِ امروز بی‌تغییر می‌ماند.
 *  - صاحبِ خروجِ فرایند: اگر `NEXT_MANUAL_SIG_HANDLE` تنظیم باشد (Next دیگر سیگنال نمی‌گیرد) ما `exit` می‌زنیم، وگرنه Next
 *    (همان شرطِ `start-server.js`: درستیِ رشته، نه مقدارِ آن).
 */
import { startSettlementBootstrap } from "@/modules/settlement-bootstrap";
import type { BootstrapEvent } from "@/modules/settlement-bootstrap";

export async function registerSettlement(): Promise<void> {
  await startSettlementBootstrap({
    env: process.env,
    store: globalThis,
    processOwner: process.env.NEXT_MANUAL_SIG_HANDLE ? "host" : "next",
    openDatabase: async () => {
      const { db, pool } = await import("@/db");
      return { db, close: () => pool.end() };
    },
    log: (event: BootstrapEvent) => console.log(JSON.stringify({ scope: "settlement", ...event })),
  });
}

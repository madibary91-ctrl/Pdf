/**
 * ترکیبِ سمتِ Node برای میزبانِ سیاستِ ابزار (ADR-0076). تنها جایی که `process.env`، `globalThis`، `console` و `@/db` برای سیاست کنار هم می‌آیند؛
 * سیاست (env، بوتِ بی‌مسدودی، خاموشی) همه در `tool-policy-bootstrap` آزموده است.
 *  - پیش‌فرضِ `TOOL_POLICY_HOST` خاموش است ⇒ بدونِ تنظیمِ صریح هیچ میزبان/اتصالِ تازه‌ای نیست و رفتارِ امروز بی‌تغییر می‌ماند.
 *  - صاحبِ خروجِ فرایند مثلِ تسویه: `NEXT_MANUAL_SIG_HANDLE` تنظیم‌شده ⇒ ما (با خروجِ هماهنگ با میزبانِ تسویه)، وگرنه Next.
 */
import { startToolPolicyBootstrap } from "@/modules/tool-policy-bootstrap";
import type { BootstrapEvent } from "@/modules/tool-policy-bootstrap";
import { openSharedDatabase, sharedExit } from "./instrumentation-shared";

export async function registerToolPolicy(): Promise<void> {
  await startToolPolicyBootstrap({
    env: process.env,
    store: globalThis,
    processOwner: process.env.NEXT_MANUAL_SIG_HANDLE ? "host" : "next",
    exit: sharedExit,
    openDatabase: openSharedDatabase,
    log: (event: BootstrapEvent) => console.log(JSON.stringify({ scope: "tool-policy", ...event })),
  });
}

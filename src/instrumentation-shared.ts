/**
 * بخشِ مشترکِ گلوی Node (ADR-0076 تصمیم ۶–۷): استخرِ اجاره‌ایِ `@/db` و خروجِ هماهنگِ فرایند برای هر دو میزبانِ فرایندی (تسویه، سیاستِ ابزار).
 * منطق در `src/db/pool-lease.ts` و `src/process-exit.ts` آزموده می‌شود؛ این‌جا فقط سیم‌کشی است.
 */
import { acquirePoolLease } from "@/db/pool-lease";
import { createNodeExit, getSettlementHost } from "@/modules/settlement-host";
import { getToolPolicyHost } from "@/modules/tool-policy-host";
import { createCoordinatedExit } from "./process-exit";

/** پایگاهِ برنامه با اجارهٔ شمارشی؛ `@/db` تنبل بارگذاری می‌شود (پیش‌فرضِ خاموش اتصال نمی‌سازد). */
export async function openSharedDatabase(): Promise<{ db: unknown; close: () => Promise<void>; release: () => void }> {
  const { db, pool } = await import("@/db");
  const lease = acquirePoolLease(pool);
  return { db, close: () => lease.close(), release: () => lease.release() };
}

const stopping = (host: { status(): { state: string } } | null): boolean => host !== null && host.status().state === "stopping";

/** خروجِ هماهنگ: فقط وقتی هیچ میزبانِ هم‌تایی در حالِ خاموشی نیست فرایند را می‌بُرد. */
export const sharedExit: (code: number) => void = createCoordinatedExit(createNodeExit(), () => stopping(getSettlementHost(globalThis)) || stopping(getToolPolicyHost(globalThis)));

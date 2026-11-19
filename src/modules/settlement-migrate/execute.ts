/**
 * هستهٔ `status`/`up` روی دو فروشگاهِ تزریقی (داخلی؛ ADR-0034 تصمیم ۳). بی‌پرتاب و بی‌I/O مستقیم.
 * ناورداها:
 *  ۱. **ترتیبِ ثابتِ دفتر ← outbox** برای هر دو فرمان؛ outbox به دفتر وابسته است (ADR-0021/0022).
 *  ۲. **`check` پیش از هر نوشتن:** هر دو فروشگاه فقط‌خواندنی سنجیده می‌شوند. ناهمخوانی (`SCHEMA_MISMATCH`) یا در دسترس‌نبودن ⇒ **هیچ مهاجرتی اعمال نمی‌شود**
 *     (وگرنه دفتر مهاجرت می‌شد و outbox دست‌کاری‌شده رد می‌شد: وضعیتِ نیمه‌کاره‌ای که قابل‌پیشگیری بود).
 *  ۳. **بی‌کاری = بی‌نوشتن:** فروشگاهِ بی‌مهاجرتِ معلق `migrate()` نمی‌شود (نه قفل، نه تراکنشِ DDL).
 *  ۴. **راستی‌آزمایی پس از اعمال:** برای هر فروشگاهِ مهاجرت‌شده وضعیت دوباره خوانده می‌شود؛ معلقِ باقی‌مانده ⇒ `MIGRATION_FAILED` (هرگز «ok» بر پایهٔ ادعای `migrate()`).
 *  ۵. هر خروجیِ فروشگاه اعتبارسنجی می‌شود؛ شکلِ ناشناخته ⇒ `INTERNAL` (بسته)، نه حدس.
 *  ۶. پیامِ خطای فروشگاه هرگز خوانده نمی‌شود؛ فقط `code` و SQLSTATE.
 *  ۷. پس از مهلتِ کل (`progress.cancelled`) هیچ فراخوانیِ تازه‌ای به فروشگاه زده نمی‌شود.
 *  ۸. **بازتلاشِ کران‌دارِ هم‌زمانیِ بی‌خطر:** `migrate()` اتمیک و idempotent است؛ شکستِ آن با SQLSTATEِ هم‌زمانی (`23505` مسابقهٔ `CREATE SCHEMA IF NOT EXISTS`
 *     روی کشِ کاتالوگِ کهنه پس از قفلِ مشورتی، `40001`، `40P01`) یعنی فرایندِ هم‌زمانِ دیگری برنده شد و این تراکنش کاملاً برگشت؛ تا `APPLY_ATTEMPTS` بار تکرار می‌شود
 *     (تکرار وضعیتِ اعمال‌شده را می‌بیند). هر خطای دیگر (از جمله `42501`، `42710`) هرگز تکرار نمی‌شود. نشانهٔ `retries` در گزارش می‌آید.
 */
import { classifyApply, classifyRead, type Classified } from "./exit-codes";
import type { MigratableStore, MigrateCode, MigrateCommandName, MigratePhase, MigrateStage, StoreState } from "./types";

export type Progress = {
  phase: MigratePhase;
  stage: MigrateStage | undefined;
  ledger: StoreState | undefined;
  settlement: StoreState | undefined;
  /** پس از مهلتِ کل `true` می‌شود: اجرای رهاشده پیش از هر فراخوانیِ تازهٔ فروشگاه می‌ایستد (پس از مهلت، هیچ مهاجرتِ تازه‌ای شروع نمی‌شود). */
  cancelled: boolean;
  /** شمارِ بازتلاش‌های apply در این اجرا (برای گزارش). */
  retries: number;
};

export type Verdict = Readonly<{ code: MigrateCode; phase: MigratePhase; stage?: MigrateStage; pgCode?: string }>;

export const APPLY_ATTEMPTS = 3;
/** SQLSTATEهای «مسابقهٔ هم‌زمانی»: برنده‌ای دیگر هست و تراکنشِ ما برگشت. */
const RETRYABLE_SQLSTATE: ReadonlySet<string> = new Set(["23505", "40001", "40P01"]);
const STAGES = ["ledger", "settlement"] as const;
const SEVERITY: Readonly<Record<MigrateCode, number>> = { OK: 0, PENDING: 1, SCHEMA_MISMATCH: 2, MIGRATION_FAILED: 3, UNAVAILABLE: 4, TIMEOUT: 5, USAGE: 5, INTERNAL: 6 };

const isNames = (v: unknown): v is readonly string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const INTERNAL: Classified = { code: "INTERNAL" };

type Read = Readonly<{ ok: true; applied: readonly string[]; pending: readonly string[] }> | Readonly<{ ok: false; error: unknown }>;

/** `status()` را می‌خواند و شکلش را می‌سنجد؛ خطا را خام برمی‌گرداند تا مرحله نگاشتش را انتخاب کند. */
async function readStatus(store: MigratableStore): Promise<Read | "malformed"> {
  try {
    const r: unknown = await store.status();
    if (typeof r !== "object" || r === null) return "malformed";
    const rec = r as { ok?: unknown; value?: unknown; error?: unknown };
    if (rec.ok === false) return { ok: false, error: rec.error };
    if (rec.ok !== true || typeof rec.value !== "object" || rec.value === null) return "malformed";
    const v = rec.value as { applied?: unknown; pending?: unknown };
    if (!isNames(v.applied) || !isNames(v.pending)) return "malformed";
    return { ok: true, applied: Object.freeze([...v.applied]), pending: Object.freeze([...v.pending]) };
  } catch {
    return "malformed";
  }
}

const asStoreError = (e: unknown): { code?: unknown; pgCode?: unknown } => (typeof e === "object" && e !== null ? (e as { code?: unknown; pgCode?: unknown }) : {});

function classifyError(e: unknown, how: (error: never) => Classified): Classified {
  const rec = asStoreError(e);
  return typeof rec.code === "string" ? how(rec as never) : INTERNAL;
}

function retryable(e: unknown): boolean {
  const rec = asStoreError(e);
  return typeof rec.pgCode === "string" && RETRYABLE_SQLSTATE.has(rec.pgCode) && (rec.code === "COMMIT_REJECTED" || rec.code === "DB_ERROR");
}

const state = (applied: readonly string[], pending: readonly string[], appliedNow: readonly string[]): StoreState => Object.freeze({ applied, pending, appliedNow: Object.freeze([...appliedNow]) });

function fail(progress: Progress, c: Classified): Verdict {
  return Object.freeze({ code: c.code, phase: progress.phase, ...(progress.stage === undefined ? {} : { stage: progress.stage }), ...(c.pgCode === undefined ? {} : { pgCode: c.pgCode }) });
}

export async function execute(command: MigrateCommandName, stores: Readonly<Record<MigrateStage, MigratableStore>>, progress: Progress): Promise<Verdict> {
  // ── check: هر دو فروشگاه، فقط‌خواندنی، پیش از هر نوشتن ──
  progress.phase = "check";
  let worst: Readonly<{ c: Classified; stage: MigrateStage }> | null = null;
  for (const stage of STAGES) {
    if (progress.cancelled) return fail(progress, { code: "TIMEOUT" });
    progress.stage = stage;
    const r = await readStatus(stores[stage]);
    if (r !== "malformed" && r.ok) {
      progress[stage] = state(r.applied, r.pending, []);
      continue;
    }
    const c = r === "malformed" ? INTERNAL : classifyError(r.error, classifyRead);
    if (worst === null || SEVERITY[c.code] > SEVERITY[worst.c.code]) worst = { c, stage };
  }
  if (worst !== null) {
    progress.stage = worst.stage;
    return fail(progress, worst.c);
  }
  progress.stage = undefined;
  const anyPending = STAGES.some((s) => (progress[s] as StoreState).pending.length > 0);
  if (command === "status") return Object.freeze({ code: anyPending ? ("PENDING" as const) : ("OK" as const), phase: "check" as const });
  if (!anyPending) return Object.freeze({ code: "OK" as const, phase: "check" as const });

  // ── apply: دفتر ← outbox؛ فقط فروشگاه‌های دارای معلق ──
  progress.phase = "apply";
  const touched: MigrateStage[] = [];
  for (const stage of STAGES) {
    const before = progress[stage] as StoreState;
    if (before.pending.length === 0) continue;
    if (progress.cancelled) return fail(progress, { code: "TIMEOUT" });
    progress.stage = stage;
    touched.push(stage);
    let rec: { ok?: unknown; value?: unknown; error?: unknown };
    for (let attempt = 1; ; attempt++) {
      let r: unknown;
      try {
        r = await stores[stage].migrate();
      } catch {
        return fail(progress, INTERNAL);
      }
      rec = typeof r === "object" && r !== null ? (r as { ok?: unknown; value?: unknown; error?: unknown }) : {};
      if (rec.ok === false && attempt < APPLY_ATTEMPTS && retryable(rec.error)) {
        progress.retries++;
        if (progress.cancelled) return fail(progress, { code: "TIMEOUT" });
        continue;
      }
      break;
    }
    if (rec.ok === false) return fail(progress, classifyError(rec.error, classifyApply));
    const applied = typeof rec.value === "object" && rec.value !== null ? (rec.value as { applied?: unknown }).applied : undefined;
    if (rec.ok !== true || !isNames(applied)) return fail(progress, INTERNAL);
    progress[stage] = state([...before.applied, ...applied], before.pending.filter((n) => !applied.includes(n)), applied);
  }

  // ── verify: وضعیتِ واقعیِ پس از اعمال ──
  progress.phase = "verify";
  for (const stage of touched) {
    if (progress.cancelled) return fail(progress, { code: "TIMEOUT" });
    progress.stage = stage;
    const now = (progress[stage] as StoreState).appliedNow;
    const r = await readStatus(stores[stage]);
    if (r === "malformed") return fail(progress, INTERNAL);
    if (!r.ok) return fail(progress, classifyError(r.error, classifyApply));
    progress[stage] = state(r.applied, r.pending, now);
    if (r.pending.length > 0) return fail(progress, { code: "MIGRATION_FAILED" });
  }
  progress.stage = undefined;
  return Object.freeze({ code: "OK" as const, phase: "verify" as const });
}

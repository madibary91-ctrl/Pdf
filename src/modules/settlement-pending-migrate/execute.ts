/**
 * هستهٔ `status`/`up`/`verify` روی یک نمایهٔ تزریقی (داخلی؛ ADR-0047 تصمیم ۳). بی‌پرتاب و بی‌I/O مستقیم.
 * ناورداها:
 *  ۱. **`check` پیش از هر نوشتن:** وضعیتِ دفتر فقط‌خواندنی سنجیده می‌شود؛ ناهمخوانی (`SCHEMA_MISMATCH`) یا در دسترس‌نبودن ⇒ **هیچ مهاجرتی اعمال نمی‌شود**.
 *  ۲. **بی‌کاری = بی‌نوشتن:** نمایهٔ بی‌مهاجرتِ معلق `migrate()` نمی‌شود (نه قفل، نه backfill، نه TRIGGER). `up` روی نصبِ کامل بی‌اثر و سبک است (verify سنگین نمی‌زند؛ آن فرمانِ جدا است).
 *  ۳. **راستی‌آزمایی پس از اعمال (دو لایه):** وضعیتِ دفتر دوباره خوانده می‌شود (معلقِ باقی‌مانده ⇒ `MIGRATION_FAILED`) و سپس `verify()` نمایه را با حقیقت می‌سنجد
 *     (`missing`/`stale` > ۰ ⇒ `INCONSISTENT`). هرگز «ok» بر پایهٔ ادعای `migrate()`؛ و `consistent` ادعاییِ فروشگاه با شمارش‌ها **دوباره محاسبه** می‌شود.
 *  ۴. هر خروجیِ فروشگاه اعتبارسنجی می‌شود؛ شکلِ ناشناخته ⇒ `INTERNAL` (بسته)، نه حدس.
 *  ۵. پیامِ خطای فروشگاه هرگز خوانده نمی‌شود؛ فقط `code` و SQLSTATE.
 *  ۶. پس از مهلتِ کل (`progress.cancelled`) هیچ فراخوانیِ تازه‌ای به فروشگاه زده نمی‌شود.
 *  ۷. **بازتلاشِ کران‌دار فقط برای بن‌بست/ناسازگاریِ سریال‌سازی** (`40P01`، `40001`): تراکنشِ apply کاملاً برگشته و تکرارش امن است. `55P03` (قفل در ۱۵ثانیه به دست نیامد)
 *     عمداً **هرگز** تکرار نمی‌شود: هر تلاش نویسنده‌های پول را دوباره در صف می‌گذارد؛ تصمیمِ تکرار با اپراتور (پنجرهٔ کم‌ترافیک) است. `23505` هم نیست
 *     (مسابقهٔ ساختِ دفتر پشتِ قفلِ مشورتی ناممکن است؛ ریشه‌اش در settlement-migrate است و همان‌جا می‌ماند).
 */
import { classifyApply, classifyRead, classifyVerify, type Classified } from "./exit-codes";
import type { MigrationState, PendingCommandName, PendingMigratable, PendingMigrateCode, PendingPhase } from "./types";
import type { PendingVerifyReport } from "@/modules/settlement-pending";

export type Progress = {
  phase: PendingPhase;
  migrations: MigrationState | undefined;
  verify: PendingVerifyReport | undefined;
  /** پس از مهلتِ کل `true` می‌شود: اجرای رهاشده پیش از هر فراخوانیِ تازهٔ فروشگاه می‌ایستد. */
  cancelled: boolean;
  /** شمارِ بازتلاش‌های apply در این اجرا (برای گزارش). */
  retries: number;
};

export type Verdict = Readonly<{ code: PendingMigrateCode; phase: PendingPhase; pgCode?: string }>;

export const APPLY_ATTEMPTS = 3;
/** SQLSTATEهای «تراکنش برگشت و تکرارش بی‌خطر است»: بن‌بست و ناسازگاریِ سریال‌سازی. */
const RETRYABLE_SQLSTATE: ReadonlySet<string> = new Set(["40001", "40P01"]);

const isNames = (v: unknown): v is readonly string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const INTERNAL: Classified = { code: "INTERNAL" };

type Rec = { ok?: unknown; value?: unknown; error?: unknown };
const asRec = (r: unknown): Rec | null => (typeof r === "object" && r !== null ? (r as Rec) : null);
const asStoreError = (e: unknown): { code?: unknown; pgCode?: unknown } => (typeof e === "object" && e !== null ? (e as { code?: unknown; pgCode?: unknown }) : {});

function classifyError(e: unknown, how: (error: never) => Classified): Classified {
  const rec = asStoreError(e);
  return typeof rec.code === "string" ? how(rec as never) : INTERNAL;
}

function retryable(e: unknown): boolean {
  const rec = asStoreError(e);
  return typeof rec.pgCode === "string" && RETRYABLE_SQLSTATE.has(rec.pgCode) && (rec.code === "COMMIT_REJECTED" || rec.code === "DB_ERROR");
}

type Read = Readonly<{ ok: true; applied: readonly string[]; pending: readonly string[] }> | Readonly<{ ok: false; error: unknown }>;

/** `status()` را می‌خواند و شکلش را می‌سنجد؛ خطا را خام برمی‌گرداند تا مرحله نگاشتش را انتخاب کند. */
async function readStatus(index: PendingMigratable): Promise<Read | "malformed"> {
  try {
    const r = asRec(await index.status());
    if (r === null) return "malformed";
    if (r.ok === false) return { ok: false, error: r.error };
    if (r.ok !== true || typeof r.value !== "object" || r.value === null) return "malformed";
    const v = r.value as { applied?: unknown; pending?: unknown };
    if (!isNames(v.applied) || !isNames(v.pending)) return "malformed";
    return { ok: true, applied: Object.freeze([...v.applied]), pending: Object.freeze([...v.pending]) };
  } catch {
    return "malformed";
  }
}

type Verified = Readonly<{ ok: true; report: PendingVerifyReport }> | Readonly<{ ok: false; error: unknown }>;

/** `verify()` را می‌خواند و شکلش را سخت می‌سنجد؛ `consistent` از شمارش‌ها دوباره محاسبه و با ادعا مقایسه می‌شود. */
async function readVerify(index: PendingMigratable): Promise<Verified | "malformed"> {
  try {
    const r = asRec(await index.verify());
    if (r === null) return "malformed";
    if (r.ok === false) return { ok: false, error: r.error };
    if (r.ok !== true || typeof r.value !== "object" || r.value === null) return "malformed";
    const v = r.value as Partial<Record<keyof PendingVerifyReport, unknown>>;
    if (typeof v.consistent !== "boolean" || !isCount(v.expected) || !isCount(v.indexed) || !isCount(v.missing) || !isCount(v.stale)) return "malformed";
    if (v.consistent !== (v.missing === 0 && v.stale === 0)) return "malformed";
    return { ok: true, report: Object.freeze({ consistent: v.consistent, expected: v.expected, indexed: v.indexed, missing: v.missing, stale: v.stale }) };
  } catch {
    return "malformed";
  }
}

const state = (applied: readonly string[], pending: readonly string[], appliedNow: readonly string[]): MigrationState => Object.freeze({ applied, pending, appliedNow: Object.freeze([...appliedNow]) });

function fail(progress: Progress, c: Classified): Verdict {
  return Object.freeze({ code: c.code, phase: progress.phase, ...(c.pgCode === undefined ? {} : { pgCode: c.pgCode }) });
}

/** راستی‌آزماییِ نمایه در برابر حقیقت (فاز `verify`)؛ `how` نگاشتِ خطاست. */
async function checkIndex(index: PendingMigratable, progress: Progress, how: (error: never) => Classified): Promise<Verdict> {
  progress.phase = "verify";
  if (progress.cancelled) return fail(progress, { code: "TIMEOUT" });
  const v = await readVerify(index);
  if (v === "malformed") return fail(progress, INTERNAL);
  if (!v.ok) return fail(progress, classifyError(v.error, how));
  progress.verify = v.report;
  return Object.freeze({ code: v.report.consistent ? ("OK" as const) : ("INCONSISTENT" as const), phase: "verify" as const });
}

export async function execute(command: PendingCommandName, index: PendingMigratable, progress: Progress): Promise<Verdict> {
  // ── check: فقط‌خواندنی، پیش از هر نوشتن ──
  progress.phase = "check";
  if (progress.cancelled) return fail(progress, { code: "TIMEOUT" });
  const first = await readStatus(index);
  if (first === "malformed") return fail(progress, INTERNAL);
  if (!first.ok) return fail(progress, classifyError(first.error, classifyRead));
  progress.migrations = state(first.applied, first.pending, []);
  const pending = first.pending.length > 0;

  if (command === "status") return Object.freeze({ code: pending ? ("PENDING" as const) : ("OK" as const), phase: "check" as const });
  if (command === "verify") {
    if (pending) return Object.freeze({ code: "PENDING" as const, phase: "check" as const });
    return checkIndex(index, progress, classifyRead);
  }
  if (!pending) return Object.freeze({ code: "OK" as const, phase: "check" as const });

  // ── apply: یک تراکنشِ یکپارچه (قفل‌ها، TRIGGER، backfill، نگهبان) ──
  progress.phase = "apply";
  let rec: Rec;
  for (let attempt = 1; ; attempt++) {
    // پس از مهلتِ کل هیچ مهاجرتِ تازه‌ای شروع نمی‌شود (اجرای رهاشده‌ای که status دیر برگشت، نباید پشتِ سرِ اپراتور backfill بزند).
    if (progress.cancelled) return fail(progress, { code: "TIMEOUT" });
    let r: unknown;
    try {
      r = await index.migrate();
    } catch {
      return fail(progress, INTERNAL);
    }
    rec = asRec(r) ?? {};
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
  progress.migrations = state([...first.applied, ...applied], first.pending.filter((n) => !applied.includes(n)), applied);

  // ── verify: وضعیتِ واقعیِ دفتر، سپس نمایه در برابر حقیقت ──
  progress.phase = "verify";
  if (progress.cancelled) return fail(progress, { code: "TIMEOUT" });
  const now = progress.migrations.appliedNow;
  const again = await readStatus(index);
  if (again === "malformed") return fail(progress, INTERNAL);
  if (!again.ok) return fail(progress, classifyError(again.error, classifyVerify));
  progress.migrations = state(again.applied, again.pending, now);
  if (again.pending.length > 0) return fail(progress, { code: "MIGRATION_FAILED" });
  return checkIndex(index, progress, classifyVerify);
}

/**
 * هستهٔ `status`/`up` روی یک فروشگاهِ تزریقی (داخلی؛ ADR-0080 تصمیم ۳). بی‌پرتاب و بی‌I/O مستقیم.
 * ناورداها:
 *  ۱. **`check` پیش از هر نوشتن:** فروشگاه فقط‌خواندنی سنجیده می‌شود. ناهمخوانی (`SCHEMA_MISMATCH`)، در دسترس‌نبودن یا نبودنِ شِمایی که اجازهٔ ساختنش نیست ⇒ **هیچ نوشتنی نمی‌شود**.
 *  ۲. **بی‌کاری = بی‌نوشتن:** فروشگاهِ آماده (`ready`) نه شِما می‌سازد نه `migrate()` می‌شود (نه قفل، نه تراکنشِ DDL).
 *  ۳. **ساختنِ شِما فقط با `--create-schema` و فقط وقتی نیست** (`CREATE SCHEMA IF NOT EXISTS`)؛ بدونِ آن، `up` روی شِمای ناموجود `SCHEMA_MISSING` می‌دهد و هیچ نمی‌نویسد.
 *  ۴. **راستی‌آزمایی پس از اعمال:** وضعیت دوباره خوانده می‌شود؛ هر چیزی جز `ready` ⇒ `MIGRATION_FAILED` (هرگز «ok» بر پایهٔ ادعای `migrate()`).
 *  ۵. هر خروجیِ فروشگاه اعتبارسنجی می‌شود؛ شکلِ ناشناخته ⇒ `INTERNAL` (بسته)، نه حدس.
 *  ۶. پیامِ خطای فروشگاه هرگز خوانده نمی‌شود؛ فقط `code` و SQLSTATE.
 *  ۷. پس از مهلتِ کل (`progress.cancelled`) هیچ فراخوانیِ تازه‌ای به فروشگاه زده نمی‌شود.
 *  ۸. **بازتلاشِ کران‌دارِ هم‌زمانیِ بی‌خطر** برای ساختنِ شِما و `migrate()` (هر دو idempotent و اتمیک): SQLSTATEِ `23505`، `40001`، `40P01` یعنی فرایندِ هم‌زمانِ دیگری برنده شد
 *     و این عملیات کاملاً برگشت؛ تا `APPLY_ATTEMPTS` بار. هر خطای دیگر (از جمله `42501`) هرگز تکرار نمی‌شود. نشانهٔ `retries` در گزارش می‌آید.
 */
import { classifyApply, classifyRead, type Classified } from "./exit-codes";
import type { MigratableStore, MigrateCode, MigrateCommandName, MigratePhase, PolicyState } from "./types";

export type Progress = {
  phase: MigratePhase;
  state: PolicyState | undefined;
  schemaCreated: boolean;
  /** پس از مهلتِ کل `true` می‌شود: اجرای رهاشده پیش از هر فراخوانیِ تازهٔ فروشگاه می‌ایستد. */
  cancelled: boolean;
  /** شمارِ بازتلاش‌های schema/apply در این اجرا (برای گزارش). */
  retries: number;
};

export type Verdict = Readonly<{ code: MigrateCode; phase: MigratePhase; pgCode?: string }>;

export const APPLY_ATTEMPTS = 3;
/** SQLSTATEهای «مسابقهٔ هم‌زمانی»: برنده‌ای دیگر هست و عملیاتِ ما برگشت. */
const RETRYABLE_SQLSTATE: ReadonlySet<string> = new Set(["23505", "40001", "40P01"]);
const INTERNAL: Classified = { code: "INTERNAL" };

const isNames = (v: unknown): v is readonly string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const asError = (e: unknown): { code?: unknown; pgCode?: unknown } => (isObj(e) ? e : {});

function toState(value: unknown, appliedNow: readonly string[]): PolicyState | null {
  if (!isObj(value)) return null;
  const { schemaExists, applied, pending, problems, rows, latestVersion, contiguous, ready } = value;
  if (typeof schemaExists !== "boolean" || !isNames(applied) || !isNames(pending) || !Array.isArray(problems)) return null;
  if (typeof rows !== "number" || !Number.isSafeInteger(rows) || rows < 0) return null;
  if (latestVersion !== null && !(typeof latestVersion === "number" && Number.isSafeInteger(latestVersion) && latestVersion >= 0)) return null;
  if (typeof contiguous !== "boolean" || typeof ready !== "boolean") return null;
  return Object.freeze({
    schemaExists,
    applied: Object.freeze([...applied]),
    pending: Object.freeze([...pending]),
    appliedNow: Object.freeze([...appliedNow]),
    rows,
    latestVersion: latestVersion as number | null,
    contiguous,
    problemCount: problems.length,
    ready,
  });
}

type Read = Readonly<{ ok: true; state: PolicyState }> | Readonly<{ ok: false; error: unknown }>;

/** `status()` را می‌خواند و شکلش را می‌سنجد؛ خطا را خام برمی‌گرداند تا مرحله نگاشتش را انتخاب کند. */
async function readStatus(store: MigratableStore, appliedNow: readonly string[]): Promise<Read | "malformed"> {
  try {
    const r: unknown = await store.status();
    if (!isObj(r)) return "malformed";
    if (r["ok"] === false) return { ok: false, error: r["error"] };
    if (r["ok"] !== true) return "malformed";
    const state = toState(r["value"], appliedNow);
    return state === null ? "malformed" : { ok: true, state };
  } catch {
    return "malformed";
  }
}

function retryable(e: unknown): boolean {
  const rec = asError(e);
  return typeof rec.pgCode === "string" && RETRYABLE_SQLSTATE.has(rec.pgCode) && rec.code === "DB_ERROR";
}

const verdict = (progress: Progress, c: Classified): Verdict => Object.freeze({ code: c.code, phase: progress.phase, ...(c.pgCode === undefined ? {} : { pgCode: c.pgCode }) });

type Attempt<T> = Readonly<{ kind: "ok"; value: T }> | Readonly<{ kind: "error"; error: unknown }> | Readonly<{ kind: "cancelled" }> | Readonly<{ kind: "malformed" }>;

/** عملیاتِ idempotent را با بازتلاشِ کران‌دارِ مسابقهٔ هم‌زمانی اجرا می‌کند؛ `check` شکلِ نتیجه را می‌سنجد (نادرست ⇒ `malformed`). */
async function attempt<T>(progress: Progress, op: () => Promise<unknown>, pick: (value: unknown) => T | null): Promise<Attempt<T>> {
  for (let n = 1; n <= APPLY_ATTEMPTS; n++) {
    if (progress.cancelled) return { kind: "cancelled" };
    let r: unknown;
    try {
      r = await op();
    } catch {
      return { kind: "malformed" };
    }
    if (!isObj(r)) return { kind: "malformed" };
    if (r["ok"] === true) {
      const picked = pick(r["value"]);
      return picked === null ? { kind: "malformed" } : { kind: "ok", value: picked };
    }
    if (r["ok"] !== false) return { kind: "malformed" };
    if (n < APPLY_ATTEMPTS && retryable(r["error"])) {
      progress.retries++;
      continue;
    }
    return { kind: "error", error: r["error"] };
  }
  return { kind: "malformed" };
}

export async function execute(command: MigrateCommandName, createSchema: boolean, store: MigratableStore, progress: Progress): Promise<Verdict> {
  // ── check: فقط‌خواندنی، پیش از هر نوشتن ──
  progress.phase = "check";
  if (progress.cancelled) return verdict(progress, { code: "TIMEOUT" });
  const first = await readStatus(store, []);
  if (first === "malformed") return verdict(progress, INTERNAL);
  if (!first.ok) return verdict(progress, classifyRead(first.error));
  progress.state = first.state;
  const s0 = first.state;
  if (s0.ready) return verdict(progress, { code: "OK" });
  const needsApply = !s0.schemaExists || s0.pending.length > 0;
  if (!needsApply) return verdict(progress, { code: "SCHEMA_MISMATCH" }); // همهٔ مهاجرت‌ها اعمال، ولی قید/تریگر/بی‌شکافی نمی‌خواند؛ با نوشتن درست نمی‌شود.
  if (command === "status") return verdict(progress, { code: "PENDING" });

  // ── schema: فقط با --create-schema و فقط وقتی نیست ──
  if (!s0.schemaExists) {
    if (!createSchema) return verdict(progress, { code: "SCHEMA_MISSING" });
    progress.phase = "schema";
    const made = await attempt(progress, () => store.createSchema(), (v) => (v === null ? true : null));
    if (made.kind === "cancelled") return verdict(progress, { code: "TIMEOUT" });
    if (made.kind === "malformed") return verdict(progress, INTERNAL);
    if (made.kind === "error") return verdict(progress, classifyApply(made.error));
    progress.schemaCreated = true;
  }

  // ── apply ──
  progress.phase = "apply";
  const applied = await attempt(progress, () => store.migrate(), (v) => (isObj(v) && isNames(v["applied"]) && isNames(v["alreadyApplied"]) ? [...(v["applied"] as readonly string[])] : null));
  if (applied.kind === "cancelled") return verdict(progress, { code: "TIMEOUT" });
  if (applied.kind === "malformed") return verdict(progress, INTERNAL);
  if (applied.kind === "error") return verdict(progress, classifyApply(applied.error));
  const appliedNow = applied.value;

  // ── verify: خواندنِ دوباره؛ هر چیزی جز «آماده» ناموفق است ──
  progress.phase = "verify";
  if (progress.cancelled) return verdict(progress, { code: "TIMEOUT" });
  const again = await readStatus(store, appliedNow);
  if (again === "malformed") return verdict(progress, INTERNAL);
  if (!again.ok) {
    const c = classifyRead(again.error);
    return verdict(progress, c.code === "PENDING" ? { ...c, code: "MIGRATION_FAILED" } : c);
  }
  progress.state = again.state;
  return verdict(progress, { code: again.state.ready ? "OK" : "MIGRATION_FAILED" });
}

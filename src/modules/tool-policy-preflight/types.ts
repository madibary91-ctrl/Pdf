/**
 * نوع‌های «پیش‌بازرسیِ انتشارِ سیاستِ ابزار» (ADR-0078، برش CT‑5c‑2c‑2b‑2a′). این ماژول فقط **پیش از ثبتِ نسخه** می‌سنجد که همان مسیرِ
 * اجرایی (`tool-policy-binding` + `build`ِ واقعی) آن را می‌پذیرد یا نه. هیچ قیمت، ارز، حساب، کلید، ساعت یا I/O این‌جا نیست.
 */
import type { PolicyProjection, ToolPolicy } from "@/modules/tool-policy";
import type { AdminResult, AppliedVersion, CurrentPolicy, HistoryPage } from "@/modules/tool-policy-admin";

/** مرحلهٔ ردِ پیش‌بازرسی؛ مجموعهٔ بسته. */
export type PreflightStage =
  | "CONFIG_INVALID" // `build` تابع نیست یا گزینه‌ها خواندنی نیستند
  | "INPUT_UNREADABLE" // ورودیِ ادمین JSON‌پذیرِ کوچک و ساده نیست (چرخه، getter پرتاب‌کننده، BigInt، بزرگ‌تر از سقف)
  | "OVERRIDES_INVALID" // `resolveToolPolicy` رد کرد (کران/رابطه)
  | "PROJECTION_INVALID" // نگاشت یا اعتبارسنجیِ مجددِ پیوند رد کرد
  | "BUILD_FAILED"; // `build` پرتاب کرد یا `{ ok: true, value: <شیء> }` نداد

/** `issues` فقط مسیرِ فیلد و کرانِ کد است (از `resolveToolPolicy`)، هرگز مقدارِ ورودی یا متنِ خطای `build`. */
export type PreflightError = Readonly<{
  code: "PREFLIGHT_REJECTED";
  stage: PreflightStage;
  /** متنِ ثابت به‌ازای هر مرحله. */
  message: string;
  issues: readonly string[];
}>;

export type PreflightPassed = Readonly<{
  /** سیاستِ مؤثرِ ژرف‌یخ‌زده که از این بازنویسی‌ها می‌آید. */
  policy: ToolPolicy;
  /** projectionِ بازساخته و یخ‌زده‌ای که پیوند دقیقاً با آن `build` را صدا زد. */
  projection: PolicyProjection;
}>;

export type PreflightResult = Readonly<{ ok: true; value: PreflightPassed }> | Readonly<{ ok: false; error: PreflightError }>;

/** `overrides` ورودیِ ناقابل‌اعتماد است؛ `build` همان تابعِ سازندهٔ محیطِ تولید است (قطعی، همگام، بی‌I/O). */
export type PreflightOptions = Readonly<{
  overrides: unknown;
  build: (projection: PolicyProjection) => unknown;
}>;

export type PreflightedResult<T> = AdminResult<T> | Readonly<{ ok: false; error: PreflightError }>;

/** همان رابطِ `ToolPolicyAdmin` با یک کدِ خطای افزوده روی `set`/`rollbackTo`؛ `current`/`history` بی‌تغییرند. */
export interface PreflightedAdmin {
  set(input: unknown): Promise<PreflightedResult<AppliedVersion>>;
  rollbackTo(input: unknown): Promise<PreflightedResult<AppliedVersion>>;
  current(): Promise<AdminResult<CurrentPolicy>>;
  history(input?: unknown): Promise<AdminResult<HistoryPage>>;
}

export type PreflightedAdminOptions = Readonly<{
  admin: Readonly<{
    set(input: unknown): Promise<AdminResult<AppliedVersion>>;
    rollbackTo(input: unknown): Promise<AdminResult<AppliedVersion>>;
    current(): Promise<AdminResult<CurrentPolicy>>;
    history(input?: unknown): Promise<AdminResult<HistoryPage>>;
  }>;
  build: (projection: PolicyProjection) => unknown;
}>;

export type PreflightConfigError = Readonly<{ code: "INVALID_CONFIG"; message: string; issues: readonly string[] }>;
export type PreflightedAdminResult = Readonly<{ ok: true; value: PreflightedAdmin }> | Readonly<{ ok: false; error: PreflightConfigError }>;

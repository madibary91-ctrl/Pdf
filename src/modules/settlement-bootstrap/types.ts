/**
 * settlement-bootstrap — نوع‌های عمومی (ADR-0033، م۳‑ه‑۳‑ب). این ماژول فقط **مرزِ برنامه** را می‌سازد:
 * سیاستِ محیط (env) ← ساختنِ runtime/host ← بوتِ بی‌مسدودی ← پاسخ‌های HTTP پروب.
 * چرخهٔ عمرِ فرایندی در settlement-host و سیاستِ پول/سلامت در settlement و settlement-runtime می‌ماند.
 */
import type { HostBootResult, HostEvent, SettlementHost, SignalSource } from "@/modules/settlement-host";

/** پیام‌ها و کدها فقط نامِ متغیر/فیلد و کدِ بسته‌اند، هرگز مقدار (حتی اگر رشتهٔ اتصال یا کلید در متغیرِ اشتباه باشد). */
export type BootstrapErrorCode = "INVALID_CONFIG" | "INVALID_ENV" | "STORE_INVALID" | "DATABASE_UNAVAILABLE" | "RUNTIME_INVALID" | "HOST_INVALID";

/**
 * - `off`: پیش‌فرض و شکست‌بسته؛ هیچ رفتگری ساخته یا پایگاهی باز نمی‌شود.
 * - `on`: رفتگر فعال؛ `graceMs` الزامی است (بدونِ پیش‌فرضِ حدسی؛ باید با دفترِ محصول هم‌مقدار باشد، ADR-0023).
 */
export type BootstrapSettings =
  | Readonly<{ enabled: false }>
  | Readonly<{
      enabled: true;
      graceMs: number;
      shutdownTimeoutMs: number | null;
      bootAttempts: number | null;
      bootRetryDelayMs: number | null;
      ledgerSchema: string | null;
      settlementSchema: string | null;
    }>;

export type EnvResult =
  | Readonly<{ ok: true; value: BootstrapSettings }>
  | Readonly<{ ok: false; issues: readonly string[] }>;

/** پایگاهِ بازشده: `db` همان drizzle برنامه؛ `close` فقط پس از توقفِ تمیزِ رفتگر صدا زده می‌شود (مالکِ استخر برنامه است). */
export type OpenedDatabase = Readonly<{ db: unknown; close: () => unknown }>;

/**
 * - `host`: این فرایند سیگنال را می‌گیرد و پس از خاموشیِ مرتب خودش `exit(ok ? 0 : 1)` می‌زند (Next با `NEXT_MANUAL_SIG_HANDLE`).
 * - `next`: Next خودش روی سیگنال `process.exit` می‌زند؛ خاموشیِ ما رقابتی و ممکن است ناتمام بماند (ایمن ولی بی‌ضمانتِ بستنِ استخر).
 */
export type ProcessOwner = "host" | "next";

/** رویدادهای بسته برای لاگ ساختاریافته. هیچ مقدارِ محیط، پیامِ خطای پایگاه یا رشتهٔ اتصالی در آن نیست. */
export type BootstrapEvent =
  | Readonly<{ type: "bootstrap.disabled" }>
  | Readonly<{ type: "bootstrap.started"; created: boolean; processOwner: ProcessOwner }>
  | Readonly<{ type: "bootstrap.failed"; code: BootstrapErrorCode; issues: readonly string[] }>
  | Readonly<{ type: "host"; event: HostEvent }>;

export type BootstrapOutcome =
  | Readonly<{ status: "disabled" }>
  /** `booting`: وعدهٔ بوتِ در جریان (هرگز رد نمی‌شود)؛ `null` وقتی میزبان از پیش بوده و کاری شروع نشده. */
  | Readonly<{ status: "started"; created: boolean; host: SettlementHost; booting: Promise<HostBootResult> | null }>
  | Readonly<{ status: "failed"; code: BootstrapErrorCode; issues: readonly string[] }>;

/** ورودی `unknown` است و روی مرز اعتبارسنجی می‌شود؛ این نوع فقط مستند است. */
export type BootstrapConfig = Readonly<{
  /** نقشهٔ متغیرهای محیط (مثلاً `process.env`)؛ ماژول خودش `process` را نمی‌خواند. */
  env: Readonly<Record<string, string | undefined>>;
  /** ظرفِ singleton (مثلاً `globalThis`). */
  store: unknown;
  /** فقط وقتی `on` و محیط معتبر است و میزبانی از پیش نیست صدا زده می‌شود. */
  openDatabase: () => OpenedDatabase | Promise<OpenedDatabase>;
  processOwner: ProcessOwner;
  log?: (event: BootstrapEvent) => unknown;
  /** فقط برای آزمون: پیش‌فرض‌ها `createNodeTimer()`، `createNodeSignalSource()` و `createNodeExit()`اند. */
  timer?: unknown;
  signals?: SignalSource | false;
  exit?: (code: number) => unknown;
}>;

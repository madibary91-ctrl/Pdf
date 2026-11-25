/**
 * نوع‌های «سقفِ سختِ مهلتِ تماسِ مدل» (ADR-0066، برش MT-2d). این ماژول یک `ToolGateway` را می‌پوشاند و خودش هم `ToolGateway` است؛
 * پس هر جایی که دروازهٔ ابزار می‌گیرد (`metered-tool-gateway`، `durable-tool-gateway`، `tool-runner`) بی‌تغییر آن را می‌پذیرد.
 */
import type { Timers, ToolGateway } from "@/modules/ai-gateway";

export type CallDeadlineOptions = Readonly<{
  /** دروازهٔ ابزارِ درونی (`createToolGateway` یا هر دروازهٔ ساختاراً سازگار). */
  gateway: ToolGateway;
  /** سقفِ سختِ مدتِ هر `completeStep` (میلی‌ثانیه؛ عدد صحیح). **بی‌پیش‌فرض**. با `checkTimingRelations` به `graceMs` و ttl گره می‌خورد. */
  maxCallMs: number;
  /** پیش‌فرض: ساعتِ سیستم. در آزمون تایمرِ مجازی بدهید. */
  timers?: Timers;
  /** ناظرِ اختیاریِ رویدادهای بی‌متن؛ استثنایش بلعیده می‌شود و هرگز نتیجهٔ گام را عوض نمی‌کند. */
  onEvent?: (event: DeadlineEvent) => void;
}>;

/**
 * رویدادهای بی‌متن (فقط عدد و برچسب؛ هرگز پیام، کلید یا پیکربندی):
 * - `deadline`: سقف رسید و تماس لغو شد (هزینه نامعلوم تلقی می‌شود).
 * - `late-result`: تماسِ لغوشده **پس از** سقف جواب داد؛ جواب دورریخته شد ولی هزینهٔ گزارش‌شده‌اش برای مغایرت‌گیریِ دستی/آینده اینجاست.
 */
export type DeadlineEvent =
  | Readonly<{ kind: "deadline"; maxCallMs: number }>
  | Readonly<{ kind: "late-result"; ok: boolean | null; cost: Readonly<{ currency: string; micros: number }> | null }>;

export type CallDeadlineErrorCode = "INVALID_CONFIG";
export type CallDeadlineError = Readonly<{ code: CallDeadlineErrorCode; message: string; issues: readonly string[] }>;
export type CallDeadlineResult = Readonly<{ ok: true; value: ToolGateway }> | Readonly<{ ok: false; error: CallDeadlineError }>;

export type TimingRelationInput = Readonly<{ maxCallMs: unknown; graceMs: unknown; reservationTtlMs: unknown }>;

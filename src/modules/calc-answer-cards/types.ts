/**
 * نوع‌های «کارتِ پاسخِ محاسبه» (ADR-0060، برش CT‑5b). کارت از رویدادِ بی‌واسطهٔ legal-calc (`onResult`) ساخته می‌شود، نه از متنِ مدل.
 * این ماژول فقط جمع‌آوری و ترکیبِ کارت‌ها با گزارشِ اجرا است؛ هیچ عدد/نرخ/سیاستِ حقوقی و هیچ قالب‌بندیِ عددی ندارد.
 */
import type { CalcToolName, JsonValue } from "@/modules/calc-tools";
import type { CalcToolObservation } from "@/modules/calc-tool-executor";
import type { RunReport } from "@/modules/tool-runner";

export type CalcCard = Readonly<{
  /** همان `callId`ی که در `RunReport.toolRuns[].id` است. */
  callId: string;
  tool: CalcToolName;
  /** عنوانِ فارسیِ ثابت برای نمایش. */
  title: string;
  /** عیناً خروجیِ legal-calc (نسخهٔ JSONِ ژرف‌یخ‌زده)؛ رابط آن را نمایش می‌دهد، مدل آن را بازنویسی نمی‌کند. */
  result: JsonValue;
  review: Readonly<{ status: string; reviewedBy: string | null; reviewedOn: string | null }>;
  /** `true` مگر وقتی همهٔ نشانه‌ها (پرچمِ ناظر، وضعیت، بازبین، تاریخ، و رکوردِ اجرا) «تأییدشده» بگویند. */
  reviewPending: boolean;
  /** برچسبِ فارسیِ ثابتِ وضعیتِ بازبینی. */
  reviewLabel: string;
  /** هشدارها و یادداشت‌های فارسیِ legal-calc، عیناً. */
  notes: readonly string[];
}>;

export type CardCollectorOptions = Readonly<{
  /** سقفِ کارت‌ها در یک اجرا؛ **الزامی و بی‌پیش‌فرض** (عدد را مالک می‌دهد؛ معمولاً برابر سقفِ فراخوانیِ tool-loop). */
  maxCards: number;
}>;

export type CardCollectorErrorCode = "INVALID_OPTIONS";
export type CardCollectorError = Readonly<{ code: CardCollectorErrorCode; message: string; issues: readonly string[] }>;

export type ComposeErrorCode = "INVALID_REPORT" | "CARD_MISSING" | "TOOL_MISMATCH" | "DUPLICATE_CALL_ID";
/** پاسخِ ساخته‌نشدنی؛ مصرف‌کننده باید پاسخِ مدل را **نشان ندهد** (نتیجه‌ای که کاربر نمی‌بیند نباید مبنای پاسخ باشد). */
export type ComposeError = Readonly<{ code: ComposeErrorCode; message: string; /** فقط شناسهٔ فراخوانی/نامِ فیلد؛ حداکثر ۱۰ مورد */ issues: readonly string[] }>;

export type ComposedAnswer = Readonly<{
  status: "answered" | "stopped";
  /** متنِ مدل (فقط `answered`)، دست‌نخورده؛ `null` برای `stopped`. */
  text: string | null;
  /** علتِ ایست (فقط `stopped`)، وگرنه `null`. */
  stopReason: string | null;
  abortedBy: RunReport["abortedBy"];
  /** به ترتیبِ اجرا؛ فقط فراخوانی‌هایی که نتیجه‌شان واقعاً به مدل رسید. */
  cards: readonly CalcCard[];
  /** `true` اگر هر نشانه‌ای (کارت، رکوردِ اجرا، نتیجهٔ حلقه) تأییدنشدگی بگوید. */
  reviewPending: boolean;
  /** هشدارهای فارسیِ ثابتِ رابط (ترتیبِ ثابت): تأییدنشدگی، سپس اولویتِ کارت بر متن. */
  notices: readonly string[];
  /** کارت‌هایی که ناظر دید ولی نتیجه به مدل نرسید (مثلاً بزرگ‌تر از سقف) و نمایش داده نشدند. */
  droppedCards: number;
}>;

export type ComposeResult = Readonly<{ ok: true; value: ComposedAnswer }> | Readonly<{ ok: false; error: ComposeError }>;
export type CardCollectorResult = Readonly<{ ok: true; value: CardCollector }> | Readonly<{ ok: false; error: CardCollectorError }>;

export type CardCollector = Readonly<{
  /**
   * همان `onResult` ی که به `createCalcToolExecutor` داده می‌شود. همگام.
   * **عمداً پرتاب می‌کند** (ADR-0059 بند ۵) اگر رویداد نامعتبر، `callId` تکراری یا سقف پر باشد ⇒ مجری `TOOL_FAILED` می‌کند
   * و نتیجه به مدل نمی‌رسد. متنِ استثنا ثابت است و مقدارِ رویداد را بازتاب نمی‌دهد.
   */
  observe(observation: CalcToolObservation): void;
  /** نمونهٔ ژرف‌یخ‌زدهٔ کارت‌های دیده‌شده (به ترتیبِ دیده‌شدن) — برای ممیزی/آزمون. */
  snapshot(): readonly CalcCard[];
  /** ترکیبِ کارت‌ها با گزارشِ `ToolRunner.run`. هرگز پرتاب نمی‌کند. برای هر اجرا یک جمع‌آورندهٔ تازه بسازید. */
  compose(report: unknown): ComposeResult;
}>;

/**
 * نوع‌های «سیاستِ آستانه‌های دروازهٔ ابزار» (ADR-0067، برش CT‑5c‑2a). همهٔ آستانه‌های **مهندسی** (نه حقوقی، نه قیمت) در یک شیءِ یخ‌زدهٔ بخش‌بندی‌شده.
 * هیچ قیمت، ارز، حساب، کلید یا نامِ ارائه‌دهنده اینجا نیست؛ آن‌ها به مالک و ریشهٔ I/O (CT‑5c‑2c) تعلق دارند.
 */

export type OnUnknownCost = "forfeit" | "release";

export type ToolPolicy = Readonly<{
  /** سقف‌های حلقهٔ مدل↔ابزار (`tool-loop`). سقفِ هزینه (`budget`) با ریشهٔ I/O است چون ارز و برآوردگر می‌خواهد. */
  loop: Readonly<{ maxSteps: number; maxToolCalls: number; maxIdenticalCalls: number; truncationRetries: number }>;
  /** مهلت‌ها و سقفِ نتیجهٔ مجری (`tool-runner`). */
  run: Readonly<{ totalTimeoutMs: number; toolTimeoutMs: number; maxResultChars: number }>;
  /** سقفِ پاسخ (`calc-answer-cards` و خروجیِ هر گام). */
  answer: Readonly<{ maxCards: number; maxOutputTokens: number }>;
  /** نامِ **منطقی** در جدولِ مدلِ دروازه (نه نامِ ارائه‌دهنده) و مهلتِ خودِ دروازه برای هر تماس. */
  model: Readonly<{ name: string; timeoutMs: number }>;
  /** زمان‌بندیِ پول: مهلتِ یتیم‌شدنِ رزرو، مهلتِ سختِ تماس و عمرِ رزرو. رابطه‌هایشان در `checkPolicyRelations`. */
  timing: Readonly<{ graceMs: number; maxCallMs: number; reservationTtlMs: number }>;
  /** رزرو و هزینهٔ نامعلوم. */
  metering: Readonly<{ perMessageOverheadTokens: number; onUnknownCost: OnUnknownCost }>;
}>;

/** بازنویسیِ جزئیِ ادمین: هر بخش و هر کلید اختیاری؛ کلیدِ ناشناخته رد می‌شود. */
export type ToolPolicyOverrides = { readonly [S in keyof ToolPolicy]?: Partial<ToolPolicy[S]> };

export type PolicyErrorCode = "INVALID_POLICY" | "INVALID_REQUEST_ID";
/** `issues` فقط مسیرِ فیلد و کرانِ کد را می‌گوید، هرگز مقدارِ ورودی را. */
export type PolicyError = Readonly<{ code: PolicyErrorCode; message: string; issues: readonly string[] }>;
export type PolicyResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: PolicyError }>;

/** ورودیِ رابطه‌ها (همه `unknown`: رابطه‌ها روی مرز هم کار می‌کنند و هرگز نمی‌پرتابند). */
export type PolicyRelationInput = Readonly<{
  maxCallMs: unknown;
  graceMs: unknown;
  reservationTtlMs: unknown;
  modelTimeoutMs: unknown;
  totalTimeoutMs: unknown;
}>;

/** نگاشتِ سیاست به گزینه‌های ماژول‌های پایین‌دست (بی‌`budget`؛ ارز و برآوردگر با ریشهٔ I/O). */
export type PolicyProjection = Readonly<{
  /** گزینه‌های `resolveToolLoopConfig` **به‌جز** `budget`. */
  loop: Readonly<{ maxSteps: number; maxToolCalls: number; maxIdenticalCalls: number; truncationRetries: number }>;
  /** گزینه‌های `createCalcAnswerService` **به‌جز** `gateway`، `loop`، `deps` و `timers`. */
  service: Readonly<{ model: string; maxOutputTokens: number; maxCards: number; totalTimeoutMs: number; toolTimeoutMs: number; maxResultChars: number }>;
  /** گزینه‌های `createDeadlineToolGateway` **به‌جز** `gateway`. */
  deadline: Readonly<{ maxCallMs: number }>;
  /** گزینه‌های `createDurableToolGateway` که از سیاست می‌آیند. */
  durable: Readonly<{ graceMs: number; reservationTtlMs: number; perMessageOverheadTokens: number; onUnknownCost: OnUnknownCost }>;
  /** مدخلِ جدولِ مدلِ دروازه (`createToolGateway`) که از سیاست می‌آید؛ قیمت و سقفِ خروجی جدا و با مالک است. */
  gatewayModel: Readonly<{ timeoutMs: number }>;
}>;

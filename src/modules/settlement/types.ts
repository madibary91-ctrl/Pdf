/**
 * settlement — نوع‌ها (ADR-0021). هرچه `index.ts` صادر نکند داخلی است.
 *
 * اصل: «هیچ تغییرِ دفتر بدون ردّ ماندگارِ پیشین». outbox قصدِ تسویه را **پیش از** اجرای آن روی دفتر نگه می‌دارد تا هر شکست یا مرگِ
 * فرایند بعداً با تکرارِ idempotent (همان شناسه‌ها) بسته شود؛ هیچ رکوردی متن پیام/پاسخ، کلید یا پیام خام پورت‌ها را نمی‌آورد.
 */
import type { AccountKey, Clock, CloseRemainder, Ledger } from "@/modules/ledger";

/** `open`: رزرو گرفته شده ولی هنوز قصدی ثبت نشده · `settling`: دست‌کم یک قصد ثبت شده · `done`: دفتر بسته شد · `dead`: خودکار بسته نشد (زنگ). */
export type EntryState = "open" | "settling" | "done" | "dead";

/**
 * چرایی مرگ (نیازمند رسیدگی انسانی/مالی):
 * - `EXPIRED_UNBILLED`: رزرو پیش از ثبتِ هزینه یا سوخت منقضی شد؛ دفتر دیگر مصرف را نمی‌پذیرد (کاربر مجانی گرفت).
 * - `ATTEMPTS_EXHAUSTED`: پس از سقف تلاش، دفتر همچنان خطای گذرا می‌داد.
 * - `LEDGER_REJECTED`: دفتر خطای دائمی داد (مثلاً رزرو توسط دیگری بسته شده یا واحد ناهمخوان).
 */
export type DeadReason = "EXPIRED_UNBILLED" | "ATTEMPTS_EXHAUSTED" | "LEDGER_REJECTED";

/** چه کسی تصمیم بستن را گرفت: فراخوانندهٔ درون‌خطی یا رفتگر. */
export type CloseOrigin = "caller" | "sweeper";

export type ReservationRef = AccountKey & Readonly<{ reservationId: string }>;
export type ChargeIntent = Readonly<{ attemptId: string; amount: number }>;
export type CloseIntent = Readonly<{ remainder: CloseRemainder; origin: CloseOrigin }>;

export type BeginInput = ReservationRef &
  Readonly<{
    unit: string;
    /** مبلغ رزروشده (رسید دفتر). */
    reserved: number;
    createdAtMs: number;
    /** سررسید رزرو طبق رسید دفتر؛ پس از آن `charge` ممکن نیست. */
    expiresAtMs: number;
    /** پیش از این لحظه رفتگر دست نمی‌زند (مهلت تماسِ درون‌خطی؛ ADR-0021 تصمیم ۳). */
    dueAtMs: number;
    /** سیاست رزروِ یتیم: اگر هیچ قصدی ثبت نشد (مرگ پیش از ثبتِ هزینه). عکسِ `onUnknownCost` لحظهٔ تماس. */
    orphanRemainder: CloseRemainder;
  }>;

export type OutboxEntry = BeginInput &
  Readonly<{
    state: EntryState;
    charge: ChargeIntent | null;
    close: CloseIntent | null;
    attempts: number;
    lastErrorCode: string | null;
    deadReason: DeadReason | null;
    settledAtMs: number | null;
  }>;

export type OutboxErrorCode = "INVALID_INPUT" | "NOT_FOUND" | "NOT_ACTIVE" | "CONFLICT" | "STORE_FAILURE";
/** `message` فارسی، ثابت و بی‌پژواکِ مقدار ورودی است. */
export type OutboxError = Readonly<{ code: OutboxErrorCode; message: string }>;
export type OutboxResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: OutboxError }>;

export type Replayed = Readonly<{ replayed: boolean }>;
/**
 * ورودیِ ثبتِ شکستِ گذرا. `expectedAttempts` (اختیاری، ADR-0028): `attempts`ی که فراخواننده در عکسِ خود دیده؛ با آن ثبت تکرارپذیر می‌شود
 * (دو رفتگرِ هم‌زمان یا تلاشِ دوبارهٔ پس از قطعِ مبهم، یک شکستِ منطقی را دوبار نمی‌شمارند).
 */
export type FailureInput = Readonly<{ errorCode: string; dueAtMs: number; expectedAttempts?: number }>;
/** `replayed` فقط وقتی هست که `expectedAttempts` داده شده باشد: `true` ⇒ پیش‌تر ثبت شده بود و چیزی نوشته نشد. */
export type FailureRecorded = Readonly<{ attempts: number; replayed?: boolean }>;
/** تأییدِ رسیدگی به رکوردِ مرده؛ `atMs` را فراخواننده می‌دهد (outbox ساعت ندارد) و فقط فراداده است، نه تصمیم. */
export type DeadAck = Readonly<{ atMs: number }>;
export type OutboxCounts = Readonly<Record<EntryState, number>>;
export type DueQuery = Readonly<{ nowMs: number; limit: number }>;
/**
 * م۳‑د‑۳ب (ADR-0029): درخواستِ «گرفتنِ» رکوردهای سررسیده. `leaseMs` (۱…۸۶٬۴۰۰٬۰۰۰) مدتی است که رکوردِ گرفته‌شده از دیدِ رفتگرهای دیگر پنهان می‌ماند؛
 * `nowMs + leaseMs` باید صحیحِ ایمن بماند.
 */
export type ClaimQuery = Readonly<{ nowMs: number; limit: number; leaseMs: number }>;

/**
 * پورت outbox (قرارداد: `outbox-contract.ts`). همهٔ متدها `Promise<OutboxResult>` برمی‌گردانند و **هرگز نمی‌پرتابند**.
 * شناسهٔ رکورد `(tenantId, accountId, reservationId)` است. ناوردا: قصدِ بستن آخرین قصد است (پس از آن `recordCharge` ممنوع)؛
 * `done` فقط پس از ثبت قصدِ بستن؛ `done`/`dead` نهایی‌اند.
 */
export type SettlementOutbox = Readonly<{
  /** رکورد تازهٔ `open`. تکرار با همان محتوا ⇒ `replayed`؛ محتوای دیگر ⇒ `CONFLICT`. */
  begin(input: BeginInput): Promise<OutboxResult<Replayed>>;
  /** `open`→`settling`. یکسان ⇒ `replayed`؛ متفاوت یا پس از قصدِ بستن ⇒ `CONFLICT`؛ نهایی ⇒ `NOT_ACTIVE`؛ بی‌رکورد ⇒ `NOT_FOUND`. */
  recordCharge(ref: ReservationRef, intent: ChargeIntent): Promise<OutboxResult<Replayed>>;
  /** مثل `recordCharge` (فقط `remainder` مقایسه می‌شود، نه `origin`): اولین ثبت برنده است. */
  recordClose(ref: ReservationRef, intent: CloseIntent): Promise<OutboxResult<Replayed>>;
  /**
   * ورودیِ **رفتگر**: اگر قصدِ بستن هست همان را برمی‌گرداند؛ وگرنه **خودِ outbox و اتمی** تصمیم می‌گیرد: بی‌قصدِ مصرف ⇒ `orphanRemainder`، با قصدِ مصرف ⇒ `release`
   * (هرگز بیش از هزینهٔ ثبت‌شده نمی‌گیرد) و آن را با `origin: "sweeper"` ثبت می‌کند. رکورد را پس از ثبت (وضعیت تازه) برمی‌گرداند؛ نهایی ⇒ `NOT_ACTIVE`.
   * اتمی‌بودن، شرط مسابقه با ثبتِ هم‌زمانِ قصدِ مصرفِ درون‌خطی را می‌بندد (تصمیم بر پایهٔ عکسِ کهنه بیش‌اخذ می‌ساخت).
   */
  resolveClose(ref: ReservationRef): Promise<OutboxResult<OutboxEntry>>;
  /** `→done`؛ بی‌قصدِ بستن ⇒ `CONFLICT`؛ `done` ⇒ `replayed`؛ `dead` ⇒ `NOT_ACTIVE`. */
  finish(ref: ReservationRef, atMs: number): Promise<OutboxResult<Replayed>>;
  /**
   * شمار تلاش +۱، کد خطا و سررسید تازه؛ فقط رکورد فعال.
   * م۳‑د‑۳الف (ADR-0028): با `expectedAttempts` تکرارپذیر (compare-and-set) است؛ `attempts === expected` ⇒ ثبت (`replayed:false`)،
   * `attempts > expected` ⇒ کسِ دیگری پیش افتاد، بی‌نوشتن (`replayed:true`)، `attempts < expected` ⇒ `CONFLICT`. بی‌آن: رفتارِ پیشین (`{attempts}`).
   */
  recordFailure(ref: ReservationRef, failure: FailureInput): Promise<OutboxResult<FailureRecorded>>;
  /** رکورد فعال → `dead`؛ تکرار با همان دلیل ⇒ `replayed`؛ دلیل دیگر ⇒ `CONFLICT`؛ `done` ⇒ `NOT_ACTIVE`. */
  bury(ref: ReservationRef, burial: Readonly<{ reason: DeadReason; errorCode: string | null; atMs: number }>): Promise<OutboxResult<Replayed>>;
  get(ref: ReservationRef): Promise<OutboxResult<OutboxEntry | null>>;
  /** رکوردهای فعال با `dueAtMs ≤ nowMs`، به ترتیب (سررسید، شناسه)، حداکثر `limit` (۱…۱۰۰۰). */
  listDue(query: DueQuery): Promise<OutboxResult<readonly OutboxEntry[]>>;
  /** مرده‌ها به ترتیب (زمان مرگ، شناسه) برای رسیدگی عملیاتی. */
  listDead(query: Readonly<{ limit: number }>): Promise<OutboxResult<readonly OutboxEntry[]>>;
  /**
   * م۳‑د (ADR-0025): مرده‌هایی که **هنوز تأیید رسیدگی نشده‌اند**، به ترتیبِ `listDead` (زمان مرگ، شناسه)، حداکثر `limit` (۱…۱۰۰۰).
   * تأیید فهرستِ `listDead` را تغییر نمی‌دهد (تاریخچه کامل می‌ماند)؛ فقط از این فهرست بیرون می‌برد. زنگِ عملیاتی از همین فهرست می‌خواند:
   * اگر فرایند پیش از رسیدنِ زنگ بمیرد، رکورد همچنان این‌جا می‌ماند (تحویلِ دست‌کم‌یک‌بار، نه «حداکثر یک بار» که زنگ را گم می‌کرد).
   */
  listUnacknowledgedDead(query: Readonly<{ limit: number }>): Promise<OutboxResult<readonly OutboxEntry[]>>;
  /**
   * ثبتِ «رسیدگی/اعلام شد» برای یک رکوردِ `dead`؛ نوشتن‌یک‌بار: **اولین تأیید برنده است** و تکرار (حتی با `atMs` دیگر) ⇒ `replayed`.
   * بی‌رکورد ⇒ `NOT_FOUND`؛ رکوردِ غیرمرده (`open`/`settling`/`done`) ⇒ `CONFLICT` (فقط مرده تأیید می‌شود) و رکورد دست‌نخورده می‌ماند.
   */
  acknowledgeDead(ref: ReservationRef, ack: DeadAck): Promise<OutboxResult<Replayed>>;
  counts(): Promise<OutboxResult<OutboxCounts>>;
}>;

/**
 * م۳‑د‑۳ب (ADR-0029): قابلیتِ اختیاریِ «اجاره» (lease) روی outbox؛ هر دو outboxِ حافظه‌ای و PostgreSQL آن را دارند و آزمونِ قراردادِ
 * `contract/claim-contract.ts` را بی‌تغییر می‌گذرانند. عمداً بخشی از `SettlementOutbox` نیست تا هر outboxِ بیرونیِ موجود (که فقط `listDue` دارد) همچنان معتبر بماند.
 *
 * `claimDue` اتمی (در پایگاه: یک تراکنش و `FOR UPDATE SKIP LOCKED`) رکوردهای **فعال** با `dueAtMs ≤ nowMs` را به ترتیبِ `(dueAtMs، شناسه)` تا `limit` برمی‌دارد و
 * **سررسیدشان را به `nowMs + leaseMs` عقب می‌برد** (تأخیرِ محض: وضعیت، شمارندهٔ تلاش و کد خطا دست‌نخورده)، و عکسِ **پس از** به‌روزرسانی را به همان ترتیب برمی‌گرداند
 * (پس `dueAtMs`ِ عکس همان پایانِ اجاره است). رفتگرِ دیگری که پیش از پایانِ اجاره بخواند، آن رکورد را نه در `listDue` می‌بیند و نه در `claimDue`؛
 * اگر دارندهٔ اجاره بمیرد، اجاره خودبه‌خود (با گذشتنِ زمان، بی‌هیچ پاکسازی) تمام می‌شود و رکورد دوباره سررسیده است.
 * اجاره **قفلِ درستی** نیست، فقط کاهندهٔ کارِ تکراری است: درستیِ مالی همچنان با idempotencyِ دفتر و compare-and-set ِ `recordFailure` (ADR-0028) است.
 */
export type DueClaimer = Readonly<{
  claimDue(query: ClaimQuery): Promise<OutboxResult<readonly OutboxEntry[]>>;
}>;

export type SettlementConfigError = Readonly<{ code: "INVALID_CONFIG"; message: string; issues: readonly string[] }>;
export type SettlementResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: SettlementConfigError }>;

export type DurableLedgerConfig = Readonly<{
  /** دفتر واقعی (همان که رفتگر هم به آن می‌دهید). */
  ledger: Ledger;
  outbox: SettlementOutbox;
  clock: Clock;
  /** مهلتِ تماسِ درون‌خطی (میلی‌ثانیه): پیش از آن رفتگر به رکورد دست نمی‌زند. باید از زمان کل یک تماس بیشتر و حداکثر نصفِ `ttlMs` رزرو باشد. */
  graceMs: number;
  /** سیاست رزروِ یتیم؛ باید همان `onUnknownCost` پیکربندی metering باشد (`createDurableMeteredGateway` یکی‌اش می‌کند). */
  onUnknownCost: CloseRemainder;
}>;

export type SweeperConfig = Readonly<{
  ledger: Ledger;
  outbox: SettlementOutbox;
  clock: Clock;
  /** حداکثر رکورد در هر `sweep` (۱…۱۰۰۰). پیش‌فرض ۱۰۰. */
  limit?: number;
  /** پس از این شمار تلاشِ گذرای ناموفق رکورد `ATTEMPTS_EXHAUSTED` می‌شود (۱…۱۰۰). پیش‌فرض ۱۰. */
  maxAttempts?: number;
  /** فاصلهٔ تلاش دوباره: `retryDelayMs × (تلاش‌ها + ۱)`. پیش‌فرض ۳۰٬۰۰۰. */
  retryDelayMs?: number;
  /**
   * م۳‑د‑۳ب (ADR-0029): اگر داده شود (۱…۸۶٬۴۰۰٬۰۰۰) رفتگر به‌جای `listDue` از `outbox.claimDue` می‌خواند (outbox باید `DueClaimer` باشد) و رکوردهای گرفته‌شده
   * تا `leaseMs` از دیدِ رفتگرهای دیگر پنهان می‌مانند. باید بزرگ‌تر از بدترین زمانِ پردازشِ یک دسته (`limit × زمانِ دفتر`) باشد؛
   * رفتگر هر رکورد را پیش از پردازش با ساعت می‌سنجد و اگر اجاره‌اش تمام شده آن را رها می‌کند (`raced`). بی‌آن: رفتارِ پیشین (`listDue`).
   */
  leaseMs?: number;
}>;

export type BuriedItem = Readonly<{ tenantId: string; accountId: string; reservationId: string; reason: DeadReason; errorCode: string | null }>;

/** نتیجهٔ یک گذر. فقط شناسه و شمار؛ `buried` غیرتهی = زنگِ عملیاتی. */
export type SweepReport = Readonly<{
  /** رکوردهای سررسیدشده که بررسی شدند. */
  examined: number;
  /** دفتر بسته و رکورد `done` شد. */
  settled: number;
  /** شکست گذرا؛ با تأخیر دوباره تلاش می‌شود. */
  retryLater: number;
  /** همزمان کسِ دیگری (درون‌خطی/رفتگر دیگر) پیش افتاد؛ رها شد. */
  raced: number;
  /** خودِ outbox خطا داد؛ رکورد برای گذر بعد می‌ماند. */
  outboxFailures: number;
  buried: readonly BuriedItem[];
  /** خواندن فهرست ناموفق بود (گذر بی‌اثر). */
  listFailed: boolean;
}>;

export type Sweeper = Readonly<{ sweep(): Promise<SweepReport> }>;

// ───────────────────────── م۳‑ج: زمان‌بند رفتگر (ADR-0023) ─────────────────────────

/**
 * زمان‌سنجِ تزریقی. ماژول هرگز تایمر سراسری نمی‌سازد؛ ریشهٔ ترکیب آن را می‌دهد
 * (`{ after: (fn, ms) => setTimeout(fn, ms), cancel: (h) => clearTimeout(h as never) }`).
 * `after` باید پس از `ms` میلی‌ثانیه **یک بار** `fn` را صدا بزند و دستگیره‌ای برگرداند که `cancel` بفهمد.
 */
export type LoopTimer = Readonly<{ after(fn: () => void, ms: number): unknown; cancel(handle: unknown): void }>;

/**
 * - `SWEEP_THREW`: خودِ `sweep()` پرتاب کرد (رفتگرِ ما هرگز نمی‌پرتابد؛ یعنی رفتگرِ تزریقی خراب است).
 * - `BAD_REPORT`: گزارش شکلِ `SweepReport` نداشت.
 * - `LIST_FAILED`: فهرستِ سررسیدها خوانده نشد (outbox یا ساعت در دسترس نیست).
 * - `OUTBOX_FAILURES`: دست‌کم یک رکورد به‌خاطر خطای outbox بسته نشد.
 * - `SCHEDULE_FAILED`: زمان‌سنج نتوانست گذر بعد را بسازد؛ حلقه از کار افتاد (`stalled`) و باید از بیرون دوباره `start` شود.
 * م۳‑د‑۲ (ADR-0026، فقط با `deadLetters`):
 * - `DEAD_LIST_FAILED`: فهرستِ مرده‌های تأییدنشده خوانده نشد یا شکلِ نامعتبر داشت (outbox خراب است).
 * - `DEAD_DELIVER_FAILED`: `deliver` برای دست‌کم یک رکورد پرتاب/رد شد یا مهلتش گذشت (یا زمان‌سنجِ مهلت ساخته نشد)؛ تأیید نمی‌شود و گذر بعد دوباره می‌رسد.
 * - `DEAD_ACK_FAILED`: زنگ رسید ولی تأیید ثبت نشد (خطای outbox یا ساعتِ نامعتبر)؛ زنگ در گذر بعد **دوباره** می‌رسد (تحویلِ دست‌کم‌یک‌بار).
 */
export type LoopFaultKind =
  | "SWEEP_THREW"
  | "BAD_REPORT"
  | "LIST_FAILED"
  | "OUTBOX_FAILURES"
  | "SCHEDULE_FAILED"
  | "DEAD_LIST_FAILED"
  | "DEAD_DELIVER_FAILED"
  | "DEAD_ACK_FAILED";

export type LoopFault = Readonly<{
  kind: LoopFaultKind;
  /** شمار شکست‌های پیاپی تا و با همین گذر. */
  consecutiveFailures: number;
  /** تأخیرِ گذر بعد؛ `null` اگر گذری زمان‌بندی نشد. */
  nextDelayMs: number | null;
}>;

export type LoopRunInfo = Readonly<{
  /** شمارهٔ گذر (از ۱ از آغازِ ساختِ حلقه). */
  run: number;
  /** ساعتِ پایانِ گذر؛ `null` اگر ساعت نامعتبر بود. */
  atMs: number | null;
  nextDelayMs: number | null;
}>;

/**
 * مشاهده‌گر (زنگ و سنجه). هر متد اختیاری است؛ **هیچ‌کدام await نمی‌شوند** (مشاهده‌گرِ آویزان حلقه را نمی‌ایستاند) و پرتاب/رد‌شدنشان
 * فقط `observerFailures` را زیاد می‌کند. آنچه می‌گیرند کپیِ منجمدِ حلقه است (دستکاری‌اش اثری ندارد).
 */
export type SweepObserver = Readonly<{
  onReport?(report: SweepReport, info: LoopRunInfo): unknown;
  /** زنگِ عملیاتی: رکوردهایی که در همین گذر `dead` شدند (هر رکورد فقط یک بار می‌میرد). */
  onBuried?(items: readonly BuriedItem[], info: LoopRunInfo): unknown;
  onFault?(fault: LoopFault): unknown;
}>;

/**
 * م۳‑د‑۲ (ADR-0026): زنگِ ماندگارِ مرده‌ها. فقط شناسه و عددهای مالیِ رکورد؛ هرگز پیامِ خام، کلید یا متنِ کاربر.
 * کپیِ منجمدِ حلقه است (دستکاریِ `deliver` اثری روی حلقه/outbox ندارد).
 */
export type DeadLetter = Readonly<{
  tenantId: string;
  accountId: string;
  reservationId: string;
  unit: string;
  /** مبلغِ رزروشدهٔ رکورد (آنچه رسیدگیِ مالی باید بسنجد). */
  reserved: number;
  reason: DeadReason;
  errorCode: string | null;
  attempts: number;
  /** زمانِ مرگ (ثبت‌شدهٔ outbox)؛ `null` اگر outbox نداده باشد. */
  deadAtMs: number | null;
}>;

/** بخشی از پورتِ outbox که زنگِ ماندگار لازم دارد (ADR-0025). */
export type DeadLetterOutbox = Pick<SettlementOutbox, "listUnacknowledgedDead" | "acknowledgeDead">;

/**
 * زنگِ ماندگار (ADR-0026). حلقه در هر گذر (از جمله نخستین گذر پس از `start`، پس هر ریستارت) مرده‌های **تأییدنشده** را از outbox می‌خواند،
 * هر کدام را به `deliver` می‌دهد و **فقط پس از موفقیتِ `deliver`** تأیید می‌کند. `deliver` برخلافِ مشاهده‌گرها **await می‌شود** (با مهلت).
 * ضمانت: تحویلِ دست‌کم‌یک‌بار ⇒ `deliver` باید idempotent باشد (مثلاً کلیدِ `(tenantId, accountId, reservationId)`).
 */
export type DeadLetterDelivery = Readonly<{
  outbox: DeadLetterOutbox;
  /** resolve ⇒ رسید و تأیید می‌شود؛ پرتاب/رد/مهلت ⇒ تأیید نمی‌شود و گذر بعد دوباره می‌آید. */
  deliver(letter: DeadLetter): unknown;
  /** حداکثر رکورد در هر دسته (۱…۱۰۰۰). پیش‌فرض ۵۰. */
  batchLimit?: number;
  /** حداکثر دسته در هر گذر (۱…۱۰۰). پیش‌فرض ۵. دسته‌ی پر در پایانِ سقف ⇒ گذرِ بعد بی‌انتظار (تخلیه). */
  maxBatchesPerRun?: number;
  /** مهلتِ هر `deliver` (۱…۳٬۶۰۰٬۰۰۰). پیش‌فرض ۳۰٬۰۰۰. گذشتنِ مهلت = شکستِ همان رکورد، نه آویزان‌شدنِ حلقه. */
  deliverTimeoutMs?: number;
}>;

export type DeadLetterStats = Readonly<{
  enabled: boolean;
  /** `deliver`هایی که موفق شدند. */
  delivered: number;
  /** تأییدهایی که ثبت شدند (تکراریِ `replayed` هم می‌شمارد؛ رکورد در هر صورت تأییدشده است). */
  acknowledged: number;
  deliverFailures: number;
  ackFailures: number;
  listFailures: number;
  /** ساعتِ آخرین تأییدِ موفق؛ برای پایش. */
  lastAckAtMs: number | null;
}>;

export type SweepLoopConfig = Readonly<{
  /** رفتگر ساخته‌شده (`createSettlementSweeper`). */
  sweeper: Sweeper;
  timer: LoopTimer;
  clock: Clock;
  /** همان `graceMs` پیکربندی `createDurableLedger`؛ سقفِ ایمنِ فاصله‌ها از آن می‌آید. */
  graceMs: number;
  /** فاصلهٔ گذرها پس از پایانِ گذرِ سالم؛ باید ≤ `⌊graceMs/2⌋` باشد (رزروِ یتیم پیش از انقضا دیده شود). */
  intervalMs: number;
  /** سقفِ عقب‌نشینیِ نمایی پس از شکست؛ `intervalMs ≤ … ≤ ⌊graceMs/2⌋`. پیش‌فرض `⌊graceMs/2⌋`. */
  maxBackoffMs?: number;
  /** پس از گذرِ پربار (تسویه یا مرگ) تا این شمار گذرِ پیاپی بی‌انتظار (۱…۱۰۰۰). پیش‌فرض ۲۰. */
  maxDrainRuns?: number;
  /** حداکثر انتظار `stop()` برای گذرِ در حال اجرا (۱…۳٬۶۰۰٬۰۰۰). پیش‌فرض ۳۰٬۰۰۰. */
  stopTimeoutMs?: number;
  observer?: SweepObserver;
  /** اختیاری؛ بدونِ آن رفتار دقیقاً مثلِ ADR-0023 است (زنگ فقط درون‌حافظه‌ای). */
  deadLetters?: DeadLetterDelivery;
}>;

export type LoopState = "stopped" | "running" | "stopping" | "stalled";

export type SweepLoopStatus = Readonly<{
  state: LoopState;
  /** گذری هم‌اکنون در حال اجراست (پس از `stop` ناپاک هم ممکن است true بماند). */
  busy: boolean;
  runs: number;
  consecutiveFailures: number;
  lastRunAtMs: number | null;
  /** آخرین گذرِ بی‌شکست؛ برای پایشِ «رفتگر مرده است؟» (اگر خیلی قدیمی است زنگ بزنید). */
  lastSuccessAtMs: number | null;
  lastFault: LoopFaultKind | null;
  totals: Readonly<{ examined: number; settled: number; retryLater: number; raced: number; outboxFailures: number; buried: number; faults: number; observerFailures: number }>;
  /** م۳‑د‑۲: شمارنده‌های زنگِ ماندگار (بی‌پیکربندیِ `deadLetters`: `enabled:false` و صفرها). */
  deadLetters: DeadLetterStats;
}>;

export type LoopStartResult = Readonly<{ started: true }> | Readonly<{ started: false; reason: "ALREADY_RUNNING" | "PREVIOUS_RUN_ACTIVE" | "SCHEDULE_FAILED" }>;
/** `clean=false`: گذرِ در حال اجرا تا `stopTimeoutMs` تمام نشد (دیگر زمان‌بندی نمی‌شود، ولی هنوز ممکن است کار کند). */
export type LoopStopResult = Readonly<{ clean: boolean }>;

/** حلقهٔ رفتگر. هیچ متدی نمی‌پرتابد. */
export type SweepLoop = Readonly<{
  start(): LoopStartResult;
  stop(): Promise<LoopStopResult>;
  status(): SweepLoopStatus;
}>;

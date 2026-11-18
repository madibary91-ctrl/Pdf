/**
 * ledger — نوع‌ها (ADR-0018). همهٔ مقدارها JSON‌پذیرند (بدون Map/Set/Date) تا ذخیرهٔ ماندگارِ بعدی (ل۲) بی‌تبدیل بتواند آن‌ها را نگه دارد.
 * مبلغ‌ها همه عدد صحیح ایمن در «واحد» حساب‌اند؛ دفتر قیمت و ارز نمی‌شناسد.
 */

export type LedgerErrorCode =
  | "INVALID_INPUT"
  | "ACCOUNT_NOT_FOUND"
  | "UNIT_MISMATCH"
  | "INSUFFICIENT_CREDIT"
  | "RESERVATION_NOT_FOUND"
  | "RESERVATION_CLOSED"
  | "RESERVATION_EXPIRED"
  | "TOO_MANY_OPEN_RESERVATIONS"
  | "TOO_MANY_ATTEMPTS"
  | "CHARGE_NOT_FOUND"
  | "REFUND_EXCEEDS_CHARGE"
  | "IDEMPOTENCY_CONFLICT"
  | "OVERFLOW"
  | "STORE_FAILURE"
  | "INTERNAL_ERROR";

/** `message` فارسی، ثابت و بی‌پژواکِ مقدار ورودی است. */
export type LedgerError = Readonly<{ code: LedgerErrorCode; message: string }>;

export type LedgerResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: LedgerError }>;

export type GrantSource = "purchase" | "promo" | "adjustment";
export type CloseRemainder = "release" | "forfeit";
export type ClosedBy = "release" | "forfeit" | "expiry";

type Scope = Readonly<{ tenantId: string; accountId: string }>;

export type OpenAccountCommand = Scope & Readonly<{ kind: "open"; unit: string }>;
export type GrantCommand = Scope & Readonly<{ kind: "grant"; grantId: string; unit: string; amount: number; source: GrantSource }>;
export type ReserveCommand = Scope & Readonly<{ kind: "reserve"; reservationId: string; unit: string; amount: number; ttlMs: number }>;
export type ChargeCommand = Scope & Readonly<{ kind: "charge"; reservationId: string; attemptId: string; unit: string; amount: number }>;
export type CloseCommand = Scope & Readonly<{ kind: "close"; reservationId: string; remainder: CloseRemainder }>;
export type RefundCommand = Scope & Readonly<{ kind: "refund"; refundId: string; reservationId: string; attemptId: string; unit: string; amount: number }>;

export type Command = OpenAccountCommand | GrantCommand | ReserveCommand | ChargeCommand | CloseCommand | RefundCommand;
export type CommandKind = Command["kind"];

/** رسیدها: همان چیزی که برای بازتکرار ذخیره و عیناً برگردانده می‌شود. */
export type Receipt =
  | Readonly<{ kind: "open"; accountId: string; unit: string }>
  | Readonly<{ kind: "grant"; grantId: string; amount: number; availableAfter: number }>
  | Readonly<{ kind: "reserve"; reservationId: string; amount: number; expiresAtMs: number; availableAfter: number; heldAfter: number }>
  | Readonly<{ kind: "charge"; reservationId: string; attemptId: string; requested: number; charged: number; shortfall: number; remainingHold: number }>
  | Readonly<{ kind: "close"; reservationId: string; remainder: CloseRemainder; released: number; forfeited: number }>
  | Readonly<{ kind: "refund"; refundId: string; reservationId: string; attemptId: string; amount: number; availableAfter: number }>;

export type AttemptCharge = { requested: number; charged: number; shortfall: number; refunded: number };

export type Reservation = {
  id: string;
  amount: number;
  remaining: number;
  charged: number;
  status: "open" | "closed";
  closedBy: ClosedBy | null;
  /** مقدارِ باقیماندهٔ لحظهٔ بسته‌شدن (آزادشده یا مصرف‌شده)؛ برای رزرو باز ۰. */
  closedAmount: number;
  createdAtMs: number;
  expiresAtMs: number;
  closedAtMs: number | null;
  attempts: Record<string, AttemptCharge>;
};

export type Totals = { granted: number; charged: number; forfeited: number; refunded: number; shortfall: number };

export type Processed = { fingerprint: string; receipt: Receipt };

/** حالت کاملِ یک حساب (مرز سازگاری). */
export type AccountState = {
  tenantId: string;
  accountId: string;
  unit: string;
  createdAtMs: number;
  /** بزرگ‌ترین زمانی که این حساب دیده است؛ ساعتِ یکنوا (ADR-0018 §۷). */
  lastAtMs: number;
  /** شمارندهٔ ورودی‌های ژورنال. */
  seq: number;
  available: number;
  held: number;
  totals: Totals;
  reservations: Record<string, Reservation>;
  processed: Record<string, Processed>;
};

export type JournalType = "grant" | "reserve" | "charge" | "release" | "forfeit" | "expire" | "refund";

/** ورودی ژورنال: فقط‌افزودنی؛ هرگز متن آزاد یا دادهٔ شخصی ندارد. */
export type JournalEntry = Readonly<{
  seq: number;
  atMs: number;
  type: JournalType;
  /** grant/reserve: مبلغ؛ charge: مصرف‌شده؛ release/expire/forfeit: باقیمانده؛ refund: مبلغ بازگشت. */
  amount: number;
  /** فقط در charge غیرصفر می‌شود. */
  shortfall: number;
  reservationId: string | null;
  attemptId: string | null;
  /** grantId یا refundId. */
  refId: string | null;
  availableAfter: number;
  heldAfter: number;
}>;

export type Balance = Readonly<{
  unit: string;
  available: number;
  held: number;
  openReservations: number;
  totals: Readonly<Totals>;
  asOfMs: number;
}>;

export type AccountKey = Readonly<{ tenantId: string; accountId: string }>;

export type Commit = Readonly<{ state: AccountState; entries: readonly JournalEntry[] }>;
export type TransactOutcome<T> = Readonly<{ commit: Commit | null; value: T }>;

/**
 * پورت ذخیره (ADR-0018 §۹). `transact` تابع `fn` را دقیقاً یک بار و تحت سریال‌سازیِ همان حساب اجرا می‌کند؛
 * `commit` (حالت + ورودی‌های ژورنال) اتمی است. `fn` همگام و خالص است. هر پرتابِ ذخیره به `STORE_FAILURE` تبدیل می‌شود.
 */
export type AccountStore = Readonly<{
  transact<T>(key: AccountKey, fn: (current: AccountState | null) => TransactOutcome<T>): Promise<T>;
  read(key: AccountKey): Promise<AccountState | null>;
  journal(key: AccountKey): Promise<readonly JournalEntry[]>;
}>;

export type Clock = Readonly<{ nowMs(): number }>;

export type LedgerConfig = Readonly<{ store: AccountStore; clock: Clock }>;

export type Replayable<R> = R & Readonly<{ replayed: boolean }>;

export type ReceiptOf<K extends CommandKind> = Extract<Receipt, { kind: K }>;

/** ورودی‌های سرویس: همان فرمان بی‌`kind`. */
type Input<C extends Command> = Omit<C, "kind">;
export type OpenAccountInput = Input<OpenAccountCommand>;
export type GrantInput = Input<GrantCommand>;
export type ReserveInput = Input<ReserveCommand>;
export type ChargeInput = Input<ChargeCommand>;
export type CloseInput = Input<CloseCommand>;
export type RefundInput = Input<RefundCommand>;

export type Ledger = Readonly<{
  openAccount(input: OpenAccountInput): Promise<LedgerResult<Replayable<ReceiptOf<"open">>>>;
  grant(input: GrantInput): Promise<LedgerResult<Replayable<ReceiptOf<"grant">>>>;
  reserve(input: ReserveInput): Promise<LedgerResult<Replayable<ReceiptOf<"reserve">>>>;
  charge(input: ChargeInput): Promise<LedgerResult<Replayable<ReceiptOf<"charge">>>>;
  close(input: CloseInput): Promise<LedgerResult<Replayable<ReceiptOf<"close">>>>;
  refund(input: RefundInput): Promise<LedgerResult<Replayable<ReceiptOf<"refund">>>>;
  balance(key: AccountKey): Promise<LedgerResult<Balance>>;
  journal(key: AccountKey): Promise<LedgerResult<readonly JournalEntry[]>>;
}>;

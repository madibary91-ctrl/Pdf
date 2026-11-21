/**
 * settlement-pending — نوع‌ها (ADR-0046، م۳‑ه‑۴‑الف‑۲‑۴‑ب‑۱).
 *
 * این ماژول یک **نمایهٔ مشتق** از «مرده‌هایی که هنوز تأیید رسیدگی نشده‌اند» نگه می‌دارد تا پایشِ پسماند به‌جای ضدپیوندِ outbox × تأییدها
 * (هزینهٔ خطی در شمارِ مرده‌های تأییدشده؛ ADR-0044) فقط به اندازهٔ **تأییدنشده‌ها** کار کند. حقیقتِ مالی همچنان در `settlement_outbox` و
 * `settlement_dead_ack` است؛ نمایه فقط ازشان مشتق می‌شود، با TRIGGERهای پایگاه به‌روز می‌ماند و با `verify()` قابل‌راستی‌آزمایی است.
 */
import type { PgMigrationReport, PgMigrationStatus, PgStoreResult } from "@/modules/ledger";
import type { OutboxEntry, OutboxResult } from "@/modules/settlement";

export type PendingDeadIndexOptions = Readonly<{
  /** شِمای outbox؛ همان که `createPgSettlementOutbox` به کار می‌برد (پیش‌فرض `settlement`). فقط `^[a-z][a-z0-9_]{0,39}$`. */
  schema?: string;
  /**
   * سقفِ زمانِ سمتِ پایگاه (`statement_timeout`، فقط درونِ همان تراکنشِ فقط‌خواندنی) برای `listUnacknowledgedDead` و `verify`
   * (هم‌خانوادهٔ ADR-0045؛ `SET LOCAL` از راهِ `set_config(..., true)`). عددِ صحیحِ ۱ تا ۷٬۲۰۰٬۰۰۰ میلی‌ثانیه. نبودنش = بی‌سقف.
   */
  readStatementTimeoutMs?: number;
}>;

/**
 * نتیجهٔ راستی‌آزماییِ نمایه در برابر حقیقت (فقط شمارش؛ بدون شناسه یا مبلغ):
 * - `expected`: شمارِ مرده‌های تأییدنشده در حقیقت (outbox ⊖ تأییدها).
 * - `indexed`: شمارِ ردیف‌های نمایه.
 * - `missing`: مردهٔ تأییدنشده‌ای که در نمایه **نیست** (یا با زمانِ مرگِ متفاوت هست و خواندن آن را نمی‌بیند) — خطرناک: پایش آن زنگ را نمی‌بیند.
 * - `stale`: ردیفِ نمایه‌ای که حقیقت ندارد (تأییدشده، غیرِ‌مرده، ناموجود یا با زمانِ مرگِ متفاوت) — بی‌خطرتر: خواندن آن را فیلتر می‌کند.
 * - `consistent`: `missing = 0 ∧ stale = 0`.
 */
export type PendingVerifyReport = Readonly<{
  consistent: boolean;
  expected: number;
  indexed: number;
  missing: number;
  stale: number;
}>;

export type PendingDeadIndex = Readonly<{
  /** مهاجرتِ نمایه را اعمال می‌کند (idempotent و هم‌زمان‌امن). پیش‌نیاز: مهاجرت‌های `settlement` اعمال شده‌اند. outbox خودش مهاجرت نمی‌کند. */
  migrate(): Promise<PgStoreResult<PgMigrationReport>>;
  /** فقط‌خواندنی: چه چیزی اعمال شده و چه چیزی معلق است. شِمای ناموجود = همه معلق. */
  status(): Promise<PgStoreResult<PgMigrationStatus>>;
  /** فقط‌خواندنیِ **سنگین** (O(مرده‌ها + تأییدها)): برای ابزارِ عملیاتی/پس از مهاجرت؛ نه برای حلقهٔ دوره‌ای. */
  verify(): Promise<PgStoreResult<PendingVerifyReport>>;
  /**
   * هم‌امضا و هم‌معنا با `listUnacknowledgedDead` ی `PgSettlementOutbox` (پورتِ `BacklogOutbox`)، ولی هزینه‌اش O(تأییدنشده‌ها) است نه O(تأییدشده‌ها).
   * ترتیب: `(settledAtMs, tenantId, accountId, reservationId)` با ترتیبِ نقطه‌کد. هرگز نمی‌پرتابد.
   */
  listUnacknowledgedDead(query: Readonly<{ limit: number }>): Promise<OutboxResult<readonly OutboxEntry[]>>;
}>;

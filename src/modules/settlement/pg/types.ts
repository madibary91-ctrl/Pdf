/**
 * settlement/pg — نوع‌های آداپتور PostgreSQL برای outbox (ADR-0022).
 * این ماژول هیچ‌وقت خودش اتصال نمی‌سازد: `drizzle(pool)` یا `db` برنامه را از بیرون می‌گیرد.
 */
import type { PgMigrationReport, PgMigrationStatus, PgStoreResult } from "@/modules/ledger";
import type { DueClaimer, SettlementOutbox } from "../types";

export type PgSettlementOutbox = SettlementOutbox &
  DueClaimer &
  Readonly<{
    /** مهاجرت‌ها را اعمال می‌کند (idempotent و هم‌زمان‌امن). outbox خودش هرگز مهاجرت نمی‌کند. */
    migrate(): Promise<PgStoreResult<PgMigrationReport>>;
    /** فقط‌خواندنی: چه چیزی اعمال شده و چه چیزی معلق است. */
    status(): Promise<PgStoreResult<PgMigrationStatus>>;
  }>;

export type PgSettlementOutboxOptions = Readonly<{
  schema?: string;
  /**
   * سقفِ زمانِ سمتِ پایگاه (`statement_timeout`، فقط درونِ همان تراکنش) برای **عملیاتِ فقط‌خواندنی** (`listDead`، `listUnacknowledgedDead`، `counts`، `get`)،
   * عددِ صحیحِ ۱ تا ۷٬۲۰۰٬۰۰۰ میلی‌ثانیه (ADR-0045). نبودنش = بی‌سقف (رفتارِ پیشین). نوشتن‌ها هرگز سقف نمی‌گیرند.
   * برای نمونه‌ای که فقط پایش می‌خواند بگذارید (مثلاً مهلتِ پایش + فرجه)؛ برای نمونهٔ رفتگر نگذارید. رد شدنِ سقف ⇒ `STORE_FAILURE` (پیامِ ثابت).
   */
  readStatementTimeoutMs?: number;
}>;

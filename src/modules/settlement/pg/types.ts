/**
 * settlement/pg — نوع‌های آداپتور PostgreSQL برای outbox (ADR-0022).
 * این ماژول هیچ‌وقت خودش اتصال نمی‌سازد: `drizzle(pool)` یا `db` برنامه را از بیرون می‌گیرد.
 */
import type { PgMigrationReport, PgMigrationStatus, PgStoreResult } from "@/modules/ledger";
import type { SettlementOutbox } from "../types";

export type PgSettlementOutbox = SettlementOutbox &
  Readonly<{
    /** مهاجرت‌ها را اعمال می‌کند (idempotent و هم‌زمان‌امن). outbox خودش هرگز مهاجرت نمی‌کند. */
    migrate(): Promise<PgStoreResult<PgMigrationReport>>;
    /** فقط‌خواندنی: چه چیزی اعمال شده و چه چیزی معلق است. */
    status(): Promise<PgStoreResult<PgMigrationStatus>>;
  }>;

export type PgSettlementOutboxOptions = Readonly<{ schema?: string }>;

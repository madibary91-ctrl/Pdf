/**
 * ذخیرهٔ PostgreSQL برای پورت `AccountStore` (ADR-0019).
 *
 * `transact` = یک تراکنش: قفل مشورتیِ حساب ← سپر مهاجرت ← `SELECT … FOR UPDATE` و خواندن حالت ← `fn` (دقیقاً یک بار) ← نوشتن تفاضل ← commit.
 * هر پرتابِ لایهٔ پایگاه به `LedgerStoreError` با پیام امن تبدیل می‌شود (سرویس ledger آن را `STORE_FAILURE` می‌کند)؛
 * خطای خودِ `fn` دست‌نخورده بالا می‌رود (تراکنش برمی‌گردد و چیزی نوشته نمی‌شود).
 */
import { sql } from "drizzle-orm";
import { checkInvariants } from "../invariants";
import type { AccountKey, AccountState, JournalEntry, TransactOutcome } from "../types";
import { auditAccount } from "./audit";
import { corrupt, toStoreError } from "./errors";
import { assertCurrent, migrate, migrationStatus } from "./migrate";
import { LEDGER_DEFAULT_SCHEMA, lockName, parseSchemaName } from "./naming";
import { assertKey, loadJournal, loadState } from "./read";
import type { LedgerDatabase, PgAccountStore, PgStoreOptions, PgStoreResult } from "./types";
import { writeCommit } from "./write";

/**
 * کارخانهٔ داخلی. `semanticGuards: false` فقط برای **آزمون قرارداد پورت** است که حالت‌های ساختگیِ ناسازگار با بقا commit می‌کند
 * (مکانیکِ پورت را می‌سنجد، نه معنای مالی)؛ از `index.ts` صادر نمی‌شود و `createPgAccountStore` همیشه `true` می‌دهد.
 */
export function buildPgStore(db: LedgerDatabase, schema: string, semanticGuards: boolean): PgAccountStore {
  const verify = (s: AccountState): void => {
    if (semanticGuards && checkInvariants(s).length > 0) throw corrupt("حالتِ ذخیره‌شده ناوردای دفتر را می‌شکند؛ دادهٔ خراب است و به موتور داده نمی‌شود.");
  };

  async function transact<T>(key: AccountKey, fn: (current: AccountState | null) => TransactOutcome<T>): Promise<T> {
    let userError: { e: unknown } | null = null;
    try {
      assertKey(key);
      return await db.transaction(async (tx) => {
        // ۱) سریال‌سازیِ هر حساب (حتی حسابی که هنوز نیست)؛ ۲) سپر مهاجرت؛ ۳) قفل ردیف + خواندن حالت.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockName(schema, key)}, 0))`);
        await assertCurrent(tx, schema);
        const before = await loadState(tx, schema, key, true);
        if (before !== null) verify(before);
        let out: TransactOutcome<T>;
        try {
          out = fn(before === null ? null : structuredClone(before));
        } catch (e) {
          userError = { e };
          throw e;
        }
        if (out.commit !== null) await writeCommit(tx, schema, key, before, out.commit, semanticGuards);
        return out.value;
      });
    } catch (e) {
      if (userError !== null) throw (userError as { e: unknown }).e;
      throw toStoreError(e);
    }
  }

  async function read(key: AccountKey): Promise<AccountState | null> {
    try {
      assertKey(key);
      return await db.transaction(
        async (tx) => {
          await assertCurrent(tx, schema);
          const s = await loadState(tx, schema, key, false);
          if (s !== null) verify(s);
          return s;
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    } catch (e) {
      throw toStoreError(e);
    }
  }

  async function journal(key: AccountKey): Promise<readonly JournalEntry[]> {
    try {
      assertKey(key);
      return await db.transaction(
        async (tx) => {
          await assertCurrent(tx, schema);
          return loadJournal(tx, schema, key);
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    } catch (e) {
      throw toStoreError(e);
    }
  }

  return Object.freeze({
    transact,
    read,
    journal,
    migrate: () => migrate(db, schema),
    status: () => migrationStatus(db, schema),
    audit: (key: AccountKey) => auditAccount(db, schema, key),
  });
}

const isFn = (v: unknown): boolean => typeof v === "function";

/**
 * فروشگاه PostgreSQL. `db` = `drizzle(pool)` از بیرون (این ماژول اتصال نمی‌سازد). ابتدا `await store.migrate()`.
 * نام شِما `ledger` است مگر `options.schema` بدهید (فقط `^[a-z][a-z0-9_]{0,39}$`).
 */
export function createPgAccountStore(db: LedgerDatabase, options: PgStoreOptions = {}): PgStoreResult<PgAccountStore> {
  const d = db as Partial<LedgerDatabase> | null;
  if (typeof d !== "object" || d === null || !isFn(d.execute) || !isFn(d.transaction)) {
    return { ok: false, error: { code: "INVALID_INPUT", message: "«db» باید پایگاه drizzle (execute و transaction) باشد." } };
  }
  if (typeof options !== "object" || options === null) {
    return { ok: false, error: { code: "INVALID_INPUT", message: "«options» باید شیء باشد." } };
  }
  const schema = parseSchemaName(options.schema ?? LEDGER_DEFAULT_SCHEMA);
  if (!schema.ok) return schema;
  return { ok: true, value: buildPgStore(db, schema.value, true) };
}

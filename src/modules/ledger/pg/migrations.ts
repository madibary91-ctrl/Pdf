/**
 * مهاجرت‌های شِمای دفتر اعتبار — SQL دست‌نویس (🔴 ناحیهٔ پرریسک: بازبینی مالک معماری + مالک امنیت؛ ADR-0019).
 *
 * چرا SQL دست‌نویس و نه `drizzle-kit push`؟ ناورداهای اصلی (CHECK بقا، TRIGGERهای فقط‌افزودنی/بی‌حفره/یکنوا، دامنه‌ها)
 * را drizzle-kit نمی‌تواند بیان کند؛ همچنین همهٔ جدول‌ها در **شِمای جدا** هستند تا `drizzle-kit push` هرگز آن‌ها را «اضافی» نداند.
 *
 * قواعد:
 *  1. مهاجرتِ اعمال‌شده **هرگز ویرایش نمی‌شود**؛ تغییر = مهاجرت تازه (`0002_…`). تست، checksum را قفل کرده است.
 *  2. هر مهاجرت فهرستی از دستورهای جدا است و در **یک تراکنش** اجرا می‌شود.
 *  3. `{{schema}}` هنگام اجرا با نام نقل‌قول‌شدهٔ شِما (پس از اعتبارسنجی فهرست‌سفید) جایگزین می‌شود.
 *  4. قیدهای پایگاه **هم‌ارز** اعتبارسنجی مرزی ledger هستند (`ID_RE`، `UNIT_RE`، صحیح ایمن)؛ دادهٔ معتبر هرگز به‌خاطر قید رد نمی‌شود،
 *     ولی دادهٔ نامعتبر از هر مسیر دیگری (psql، اسکریپت) هم رد می‌شود (دفاع در عمق).
 *  5. پیام‌های RAISE عمداً ASCII و بی‌دادهٔ رکورد هستند.
 *  6. در CHECK، `NULL` «قبول» حساب می‌شود؛ پس هر شرطِ روی ستونِ nullable یا عبارتِ JSON با `coalesce(…, false)` یا `IS NOT NULL` بسته می‌شود.
 */
import { createHash } from "node:crypto";

export type Migration = Readonly<{ name: string; statements: readonly string[] }>;

const S = "{{schema}}";

const KINDS = "'grant', 'reserve', 'charge', 'close', 'refund'";
const JOURNAL_TYPES = "'grant', 'reserve', 'charge', 'release', 'forfeit', 'expire', 'refund'";

const m0001: Migration = {
  name: "0001_init",
  statements: [
    // ───────── دامنه‌ها: قید یک‌بار برای همهٔ ستون‌ها ─────────
    `CREATE DOMAIN ${S}.ledger_id AS text
       CONSTRAINT ledger_id_ck CHECK (VALUE ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')`,
    `CREATE DOMAIN ${S}.unit_code AS text
       CONSTRAINT unit_code_ck CHECK (VALUE ~ '^[A-Z][A-Z0-9_]{1,15}$')`,
    // هم‌ارز Number.isSafeInteger و نامنفی؛ مبلغ و زمان و شمارنده همه از این دامنه‌اند.
    `CREATE DOMAIN ${S}.amount AS bigint
       CONSTRAINT amount_ck CHECK (VALUE >= 0 AND VALUE <= 9007199254740991)`,

    // ───────── حساب: مرز سازگاری ─────────
    `CREATE TABLE ${S}.account (
       tenant_id ${S}.ledger_id NOT NULL,
       account_id ${S}.ledger_id NOT NULL,
       unit ${S}.unit_code NOT NULL,
       created_at_ms ${S}.amount NOT NULL,
       last_at_ms ${S}.amount NOT NULL,
       seq ${S}.amount NOT NULL,
       available ${S}.amount NOT NULL,
       held ${S}.amount NOT NULL,
       granted ${S}.amount NOT NULL,
       charged ${S}.amount NOT NULL,
       forfeited ${S}.amount NOT NULL,
       refunded ${S}.amount NOT NULL,
       shortfall ${S}.amount NOT NULL,
       CONSTRAINT account_pk PRIMARY KEY (tenant_id, account_id),
       CONSTRAINT account_conservation_ck CHECK (granted + refunded = available + held + charged + forfeited)
     )`,

    // ───────── رزرو ─────────
    `CREATE TABLE ${S}.reservation (
       tenant_id ${S}.ledger_id NOT NULL,
       account_id ${S}.ledger_id NOT NULL,
       reservation_id ${S}.ledger_id NOT NULL,
       amount ${S}.amount NOT NULL,
       remaining ${S}.amount NOT NULL,
       charged ${S}.amount NOT NULL,
       closed_amount ${S}.amount NOT NULL,
       status text NOT NULL,
       closed_by text,
       created_at_ms ${S}.amount NOT NULL,
       expires_at_ms ${S}.amount NOT NULL,
       closed_at_ms ${S}.amount,
       attempts jsonb NOT NULL,
       CONSTRAINT reservation_pk PRIMARY KEY (tenant_id, account_id, reservation_id),
       CONSTRAINT reservation_account_fk FOREIGN KEY (tenant_id, account_id) REFERENCES ${S}.account (tenant_id, account_id) ON DELETE RESTRICT,
       CONSTRAINT reservation_status_ck CHECK (status IN ('open', 'closed')),
       CONSTRAINT reservation_closed_by_ck CHECK (closed_by IS NULL OR closed_by IN ('release', 'forfeit', 'expiry')),
       CONSTRAINT reservation_attempts_ck CHECK (jsonb_typeof(attempts) = 'object'),
       CONSTRAINT reservation_arithmetic_ck CHECK (amount = charged + remaining + closed_amount),
       CONSTRAINT reservation_shape_ck CHECK (
         (status = 'open' AND closed_by IS NULL AND closed_at_ms IS NULL AND closed_amount = 0)
         OR (status = 'closed' AND remaining = 0 AND closed_by IS NOT NULL AND closed_at_ms IS NOT NULL)
       )
     )`,
    // رفتگر رزروهای منقضی (ل۴) فقط رزروهای باز را می‌خواهد.
    `CREATE INDEX reservation_open_expiry_idx ON ${S}.reservation (expires_at_ms) WHERE status = 'open'`,

    // ───────── کلیدهای یکتایی عملیات (بازتکرار) ─────────
    `CREATE TABLE ${S}.processed (
       tenant_id ${S}.ledger_id NOT NULL,
       account_id ${S}.ledger_id NOT NULL,
       op_key text NOT NULL,
       fingerprint text NOT NULL,
       receipt jsonb NOT NULL,
       CONSTRAINT processed_pk PRIMARY KEY (tenant_id, account_id, op_key),
       CONSTRAINT processed_account_fk FOREIGN KEY (tenant_id, account_id) REFERENCES ${S}.account (tenant_id, account_id) ON DELETE RESTRICT,
       CONSTRAINT processed_op_key_ck CHECK (char_length(op_key) <= 300 AND op_key ~ '^(grant|reserve|charge|close|refund):[A-Za-z0-9][A-Za-z0-9._:/-]*$'),
       CONSTRAINT processed_fingerprint_ck CHECK (char_length(fingerprint) BETWEEN 1 AND 2000),
       CONSTRAINT processed_receipt_ck CHECK (jsonb_typeof(receipt) = 'object' AND coalesce((receipt ->> 'kind') IN (${KINDS}), false))
     )`,

    // ───────── ژورنال فقط‌افزودنی ─────────
    `CREATE TABLE ${S}.journal (
       tenant_id ${S}.ledger_id NOT NULL,
       account_id ${S}.ledger_id NOT NULL,
       seq ${S}.amount NOT NULL,
       at_ms ${S}.amount NOT NULL,
       type text NOT NULL,
       amount ${S}.amount NOT NULL,
       shortfall ${S}.amount NOT NULL,
       reservation_id ${S}.ledger_id,
       attempt_id ${S}.ledger_id,
       ref_id ${S}.ledger_id,
       available_after ${S}.amount NOT NULL,
       held_after ${S}.amount NOT NULL,
       CONSTRAINT journal_pk PRIMARY KEY (tenant_id, account_id, seq),
       CONSTRAINT journal_account_fk FOREIGN KEY (tenant_id, account_id) REFERENCES ${S}.account (tenant_id, account_id) ON DELETE RESTRICT,
       CONSTRAINT journal_seq_ck CHECK (seq >= 1),
       CONSTRAINT journal_type_ck CHECK (type IN (${JOURNAL_TYPES})),
       CONSTRAINT journal_shortfall_ck CHECK (type = 'charge' OR shortfall = 0)
     )`,

    // ───────── TRIGGERها: ناوردای «فقط‌افزودنی»، «بی‌حفره» و «یکنوا» را خودِ پایگاه اجرا می‌کند ─────────
    `CREATE FUNCTION ${S}.forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $fn$
     BEGIN
       RAISE EXCEPTION 'ledger: append-only table' USING ERRCODE = 'integrity_constraint_violation';
     END
     $fn$`,
    `CREATE TRIGGER journal_append_only BEFORE UPDATE OR DELETE ON ${S}.journal
       FOR EACH ROW EXECUTE FUNCTION ${S}.forbid_mutation()`,
    `CREATE TRIGGER journal_no_truncate BEFORE TRUNCATE ON ${S}.journal
       FOR EACH STATEMENT EXECUTE FUNCTION ${S}.forbid_mutation()`,
    `CREATE TRIGGER processed_append_only BEFORE UPDATE OR DELETE ON ${S}.processed
       FOR EACH ROW EXECUTE FUNCTION ${S}.forbid_mutation()`,
    `CREATE TRIGGER processed_no_truncate BEFORE TRUNCATE ON ${S}.processed
       FOR EACH STATEMENT EXECUTE FUNCTION ${S}.forbid_mutation()`,
    `CREATE TRIGGER account_no_truncate BEFORE TRUNCATE ON ${S}.account
       FOR EACH STATEMENT EXECUTE FUNCTION ${S}.forbid_mutation()`,
    `CREATE TRIGGER reservation_no_truncate BEFORE TRUNCATE ON ${S}.reservation
       FOR EACH STATEMENT EXECUTE FUNCTION ${S}.forbid_mutation()`,

    `CREATE FUNCTION ${S}.journal_gapless() RETURNS trigger LANGUAGE plpgsql AS $fn$
     DECLARE
       last_seq bigint;
     BEGIN
       SELECT coalesce(max(j.seq), 0) INTO last_seq FROM ${S}.journal j
        WHERE j.tenant_id = NEW.tenant_id AND j.account_id = NEW.account_id;
       IF NEW.seq <> last_seq + 1 THEN
         RAISE EXCEPTION 'ledger: journal seq must be gapless' USING ERRCODE = 'integrity_constraint_violation';
       END IF;
       RETURN NEW;
     END
     $fn$`,
    `CREATE TRIGGER journal_gapless BEFORE INSERT ON ${S}.journal
       FOR EACH ROW EXECUTE FUNCTION ${S}.journal_gapless()`,

    `CREATE FUNCTION ${S}.account_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
     BEGIN
       IF TG_OP = 'DELETE' THEN
         RAISE EXCEPTION 'ledger: accounts are never deleted' USING ERRCODE = 'integrity_constraint_violation';
       END IF;
       IF NEW.tenant_id <> OLD.tenant_id OR NEW.account_id <> OLD.account_id OR NEW.unit <> OLD.unit OR NEW.created_at_ms <> OLD.created_at_ms THEN
         RAISE EXCEPTION 'ledger: account identity, unit and creation time are immutable' USING ERRCODE = 'integrity_constraint_violation';
       END IF;
       IF NEW.seq < OLD.seq OR NEW.last_at_ms < OLD.last_at_ms OR NEW.granted < OLD.granted OR NEW.charged < OLD.charged
          OR NEW.forfeited < OLD.forfeited OR NEW.refunded < OLD.refunded OR NEW.shortfall < OLD.shortfall THEN
         RAISE EXCEPTION 'ledger: seq, clock and totals never decrease' USING ERRCODE = 'integrity_constraint_violation';
       END IF;
       RETURN NEW;
     END
     $fn$`,
    `CREATE TRIGGER account_guard BEFORE UPDATE OR DELETE ON ${S}.account
       FOR EACH ROW EXECUTE FUNCTION ${S}.account_guard()`,

    // پس از بستن، تنها تغییرِ مجاز رشدِ `refunded` یک تلاش است (بازگشت پس از بسته‌شدن در ledger مجاز است)؛ هیچ ستون یا کلید دیگری عوض نمی‌شود.
    `CREATE FUNCTION ${S}.attempts_only_refunds_grow(old_a jsonb, new_a jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $fn$
       SELECT (SELECT count(*) FROM jsonb_object_keys(old_a)) = (SELECT count(*) FROM jsonb_object_keys(new_a))
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_each(old_a) o
            LEFT JOIN jsonb_each(new_a) n ON n.key = o.key
            WHERE n.key IS NULL
               OR (n.value -> 'requested') IS DISTINCT FROM (o.value -> 'requested')
               OR (n.value -> 'charged') IS DISTINCT FROM (o.value -> 'charged')
               OR (n.value -> 'shortfall') IS DISTINCT FROM (o.value -> 'shortfall')
               OR (n.value ->> 'refunded')::bigint < (o.value ->> 'refunded')::bigint
          )
     $fn$`,
    `CREATE FUNCTION ${S}.reservation_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
     BEGIN
       IF TG_OP = 'DELETE' THEN
         RAISE EXCEPTION 'ledger: reservations are never deleted' USING ERRCODE = 'integrity_constraint_violation';
       END IF;
       IF NEW.tenant_id <> OLD.tenant_id OR NEW.account_id <> OLD.account_id OR NEW.reservation_id <> OLD.reservation_id
          OR NEW.amount <> OLD.amount OR NEW.created_at_ms <> OLD.created_at_ms OR NEW.expires_at_ms <> OLD.expires_at_ms THEN
         RAISE EXCEPTION 'ledger: reservation identity, amount and deadlines are immutable' USING ERRCODE = 'integrity_constraint_violation';
       END IF;
       IF OLD.status = 'closed' THEN
         IF NEW.status <> 'closed' OR NEW.remaining <> OLD.remaining OR NEW.charged <> OLD.charged OR NEW.closed_amount <> OLD.closed_amount
            OR NEW.closed_by IS DISTINCT FROM OLD.closed_by OR NEW.closed_at_ms IS DISTINCT FROM OLD.closed_at_ms
            OR NOT ${S}.attempts_only_refunds_grow(OLD.attempts, NEW.attempts) THEN
           RAISE EXCEPTION 'ledger: a closed reservation is final (only refunds may grow)' USING ERRCODE = 'integrity_constraint_violation';
         END IF;
       END IF;
       IF NEW.charged < OLD.charged THEN
         RAISE EXCEPTION 'ledger: charged never decreases' USING ERRCODE = 'integrity_constraint_violation';
       END IF;
       RETURN NEW;
     END
     $fn$`,
    `CREATE TRIGGER reservation_guard BEFORE UPDATE OR DELETE ON ${S}.reservation
       FOR EACH ROW EXECUTE FUNCTION ${S}.reservation_guard()`,
  ],
};

export const MIGRATIONS: readonly Migration[] = [m0001];

/** checksum محتوای مهاجرت (نام + دستورها)؛ تغییرِ مهاجرتِ اعمال‌شده با آن شناسایی می‌شود. */
export function migrationChecksum(m: Migration): string {
  return createHash("sha256").update(JSON.stringify([m.name, m.statements])).digest("hex");
}

/** جایگزینی `{{schema}}` با نام نقل‌قول‌شده. `schema` باید پیشتر با `parseSchemaName` تأیید شده باشد. */
export function renderStatement(statement: string, schema: string): string {
  return statement.split(S).join(`"${schema}"`);
}

/**
 * مهاجرت‌های شِمای outbox تسویه — SQL دست‌نویس (🔴 ناحیهٔ پرریسک: پول؛ بازبینی مالک معماری + مالک امنیت؛ ADR-0022).
 *
 * چرا SQL دست‌نویس؟ ناورداهای اصلی (شکلِ هر وضعیت، قصدِ نوشتن‌یک‌بار، نهایی‌بودنِ done/dead، بی‌حذف) را `drizzle-kit` نمی‌تواند بیان کند؛
 * همچنین جدول‌ها در **شِمای جدا** هستند تا `drizzle-kit push` هرگز آن‌ها را «اضافی» نداند.
 *
 * قواعد (همان ledger/pg/migrations.ts):
 *  1. مهاجرتِ اعمال‌شده **هرگز ویرایش نمی‌شود**؛ تغییر = مهاجرت تازه (`0002_…`). تست، checksum را قفل کرده است.
 *  2. هر مهاجرت فهرستی از دستورهای جدا است و در **یک تراکنش** اجرا می‌شود.
 *  3. `{{schema}}` هنگام اجرا با نام نقل‌قول‌شدهٔ شِما (پس از اعتبارسنجی فهرست‌سفید) جایگزین می‌شود.
 *  4. قیدهای پایگاه **هم‌ارز** اعتبارسنجی مرزی settlement هستند (`ID_RE`، `UNIT_RE`، صحیح ایمن، کدهای خطا)؛ دادهٔ معتبر هرگز به‌خاطر قید
 *     رد نمی‌شود، ولی دادهٔ نامعتبر از هر مسیر دیگری (psql، اسکریپت) هم رد می‌شود (دفاع در عمق).
 *  5. پیام‌های RAISE عمداً ASCII و بی‌دادهٔ رکورد هستند.
 *  6. در CHECK، `NULL` «قبول» حساب می‌شود؛ پس هر شرطِ روی ستونِ nullable با `IS [NOT] NULL` صریح بسته می‌شود.
 *  7. شناسه‌ها با `COLLATE "C"` مقایسه می‌شوند تا ترتیب (سررسید، شناسه) با ترتیب نقطه‌کدِ outbox حافظه‌ای یکی باشد، نه وابسته به locale پایگاه.
 */
import { createHash } from "node:crypto";

export type Migration = Readonly<{ name: string; statements: readonly string[] }>;

const S = "{{schema}}";

const m0001: Migration = {
  name: "0001_init",
  statements: [
    // ───────── دامنه‌ها: قید یک‌بار برای همهٔ ستون‌ها ─────────
    `CREATE DOMAIN ${S}.settlement_id AS text COLLATE "C"
       CONSTRAINT settlement_id_ck CHECK (VALUE ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')`,
    `CREATE DOMAIN ${S}.settlement_unit AS text
       CONSTRAINT settlement_unit_ck CHECK (VALUE ~ '^[A-Z][A-Z0-9_]{1,15}$')`,
    // هم‌ارز Number.isSafeInteger و نامنفی؛ مبلغ و زمان و شمارنده همه از این دامنه‌اند.
    `CREATE DOMAIN ${S}.settlement_count AS bigint
       CONSTRAINT settlement_count_ck CHECK (VALUE >= 0 AND VALUE <= 9007199254740991)`,
    `CREATE DOMAIN ${S}.settlement_error_code AS text
       CONSTRAINT settlement_error_code_ck CHECK (VALUE ~ '^[A-Z][A-Z0-9_]{0,63}$')`,

    // ───────── outbox: یک ردیف به ازای هر رزرو ─────────
    `CREATE TABLE ${S}.settlement_outbox (
       tenant_id ${S}.settlement_id NOT NULL,
       account_id ${S}.settlement_id NOT NULL,
       reservation_id ${S}.settlement_id NOT NULL,
       unit ${S}.settlement_unit NOT NULL,
       reserved ${S}.settlement_count NOT NULL,
       created_at_ms ${S}.settlement_count NOT NULL,
       expires_at_ms ${S}.settlement_count NOT NULL,
       due_at_ms ${S}.settlement_count NOT NULL,
       orphan_remainder text NOT NULL,
       state text NOT NULL,
       charge_attempt_id ${S}.settlement_id,
       charge_amount ${S}.settlement_count,
       close_remainder text,
       close_origin text,
       attempts ${S}.settlement_count NOT NULL DEFAULT 0,
       last_error_code ${S}.settlement_error_code,
       dead_reason text,
       settled_at_ms ${S}.settlement_count,
       CONSTRAINT settlement_outbox_pk PRIMARY KEY (tenant_id, account_id, reservation_id),
       CONSTRAINT settlement_outbox_reserved_ck CHECK (reserved >= 1),
       CONSTRAINT settlement_outbox_orphan_ck CHECK (orphan_remainder IN ('release', 'forfeit')),
       CONSTRAINT settlement_outbox_state_ck CHECK (state IN ('open', 'settling', 'done', 'dead')),
       CONSTRAINT settlement_outbox_charge_shape_ck CHECK ((charge_attempt_id IS NULL) = (charge_amount IS NULL)),
       CONSTRAINT settlement_outbox_close_shape_ck CHECK ((close_remainder IS NULL) = (close_origin IS NULL)),
       CONSTRAINT settlement_outbox_close_values_ck CHECK (
         close_remainder IS NULL OR (close_remainder IN ('release', 'forfeit') AND close_origin IN ('caller', 'sweeper'))
       ),
       CONSTRAINT settlement_outbox_dead_reason_ck CHECK (
         dead_reason IS NULL OR dead_reason IN ('EXPIRED_UNBILLED', 'ATTEMPTS_EXHAUSTED', 'LEDGER_REJECTED')
       ),
       -- شکلِ هر وضعیت: open بی‌قصد؛ settling دست‌کم یک قصد؛ done قصدِ بستن و زمان؛ dead دلیل و زمان.
       CONSTRAINT settlement_outbox_state_shape_ck CHECK (
         CASE state
           WHEN 'open' THEN charge_attempt_id IS NULL AND close_remainder IS NULL AND dead_reason IS NULL AND settled_at_ms IS NULL
           WHEN 'settling' THEN (charge_attempt_id IS NOT NULL OR close_remainder IS NOT NULL) AND dead_reason IS NULL AND settled_at_ms IS NULL
           WHEN 'done' THEN close_remainder IS NOT NULL AND dead_reason IS NULL AND settled_at_ms IS NOT NULL
           WHEN 'dead' THEN dead_reason IS NOT NULL AND settled_at_ms IS NOT NULL
           ELSE false
         END
       )
     )`,

    // ───────── ایندکس‌ها ─────────
    // رفتگر: فقط رکوردهای فعال به ترتیب (سررسید، شناسه) — جزئی تا رکوردهای done (که رشد می‌کنند) هزینه نسازند.
    `CREATE INDEX settlement_outbox_due_idx ON ${S}.settlement_outbox (due_at_ms, tenant_id, account_id, reservation_id)
       WHERE state IN ('open', 'settling')`,
    `CREATE INDEX settlement_outbox_dead_idx ON ${S}.settlement_outbox (settled_at_ms, tenant_id, account_id, reservation_id)
       WHERE state = 'dead'`,
    `CREATE INDEX settlement_outbox_state_idx ON ${S}.settlement_outbox (state)`,

    // ───────── TRIGGERها: ناوردای «بی‌حذف»، «نوشتن‌یک‌بارِ قصد» و «نهایی‌بودن» را خودِ پایگاه اجرا می‌کند ─────────
    `CREATE FUNCTION ${S}.settlement_forbid_truncate() RETURNS trigger LANGUAGE plpgsql AS $fn$
     BEGIN
       RAISE EXCEPTION 'settlement: the outbox is never truncated' USING ERRCODE = 'integrity_constraint_violation';
     END
     $fn$`,
    `CREATE TRIGGER settlement_outbox_no_truncate BEFORE TRUNCATE ON ${S}.settlement_outbox
       FOR EACH STATEMENT EXECUTE FUNCTION ${S}.settlement_forbid_truncate()`,

    `CREATE FUNCTION ${S}.settlement_outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
     BEGIN
       IF TG_OP = 'DELETE' THEN
         RAISE EXCEPTION 'settlement: outbox records are never deleted' USING ERRCODE = 'integrity_constraint_violation';
       END IF;
       IF OLD.state IN ('done', 'dead') THEN
         RAISE EXCEPTION 'settlement: a finished record is final' USING ERRCODE = 'integrity_constraint_violation';
       END IF;
       IF NEW.tenant_id <> OLD.tenant_id OR NEW.account_id <> OLD.account_id OR NEW.reservation_id <> OLD.reservation_id
          OR NEW.unit <> OLD.unit OR NEW.reserved <> OLD.reserved OR NEW.created_at_ms <> OLD.created_at_ms
          OR NEW.expires_at_ms <> OLD.expires_at_ms OR NEW.orphan_remainder <> OLD.orphan_remainder THEN
         RAISE EXCEPTION 'settlement: identity and the begin facts are immutable' USING ERRCODE = 'integrity_constraint_violation';
       END IF;
       IF OLD.charge_attempt_id IS NOT NULL
          AND (NEW.charge_attempt_id IS DISTINCT FROM OLD.charge_attempt_id OR NEW.charge_amount IS DISTINCT FROM OLD.charge_amount) THEN
         RAISE EXCEPTION 'settlement: the charge intent is write-once' USING ERRCODE = 'integrity_constraint_violation';
       END IF;
       IF OLD.close_remainder IS NOT NULL
          AND (NEW.close_remainder IS DISTINCT FROM OLD.close_remainder OR NEW.close_origin IS DISTINCT FROM OLD.close_origin) THEN
         RAISE EXCEPTION 'settlement: the close intent is write-once' USING ERRCODE = 'integrity_constraint_violation';
       END IF;
       IF OLD.close_remainder IS NOT NULL AND OLD.charge_attempt_id IS NULL AND NEW.charge_attempt_id IS NOT NULL THEN
         RAISE EXCEPTION 'settlement: no charge intent after the close intent' USING ERRCODE = 'integrity_constraint_violation';
       END IF;
       IF NEW.attempts < OLD.attempts THEN
         RAISE EXCEPTION 'settlement: attempts never decrease' USING ERRCODE = 'integrity_constraint_violation';
       END IF;
       IF OLD.state = 'settling' AND NEW.state = 'open' THEN
         RAISE EXCEPTION 'settlement: a record never returns to open' USING ERRCODE = 'integrity_constraint_violation';
       END IF;
       RETURN NEW;
     END
     $fn$`,
    `CREATE TRIGGER settlement_outbox_guard BEFORE UPDATE OR DELETE ON ${S}.settlement_outbox
       FOR EACH ROW EXECUTE FUNCTION ${S}.settlement_outbox_guard()`,
  ],
};

/**
 * 0002 — تأیید رسیدگی به رکوردهای مرده (ADR-0025). **افزایشی و بی‌دست‌زدن به جدول و TRIGGERهای 0001**:
 * رکوردِ outbox پس از `dead` نهایی و تغییرناپذیر می‌ماند (ناوردای «نهایی‌بودن»، `settlement_outbox_guard`)؛ تأیید حقیقتی جدا و نوشتن‌یک‌بار است
 * و در جدول خودش می‌نشیند. رکوردهای مرده‌ای که پیش از این مهاجرت وجود داشتند ردیفِ تأیید ندارند ⇒ «تأییدنشده» می‌شوند (هیچ زنگی را گم‌شده فرض نمی‌کنیم).
 * ناوردا را خودِ پایگاه اجرا می‌کند: فقط برای رکوردِ موجودِ `dead` (TRIGGER)، بی‌ویرایش، بی‌حذف، بی‌TRUNCATE.
 * عمداً **FOREIGN KEY ندارد**: FK جلوی `TRUNCATE` جدول مرجع را پیش از TRIGGERِ 0001 با خطای `0A000` می‌گیرد و پیامِ ناوردای «outbox هرگز TRUNCATE نمی‌شود» را عوض می‌کرد؛
 * TRIGGERِ درج همان تضمین را می‌دهد (ردیفِ outbox باید موجود و `dead` باشد؛ `dead` نهایی است و حذف‌پذیر نیست، پس ردیفِ تأیید هرگز یتیم نمی‌شود).
 */
const m0002: Migration = {
  name: "0002_dead_ack",
  statements: [
    `CREATE TABLE ${S}.settlement_dead_ack (
       tenant_id ${S}.settlement_id NOT NULL,
       account_id ${S}.settlement_id NOT NULL,
       reservation_id ${S}.settlement_id NOT NULL,
       acked_at_ms ${S}.settlement_count NOT NULL,
       CONSTRAINT settlement_dead_ack_pk PRIMARY KEY (tenant_id, account_id, reservation_id)
     )`,
    `CREATE FUNCTION ${S}.settlement_dead_ack_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
     BEGIN
       IF TG_OP <> 'INSERT' THEN
         RAISE EXCEPTION 'settlement: an acknowledgement is write-once and never deleted' USING ERRCODE = 'integrity_constraint_violation';
       END IF;
       IF NOT EXISTS (
         SELECT 1 FROM ${S}.settlement_outbox o
         WHERE o.tenant_id = NEW.tenant_id AND o.account_id = NEW.account_id AND o.reservation_id = NEW.reservation_id AND o.state = 'dead'
       ) THEN
         RAISE EXCEPTION 'settlement: only a dead record can be acknowledged' USING ERRCODE = 'integrity_constraint_violation';
       END IF;
       RETURN NEW;
     END
     $fn$`,
    `CREATE TRIGGER settlement_dead_ack_guard BEFORE INSERT OR UPDATE OR DELETE ON ${S}.settlement_dead_ack
       FOR EACH ROW EXECUTE FUNCTION ${S}.settlement_dead_ack_guard()`,
    `CREATE TRIGGER settlement_dead_ack_no_truncate BEFORE TRUNCATE ON ${S}.settlement_dead_ack
       FOR EACH STATEMENT EXECUTE FUNCTION ${S}.settlement_forbid_truncate()`,
  ],
};

export const MIGRATIONS: readonly Migration[] = [m0001, m0002];

/** checksum محتوای مهاجرت (نام + دستورها)؛ تغییرِ مهاجرتِ اعمال‌شده با آن شناسایی می‌شود. */
export function migrationChecksum(m: Migration): string {
  return createHash("sha256").update(JSON.stringify([m.name, m.statements])).digest("hex");
}

/** جایگزینی `{{schema}}` با نام نقل‌قول‌شده. `schema` باید پیشتر با `parseSchemaName` تأیید شده باشد. */
export function renderStatement(statement: string, schema: string): string {
  return statement.split(S).join(`"${schema}"`);
}

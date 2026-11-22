/**
 * مهاجرت‌های نمایهٔ مشتقِ «مرده‌های در انتظارِ تأیید» — SQL دست‌نویس (🔴 ناحیهٔ پرریسک: پول؛ ADR-0046).
 *
 * **دفترِ مهاجرتِ جدا** (`settlement_pending_migration_ledger`): `MIGRATIONS` ی settlement و آزمون‌های قفل‌شدهٔ آن دست‌نخورده می‌مانند
 * (همان الگوی `<schema>_search` در legal-kb-store). نبودنِ این مهاجرت ⇒ هیچ رفتاری در settlement عوض نمی‌شود؛ نمایه اختیاری است.
 *
 * قواعد (همان settlement/pg/migrations.ts):
 *  1. مهاجرتِ اعمال‌شده **هرگز ویرایش نمی‌شود**؛ تغییر = مهاجرت تازه (`0002_…`). تست، checksum را قفل کرده است.
 *  2. هر مهاجرت فهرستی از دستورهای جدا است و در **یک تراکنش** اجرا می‌شود.
 *  3. `{{schema}}` هنگام اجرا با نامِ نقل‌قول‌شدهٔ شِما (پس از اعتبارسنجی فهرست‌سفید) جایگزین می‌شود.
 *  4. پیام‌های RAISE عمداً ASCII و بی‌دادهٔ رکورد هستند.
 */
import { createHash } from "node:crypto";

export type Migration = Readonly<{ name: string; statements: readonly string[] }>;

const S = "{{schema}}";

/**
 * 0001 — نمایهٔ «مرده‌های در انتظارِ تأیید».
 *
 * **ناوردا (که همین مهاجرت برقرار می‌کند و `verify()` می‌سنجد):** ردیفِ `(کلید، settled_at_ms)` در `settlement_dead_pending` هست ⇔ رکوردِ outbox
 * `dead` است و ردیفِ تأیید ندارد. نگهداری با TRIGGERهای **همان تراکنشِ نویسنده** است، پس هیچ پنجرهٔ ناسازگاری و هیچ تغییرِ کدِ رفتگر/آداپتور نیست:
 *  - `AFTER INSERT/UPDATE` روی outbox هنگام ورود به `dead` ردیف می‌افزاید (`dead` نهایی است و برنمی‌گردد؛ TRIGGERِ `settlement_outbox_guard`).
 *  - `AFTER INSERT` روی `settlement_dead_ack` ردیف را حذف می‌کند (تأیید فقط برای رکوردِ موجودِ `dead` و نوشتن‌یک‌بار است).
 *  - TRIGGERِ نگهبانِ خودِ نمایه: درج/حذف/ویرایش/TRUNCATE فقط از **درونِ TRIGGERهای بالا** (`pg_trigger_depth() ≥ 2`) پذیرفته می‌شود؛
 *    `DELETE FROM settlement_dead_pending` دستی از psql رد می‌شود، چون حذفِ بی‌صدا یعنی زنگِ مرده‌ای که پایش نمی‌بیند.
 *
 * **backfill** در همان تراکنش و زیر `LOCK TABLE … SHARE ROW EXCLUSIVE` روی outbox و تأییدها: نویسنده‌ها (رفتگر، تأیید) تا پایانِ مهاجرت منتظر می‌مانند
 * (خواندن‌ها نه) و هیچ رکوردی میانِ «پر کردن» و «نصبِ TRIGGER» از دست نمی‌رود. `lock_timeout` ۱۵ ثانیه است: اگر نویسندهٔ طولانی قفل را نداد،
 * مهاجرت **شکست‌بسته** برمی‌گردد و چیزی عوض نمی‌شود (DDL پستگرس تراکنشی است).
 * هزینه: O(مرده‌ها + تأییدها) یک‌بار؛ زمانِ انسدادِ نویسنده‌ها ≈ زمانِ همین پیمایش (در ADR-0046 اندازه‌گیری و گزارش شده است).
 *
 * **جدولِ پرگردش (queue-like):** هر مرده یک درج و (پس از تأیید) یک حذف است؛ پس خودِ هیپ با گردش «باد می‌کند» (بلوک‌های خالی تا vacuum). برای همین پارامترهای
 * autovacuum **روی همین جدول** به‌جای نسبت (`scale_factor = 0`) آستانهٔ ثابتِ ۲۰۰ ردیفِ مرده دارند تا اندازه‌اش به اندازهٔ تأییدنشده‌ها + حدِ ۲۰۰ نزدیک بماند، نه به
 * نسبتِ تاریخچه. (اندازه‌گیری: ADR-0046 «یافتهٔ ۲».) این فقط ریزشِ بلوک است؛ **کارِ منطقی** (ردیفِ خوانده‌شده) به تأییدشده‌ها وابسته نیست.
 *
 * ستون‌ها از **دامنه‌های settlement** (`settlement_id` با `COLLATE "C"` و `settlement_count`) هستند تا ترتیبِ `(settled_at_ms, شناسه‌ها)` دقیقاً همان
 * ترتیبِ `listDead` و outbox حافظه‌ای باشد، نه وابسته به locale پایگاه.
 */
const m0001: Migration = {
  name: "0001_dead_pending",
  statements: [
    `SET LOCAL lock_timeout = '15s'`,
    `LOCK TABLE ${S}.settlement_outbox, ${S}.settlement_dead_ack IN SHARE ROW EXCLUSIVE MODE`,

    `CREATE TABLE ${S}.settlement_dead_pending (
       tenant_id ${S}.settlement_id NOT NULL,
       account_id ${S}.settlement_id NOT NULL,
       reservation_id ${S}.settlement_id NOT NULL,
       settled_at_ms ${S}.settlement_count NOT NULL,
       CONSTRAINT settlement_dead_pending_pk PRIMARY KEY (tenant_id, account_id, reservation_id)
     ) WITH (autovacuum_vacuum_scale_factor = 0, autovacuum_vacuum_threshold = 200, autovacuum_analyze_scale_factor = 0, autovacuum_analyze_threshold = 200)`,
    // ترتیبِ خواندنِ پایش؛ کلیدِ کامل در ایندکس تا `LIMIT` بی‌Sort و بی‌مرتب‌سازیِ دوباره بسته شود.
    `CREATE INDEX settlement_dead_pending_order_idx ON ${S}.settlement_dead_pending (settled_at_ms, tenant_id, account_id, reservation_id)`,

    // ───────── نگهداری: ورود به dead ─────────
    `CREATE FUNCTION ${S}.settlement_pending_on_dead() RETURNS trigger LANGUAGE plpgsql AS $fn$
     BEGIN
       INSERT INTO ${S}.settlement_dead_pending (tenant_id, account_id, reservation_id, settled_at_ms)
       VALUES (NEW.tenant_id, NEW.account_id, NEW.reservation_id, NEW.settled_at_ms)
       ON CONFLICT (tenant_id, account_id, reservation_id) DO NOTHING;
       RETURN NULL;
     END
     $fn$`,
    // درجِ مستقیمِ رکوردِ dead (قیدِ شکلِ وضعیت اجازه می‌دهد) و گذار به dead (مسیرِ عادیِ `bury`/`recordFailure`).
    `CREATE TRIGGER settlement_pending_dead_ins AFTER INSERT ON ${S}.settlement_outbox
       FOR EACH ROW WHEN (NEW.state = 'dead') EXECUTE FUNCTION ${S}.settlement_pending_on_dead()`,
    `CREATE TRIGGER settlement_pending_dead_upd AFTER UPDATE ON ${S}.settlement_outbox
       FOR EACH ROW WHEN (NEW.state = 'dead' AND OLD.state IS DISTINCT FROM 'dead') EXECUTE FUNCTION ${S}.settlement_pending_on_dead()`,

    // ───────── نگهداری: تأیید ─────────
    `CREATE FUNCTION ${S}.settlement_pending_on_ack() RETURNS trigger LANGUAGE plpgsql AS $fn$
     BEGIN
       DELETE FROM ${S}.settlement_dead_pending
       WHERE tenant_id = NEW.tenant_id AND account_id = NEW.account_id AND reservation_id = NEW.reservation_id;
       RETURN NULL;
     END
     $fn$`,
    `CREATE TRIGGER settlement_pending_ack AFTER INSERT ON ${S}.settlement_dead_ack
       FOR EACH ROW EXECUTE FUNCTION ${S}.settlement_pending_on_ack()`,

    // ───────── backfill: همان معنای «مرده بی‌تأیید» ─────────
    `INSERT INTO ${S}.settlement_dead_pending (tenant_id, account_id, reservation_id, settled_at_ms)
       SELECT o.tenant_id, o.account_id, o.reservation_id, o.settled_at_ms
       FROM ${S}.settlement_outbox o
       WHERE o.state = 'dead'
         AND NOT EXISTS (SELECT 1 FROM ${S}.settlement_dead_ack a WHERE a.tenant_id = o.tenant_id AND a.account_id = o.account_id AND a.reservation_id = o.reservation_id)`,

    // ───────── نگهبانِ نمایه (پس از backfill نصب می‌شود؛ backfill خودش بیرون از TRIGGER است) ─────────
    `CREATE FUNCTION ${S}.settlement_pending_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
     BEGIN
       IF TG_OP = 'TRUNCATE' OR TG_OP = 'UPDATE' OR pg_trigger_depth() < 2 THEN
         RAISE EXCEPTION 'settlement: the pending index is maintained only by the outbox triggers' USING ERRCODE = 'integrity_constraint_violation';
       END IF;
       IF TG_OP = 'DELETE' THEN
         RETURN OLD;
       END IF;
       RETURN NEW;
     END
     $fn$`,
    `CREATE TRIGGER settlement_dead_pending_guard BEFORE INSERT OR UPDATE OR DELETE ON ${S}.settlement_dead_pending
       FOR EACH ROW EXECUTE FUNCTION ${S}.settlement_pending_guard()`,
    `CREATE TRIGGER settlement_dead_pending_no_truncate BEFORE TRUNCATE ON ${S}.settlement_dead_pending
       FOR EACH STATEMENT EXECUTE FUNCTION ${S}.settlement_pending_guard()`,
  ],
};

export const MIGRATIONS: readonly Migration[] = [m0001];

/**
 * برگشتِ رسمیِ هر مهاجرت (ADR-0048، ب‑۲‑۲‑۱) — **نصبِ معکوس**؛ کلیدش نامِ مهاجرتِ `MIGRATIONS` است (آزمون: هر مهاجرت یک برگشت دارد و برعکس).
 * برگشتِ یک مهاجرت **هرگز ویرایشِ آن مهاجرت نیست** (checksum اعمال‌شده دست‌نخورده می‌ماند)؛ مهاجرتِ تازه ⇒ برگشتِ تازه، در همین نگاشت.
 *
 * قواعد:
 *  1. **همان قفل و همان ترتیب‌ِ نصب** (`SET LOCAL lock_timeout` ← `LOCK TABLE outbox, ack`): نویسنده‌ها یا هر دو را با هم می‌گیرند یا منتظرند ⇒ بدونِ ترتیبِ تازه.
 *     قفل اینجا `ACCESS EXCLUSIVE` است چون `DROP TRIGGER` آن را می‌خواهد (نصب `SHARE ROW EXCLUSIVE` بود)؛ زمانِ نگهداشتنش O(۱) است (بی‌پیمایش و بی‌backfill)،
 *     ولی **خواننده‌ها هم** در همین فاصله منتظرند (سقفِ انتظارِ آن‌ها statement_timeout خودشان است).
 *  2. **هرگز `CASCADE`**: اگر شیئی (مثلاً یک view) به نمایه وابسته شده، `DROP` شکست می‌خورد و **کلِ تراکنش برمی‌گردد** — حذفِ بی‌صدای شیءِ دیگران ممنوع است.
 *  3. `IF EXISTS`: برگشت باید بتواند **نصبِ ناقصِ دست‌خورده** (مثلاً TRIGGERِ حذف‌شده) را هم پاک کند؛ تشخیصِ ناهمخوانی کارِ `verify` است نه برگشت.
 *  4. ترتیبِ حذف: TRIGGERهای روی outbox/ack (تا نویسنده دیگر چیزی در نمایه ننویسد) ← جدولِ نمایه (TRIGGERها و ایندکسش با آن می‌روند) ← توابع.
 *  5. به `settlement_outbox`/`settlement_dead_ack` **داده‌ای نوشته یا حذف نمی‌شود**؛ فقط TRIGGERهای همین ماژول از رویشان برداشته می‌شوند.
 */
const ROLLBACKS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "0001_dead_pending": Object.freeze([
    `SET LOCAL lock_timeout = '15s'`,
    `LOCK TABLE ${S}.settlement_outbox, ${S}.settlement_dead_ack IN ACCESS EXCLUSIVE MODE`,

    `DROP TRIGGER IF EXISTS settlement_pending_dead_ins ON ${S}.settlement_outbox`,
    `DROP TRIGGER IF EXISTS settlement_pending_dead_upd ON ${S}.settlement_outbox`,
    `DROP TRIGGER IF EXISTS settlement_pending_ack ON ${S}.settlement_dead_ack`,

    // با جدول، نگهبان‌های BEFORE (درج/ویرایش/حذف و TRUNCATE) و ایندکسِ ترتیب هم می‌روند.
    `DROP TABLE IF EXISTS ${S}.settlement_dead_pending`,

    `DROP FUNCTION IF EXISTS ${S}.settlement_pending_on_dead()`,
    `DROP FUNCTION IF EXISTS ${S}.settlement_pending_on_ack()`,
    `DROP FUNCTION IF EXISTS ${S}.settlement_pending_guard()`,
  ]),
});

/** دستورهای برگشتِ یک مهاجرتِ شناخته‌شده؛ مهاجرتِ بی‌برگشت `undefined` است (فراخوان باید شکست‌بسته رفتار کند). */
export function rollbackStatements(name: string): readonly string[] | undefined {
  return Object.hasOwn(ROLLBACKS, name) ? ROLLBACKS[name] : undefined;
}

/** نام‌های دارای برگشت (برای آزمونِ همخوانی با `MIGRATIONS`). */
export const ROLLBACK_NAMES: readonly string[] = Object.freeze(Object.keys(ROLLBACKS));

/** checksum محتوای مهاجرت (نام + دستورها)؛ تغییرِ مهاجرتِ اعمال‌شده با آن شناسایی می‌شود. */
export function migrationChecksum(m: Migration): string {
  return createHash("sha256").update(JSON.stringify([m.name, m.statements])).digest("hex");
}

/** جایگزینی `{{schema}}` با نامِ نقل‌قول‌شده. `schema` باید پیشتر با `parseSchemaName` تأیید شده باشد. */
export function renderStatement(statement: string, schema: string): string {
  return statement.split(S).join(`"${schema}"`);
}

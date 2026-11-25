/**
 * آداپتور PostgreSQL پورتِ `PolicyVersionStore` (ADR-0070، برش CT‑5c‑2b‑2).
 * ضمانت‌ها (آزمونِ قراردادِ مشترکِ tool-policy-admin را می‌گذراند):
 *  - `append` اتمی و CAS است: «آخرین+۱» را تریگرِ پایگاه و کلیدِ اصلی تضمین می‌کنند؛ بازندهٔ مسابقه `CONFLICT` می‌گیرد، نه استثنا.
 *  - رکوردِ ورودی و هر ردیفِ خوانده‌شده با `parsePolicyRecord` سنجیده می‌شود (ذخیره‌ساز یک مرز است)؛ ردیفِ خراب بسته می‌شکند.
 *  - هر عملیات یک تراکنشِ کوتاه با سقفِ `statement_timeout`/`lock_timeout`؛ مهاجرتِ ناهمخوان یا نگهبانِ خاموش ⇒ `UNAVAILABLE`.
 *  - هرگز نمی‌پرتابد؛ خطا فقط کدِ ثابتِ پورت است (متنِ خطای pg، SQL و دادهٔ رکورد هرگز بیرون نمی‌رود).
 * همهٔ مقدارها پارامترِ پیوندی‌اند؛ تنها متنِ ثابتِ SQL فهرستِ ستون‌های `RECORD_COLUMNS` است.
 */
import { sql } from "drizzle-orm";
import { parsePolicyRecord, type PolicyVersionRecord, type PolicyVersionStore, type StoreErrorCode, type StoreResult } from "@/modules/tool-policy-admin";
import { corrupt, toStoreCode } from "./errors";
import { assertCurrent, assertWritable, migrate, status } from "./migrate";
import { TOOL_POLICY_DEFAULT_SCHEMA, VERSIONS_TABLE, parseSchemaName, tableRef } from "./naming";
import { RECORD_COLUMNS, rowToRecord } from "./rows";
import type { PgPolicyResult, PgPolicyStoreOptions, PgPolicyVersionStore, PolicyPgDatabase, PolicyPgExecutor } from "./types";

export const STORE_LIMITS = Object.freeze({ minTimeoutMs: 100, maxTimeoutMs: 60_000, defaultTimeoutMs: 5000, maxListLimit: 1000 });

const ok = <T>(value: T): StoreResult<T> => ({ ok: true, value });
const fail = (code: StoreErrorCode): StoreResult<never> => ({ ok: false, error: Object.freeze({ code }) });
const isSafeInt = (v: unknown, lo: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= lo;
const COLUMNS = sql.raw(RECORD_COLUMNS);

export function createPgPolicyVersionStore(db: PolicyPgDatabase, options: PgPolicyStoreOptions = {}): PgPolicyResult<PgPolicyVersionStore> {
  const parsed = parseSchemaName(options.schema ?? TOOL_POLICY_DEFAULT_SCHEMA);
  if (!parsed.ok) return parsed;
  const schema = parsed.value;
  const timeout = options.statementTimeoutMs ?? STORE_LIMITS.defaultTimeoutMs;
  if (!isSafeInt(timeout, STORE_LIMITS.minTimeoutMs) || timeout > STORE_LIMITS.maxTimeoutMs) {
    return { ok: false, error: { code: "INVALID_INPUT", message: `statementTimeoutMs باید عددِ صحیحی در ${STORE_LIMITS.minTimeoutMs} تا ${STORE_LIMITS.maxTimeoutMs} باشد.` } };
  }
  const table = tableRef(schema, VERSIONS_TABLE);

  async function run<T>(mode: "read" | "write", fn: (tx: PolicyPgExecutor) => Promise<T>): Promise<StoreResult<T>> {
    try {
      const value = await db.transaction(
        async (tx) => {
          await tx.execute(sql`SELECT set_config('statement_timeout', ${String(timeout)}, true), set_config('lock_timeout', ${String(timeout)}, true)`);
          await assertCurrent(tx, schema);
          if (mode === "write") await assertWritable(tx, schema);
          return fn(tx);
        },
        { accessMode: mode === "read" ? "read only" : "read write" },
      );
      return ok(value);
    } catch (e) {
      return fail(toStoreCode(e));
    }
  }

  const store: PolicyVersionStore = {
    latest: () =>
      run("read", async (tx) => {
        const res = await tx.execute(sql`SELECT ${COLUMNS} FROM ${table} ORDER BY version DESC LIMIT 1`);
        if (res.rows.length === 0) return null;
        return rowToRecord(res.rows[0]);
      }),

    get: async (version) => {
      if (!isSafeInt(version, 1)) return fail("INVALID");
      return run("read", async (tx) => {
        const res = await tx.execute(sql`SELECT ${COLUMNS} FROM ${table} WHERE version = ${String(version)}::bigint`);
        if (res.rows.length === 0) return null;
        if (res.rows.length !== 1) throw corrupt("پرسشِ یک نسخه چند ردیف برگرداند.");
        const rec = rowToRecord(res.rows[0]);
        if (rec.version !== version) throw corrupt("ردیفِ برگشتی نسخهٔ خواسته‌شده نیست.");
        return rec;
      });
    },

    append: async (record) => {
      const rec = parsePolicyRecord(record); // عکسِ یک‌بارهٔ مستقل: آنچه سنجیده شد همان است که نوشته می‌شود
      if (rec === null) return fail("INVALID");
      const r = await run("write", async (tx) => {
        const res = await tx.execute(sql`INSERT INTO ${table}
          (version, overrides, policy, changes, source_kind, source_to_version, actor, reason, created_at_ms)
          VALUES (${String(rec.version)}::bigint, ${JSON.stringify(rec.overrides)}::jsonb, ${JSON.stringify(rec.policy)}::jsonb, ${JSON.stringify(rec.changes)}::jsonb,
            ${rec.source.kind}, ${rec.source.kind === "rollback" ? String(rec.source.toVersion) : null}::bigint, ${rec.actor}, ${rec.reason}, ${String(rec.createdAtMs)}::bigint)
          ON CONFLICT (version) DO NOTHING RETURNING version`);
        return res.rows.length === 1;
      });
      if (!r.ok) return r;
      return r.value ? ok(null) : fail("CONFLICT");
    },

    list: async (query) => {
      const { beforeVersion, limit } = query;
      if (!isSafeInt(limit, 1) || limit > STORE_LIMITS.maxListLimit || (beforeVersion !== null && !isSafeInt(beforeVersion, 1))) return fail("INVALID");
      return run("read", async (tx) => {
        const before = beforeVersion === null ? null : String(beforeVersion);
        const res = await tx.execute(sql`SELECT ${COLUMNS} FROM ${table}
          WHERE (${before}::bigint IS NULL OR version < ${before}::bigint) ORDER BY version DESC LIMIT ${limit}`);
        if (res.rows.length > limit) throw corrupt("پرسشِ فهرست بیش از limit ردیف برگرداند.");
        const out: PolicyVersionRecord[] = [];
        for (const row of res.rows) {
          const rec = rowToRecord(row);
          const prev = out[out.length - 1];
          if ((prev !== undefined && rec.version >= prev.version) || (beforeVersion !== null && rec.version >= beforeVersion)) throw corrupt("ترتیبِ ردیف‌های فهرست نزولیِ اکید نیست.");
          out.push(rec);
        }
        return Object.freeze(out) as readonly PolicyVersionRecord[];
      });
    },
  };

  return {
    ok: true,
    value: Object.freeze({
      ...store,
      schema,
      migrate: () => migrate(db, schema),
      status: () => status(db, schema),
    }),
  };
}


/**
 * فروشگاهِ واقعیِ مهاجرت‌پذیر روی `db` (داخلی): `status`/`migrate` از رابط عمومیِ tool-policy-store-pg؛ `createSchema` فقط پورتِ تزریقیِ گلو را صدا می‌زند
 * (ADR-0080 تصمیم ۳): **این ماژول هیچ SQLای ندارد** — دستورِ DDL در گلوی استقرار (`tooling/cli/tool-policy-migrate.ts`) است و نامِ شِما فقط پس از
 * اعتبارسنجیِ همان ذخیره‌ساز (`store.schema`) به آن می‌رسد. شِمای نامعتبر ⇒ فقط نامِ متغیر در issues. خطای pg هرگز بیرون نمی‌رود؛ فقط SQLSTATE.
 */
import { createPgPolicyVersionStore } from "@/modules/tool-policy-store-pg";
import type { PgPolicyResult, PolicyPgDatabase } from "@/modules/tool-policy-store-pg";
import { ENV_SCHEMA } from "./args";
import type { CreateSchemaPort, StoreResult } from "./types";

/** SQLSTATE را از زنجیرهٔ `cause` (drizzle خطای pg را می‌پیچد) درمی‌آورد؛ متن را هرگز نمی‌خواند. */
export function sqlstateOf(e: unknown): string | null {
  let cur: unknown = e;
  for (let depth = 0; depth < 6 && typeof cur === "object" && cur !== null; depth++) {
    const rec = cur as { code?: unknown; cause?: unknown };
    if (typeof rec.code === "string" && /^[0-9A-Z]{5}$/.test(rec.code)) return rec.code;
    cur = rec.cause;
  }
  return null;
}

export function createRealStore(db: unknown, schema: string | null, createSchemaPort: CreateSchemaPort | undefined): StoreResult {
  const pg = db as PolicyPgDatabase;
  const made = createPgPolicyVersionStore(pg, schema === null ? {} : { schema });
  if (!made.ok) return { ok: false, issues: Object.freeze([`${ENV_SCHEMA} نامعتبر است.`]) };
  const store = made.value;
  const createSchema = (): Promise<PgPolicyResult<null>> =>
    Promise.resolve()
      .then(() => (createSchemaPort === undefined ? Promise.reject(new Error("no port")) : createSchemaPort(db, store.schema)))
      .then(
        (): PgPolicyResult<null> => ({ ok: true, value: null }),
        (e: unknown): PgPolicyResult<null> => {
          const code = sqlstateOf(e);
          return { ok: false, error: { code: "DB_ERROR", message: "ساختنِ شِما ناموفق بود.", ...(code === null ? {} : { pgCode: code }) } };
        },
      );
  return { ok: true, store: { status: () => store.status(), migrate: () => store.migrate(), createSchema } };
}

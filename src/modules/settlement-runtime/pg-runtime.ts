/**
 * `createPgSettlementRuntime` — همان ریشهٔ ترکیب روی PostgreSQL (ADR-0031): از یک `db` (drizzle برنامه) دفتر، outbox، ساعتِ سیستم و زمان‌سنجِ Node می‌سازد.
 *  - ماژول هرگز اتصال نمی‌سازد و استخر را نمی‌بندد (مالکِ استخر برنامه است)؛ `pg`/`drizzle-orm` import نمی‌شود.
 *  - `start` هرگز خودش مهاجرت نمی‌کند (ADR-0022): پیش‌بازرسیِ فقط‌خواندنیِ `status()` هر دو شِما؛ مهاجرتِ معلق ⇒ `NOT_MIGRATED`.
 *  - `migrate()` صریح و idempotent است (ترتیب: دفتر، سپس outbox).
 */
import { LEDGER_DEFAULT_SCHEMA, createLedger, createPgAccountStore } from "@/modules/ledger";
import type { PgStoreErrorCode, PgStoreResult } from "@/modules/ledger";
import { SETTLEMENT_DEFAULT_SCHEMA, createPgSettlementOutbox } from "@/modules/settlement";
import { assemble, configError, hasFns, pick, snapshot, TUNING_KEYS, unknownKeyIssues } from "./assemble";
import { createSystemClock } from "./clock";
import { createNodeTimer } from "./node-timer";
import { createSettlementRuntime } from "./runtime";
import type { PgSettlementRuntime, PreflightCode, PreflightResult, RuntimeMigrateResult, RuntimeResult } from "./types";

const PG_KEYS = [...TUNING_KEYS, "db", "ledgerSchema", "settlementSchema", "clock", "timer"] as const;

function classify(code: PgStoreErrorCode): PreflightCode {
  if (code === "NOT_MIGRATED") return "NOT_MIGRATED";
  if (code === "MIGRATION_TAMPERED" || code === "MIGRATION_UNKNOWN" || code === "CORRUPT_DATA") return "SCHEMA_MISMATCH";
  return "UNAVAILABLE";
}

type Migratable = Readonly<{
  status(): Promise<PgStoreResult<Readonly<{ applied: readonly string[]; pending: readonly string[] }>>>;
  migrate(): Promise<PgStoreResult<Readonly<{ applied: readonly string[] }>>>;
}>;

async function check(store: Migratable): Promise<PreflightCode | null> {
  const r = await store.status();
  if (!r.ok) return classify(r.error.code);
  return r.value.pending.length > 0 ? "NOT_MIGRATED" : null;
}

export function createPgSettlementRuntime(raw: unknown): RuntimeResult<PgSettlementRuntime> {
  try {
    const snap = snapshot(raw);
    if (snap === null) return configError(["پیکربندی باید یک شیء ساده باشد."]);
    const issues = unknownKeyIssues(snap, PG_KEYS);
    const db = snap["db"] as never;
    if (!hasFns(db, ["execute", "transaction"])) issues.push("db باید پایگاه drizzle باشد (execute و transaction).");
    const clock = snap["clock"] === undefined ? createSystemClock() : snap["clock"];
    const timer = snap["timer"] === undefined ? createNodeTimer() : snap["timer"];
    if (!hasFns(clock, ["nowMs"])) issues.push("clock باید nowMs داشته باشد.");
    if (!hasFns(timer, ["after", "cancel"])) issues.push("timer باید after و cancel داشته باشد.");
    for (const key of ["ledgerSchema", "settlementSchema"] as const) if (snap[key] !== undefined && typeof snap[key] !== "string") issues.push(`${key} باید رشته باشد.`);
    if (issues.length > 0) return configError(issues);

    const ledgerSchema = (snap["ledgerSchema"] as string | undefined) ?? LEDGER_DEFAULT_SCHEMA;
    const settlementSchema = (snap["settlementSchema"] as string | undefined) ?? SETTLEMENT_DEFAULT_SCHEMA;
    const store = createPgAccountStore(db, { schema: ledgerSchema });
    if (!store.ok) issues.push("ledgerSchema نامعتبر است.");
    const outbox = createPgSettlementOutbox(db, { schema: settlementSchema });
    if (!outbox.ok) issues.push("settlementSchema نامعتبر است.");
    if (!store.ok || !outbox.ok) return configError(issues);
    const made = createLedger({ store: store.value, clock: clock as never });
    if (!made.ok) return configError(["ساختنِ دفتر ناموفق بود (clock نامعتبر؟)."]);

    // اعتبارسنجیِ تنظیمات پیش از ساختنِ اجرا: گزارشِ یکجای همهٔ مشکل‌ها.
    const probe = assemble(snap, { ledger: made.value, outbox: outbox.value, clock, timer });
    if (!probe.ok) return probe;

    const preflight = async (): Promise<PreflightResult> => {
      for (const s of [store.value, outbox.value] as const) {
        const code = await check(s as Migratable);
        if (code !== null) return { ok: false, code };
      }
      return { ok: true };
    };
    const base = createSettlementRuntime({ ledger: made.value, outbox: outbox.value, clock, timer, preflight, ...pick(snap, TUNING_KEYS) });
    if (!base.ok) return base;

    const migrate = async (): Promise<RuntimeMigrateResult> => {
      let stage: "ledger" | "settlement" = "ledger";
      try {
        const l = await store.value.migrate();
        if (!l.ok) return Object.freeze({ ok: false as const, stage, code: l.error.code });
        stage = "settlement";
        const s = await outbox.value.migrate();
        if (!s.ok) return Object.freeze({ ok: false as const, stage, code: s.error.code });
        return Object.freeze({ ok: true as const, applied: Object.freeze({ ledger: Object.freeze([...l.value.applied]), settlement: Object.freeze([...s.value.applied]) }) });
      } catch {
        return Object.freeze({ ok: false as const, stage, code: "DB_ERROR" as const });
      }
    };
    return { ok: true, value: Object.freeze({ ...base.value, migrate }) };
  } catch {
    return configError(["خواندن پیکربندی ناموفق بود."]);
  }
}

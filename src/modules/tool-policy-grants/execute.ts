/**
 * اجرای `verify` و `apply` (داخلی؛ ADR-0081). ترتیبِ ثابت و **بی‌نوشتنِ پیش از اطمینان**:
 *   check (سه خواندنِ فقط‌خواندنی: نقش ← شِما ← رابطه‌ها) ← [apply: یک تراکنشِ REVOKE/GRANTِ همگراکننده] ← verify (خواندنِ دوباره).
 * - نقشِ ناموجود/خطرناک/مالک ⇒ `ROLE_UNUSABLE` و هیچ نوشتنی؛ شِما/جدولِ ناموجود ⇒ `PENDING` و هیچ نوشتنی (GRANT روی چیزِ ناموجود معنا ندارد).
 * - `apply` هرگز `ok` را از ادعای خودش نمی‌گیرد: همیشه دوباره می‌خواند؛ حقِ زیادی که با REVOKE از نقش رفتنی نیست (PUBLIC، عضویتِ نقشِ دیگر) `APPLY_FAILED` است.
 * - پاسخِ بدشکلِ پورت ⇒ `INTERNAL` (بسته: هرگز بی‌صدا «خوب» نمی‌شود). متنِ خطای پایگاه خوانده نمی‌شود؛ فقط SQLSTATE.
 * - پس از رهاشدنِ اجرا (مهلت) نتیجهٔ دیرهنگام نادیده است و هیچ دستورِ تازه‌ای شروع نمی‌شود (`progress.cancelled`).
 */
import { assessObjects, assessRole, planStatements, RELATIONS_SQL, ROLE_SQL, SCHEMA_SQL } from "./plan";
import type { GrantsCode, GrantsPhase, GrantsPorts, GrantsSettings } from "./types";

export type Progress = {
  phase: GrantsPhase;
  findings: readonly string[] | undefined;
  wrote: boolean;
  cancelled: boolean;
};

export type Executed = Readonly<{ code: GrantsCode; phase: GrantsPhase; pgCode?: string }>;

const SQLSTATE = /^[0-9A-Z]{5}$/;
/** SQLSTATE را از زنجیرهٔ `cause` درمی‌آورد؛ متن را هرگز نمی‌خواند. */
export function sqlstateOf(e: unknown): string | null {
  let cur: unknown = e;
  for (let depth = 0; depth < 6 && typeof cur === "object" && cur !== null; depth++) {
    const rec = cur as { code?: unknown; cause?: unknown };
    if (typeof rec.code === "string" && SQLSTATE.test(rec.code)) return rec.code;
    cur = rec.cause;
  }
  return null;
}

/** `statement_timeout` سرور (57014) و `lock_timeout` (55P03) مهلت‌اند، نه «در دسترس نبودن». */
const TIMEOUT_STATES = new Set(["57014", "55P03"]);
const withPg = (code: GrantsCode, phase: GrantsPhase, pg: string | null): Executed => (pg === null ? { code, phase } : { code, phase, pgCode: pg });

type ReadOutcome =
  | Readonly<{ kind: "role" | "pending" | "owner"; findings: readonly string[] }>
  | Readonly<{ kind: "state"; drift: readonly string[] }>
  | Readonly<{ kind: "malformed" }>
  | Readonly<{ kind: "failed"; pg: string | null }>;

async function readState(ports: GrantsPorts, getDb: () => Promise<unknown>, role: string, schema: string, progress: Progress): Promise<ReadOutcome> {
  try {
    const db = await getDb();
    if (progress.cancelled) return { kind: "failed", pg: null };
    const roleFindings = assessRole(await ports.query(db, ROLE_SQL, [role]));
    if (roleFindings === null) return { kind: "malformed" };
    if (roleFindings.length > 0) return { kind: "role", findings: roleFindings };
    if (progress.cancelled) return { kind: "failed", pg: null };
    const schemaResp = await ports.query(db, SCHEMA_SQL, [role, schema]);
    if (progress.cancelled) return { kind: "failed", pg: null };
    const relResp = await ports.query(db, RELATIONS_SQL, [role, schema]);
    const a = assessObjects(schemaResp, relResp);
    if (a === null) return { kind: "malformed" };
    if (a.pending.length > 0) return { kind: "pending", findings: a.pending };
    if (a.owner.length > 0) return { kind: "owner", findings: a.owner };
    return { kind: "state", drift: a.drift };
  } catch (e) {
    return { kind: "failed", pg: sqlstateOf(e) };
  }
}

export async function execute(settings: GrantsSettings, schema: string, ports: GrantsPorts, getDb: () => Promise<unknown>, progress: Progress): Promise<Executed> {
  progress.phase = "check";
  const first = await readState(ports, getDb, settings.role, schema, progress);
  switch (first.kind) {
    case "malformed":
      return { code: "INTERNAL", phase: "check" };
    case "failed":
      return withPg(first.pg !== null && TIMEOUT_STATES.has(first.pg) ? "TIMEOUT" : "UNAVAILABLE", "check", first.pg);
    case "role":
    case "owner":
      progress.findings = first.findings;
      return { code: "ROLE_UNUSABLE", phase: "check" };
    case "pending":
      progress.findings = first.findings;
      return { code: "PENDING", phase: "check" };
    case "state":
      break;
  }
  progress.findings = first.drift;
  if (first.drift.length === 0) return { code: "OK", phase: "check" };
  if (settings.command === "verify") return { code: "DRIFT", phase: "check" };
  if (progress.cancelled) return { code: "TIMEOUT", phase: "check" };

  progress.phase = "apply";
  try {
    const db = await getDb();
    await ports.transact(db, planStatements(schema, settings.role, settings.timeoutMs));
  } catch (e) {
    const pg = sqlstateOf(e);
    return withPg(pg !== null && TIMEOUT_STATES.has(pg) ? "TIMEOUT" : "APPLY_FAILED", "apply", pg);
  }
  if (progress.cancelled) return { code: "TIMEOUT", phase: "apply" };
  progress.wrote = true;

  progress.phase = "verify";
  const second = await readState(ports, getDb, settings.role, schema, progress);
  switch (second.kind) {
    case "malformed":
      return { code: "INTERNAL", phase: "verify" };
    case "failed":
      return withPg(second.pg !== null && TIMEOUT_STATES.has(second.pg) ? "TIMEOUT" : "APPLY_FAILED", "verify", second.pg);
    case "role":
    case "owner":
    case "pending":
      progress.findings = second.findings;
      return { code: "APPLY_FAILED", phase: "verify" };
    case "state":
      progress.findings = second.drift;
      return { code: second.drift.length === 0 ? "OK" : "APPLY_FAILED", phase: "verify" };
  }
}

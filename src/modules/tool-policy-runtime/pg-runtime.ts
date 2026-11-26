/**
 * `createPgToolPolicyRuntime` — زنجیرهٔ ذخیره‌ساز ← مدیر ← منبع ← حلقه روی یک `db` و یک `tuning` (ADR-0073).
 *  - ماژول هرگز اتصال نمی‌سازد، استخر را نمی‌بندد و **هرگز مهاجرت نمی‌کند** (نقشِ زمان‌اجرا ممکن است DDL نداشته باشد؛ مهاجرت برشِ 2c‑3).
 *  - `tuning` یک بار خوانده می‌شود و همان عددها به منبع و حلقه می‌رسد؛ رابطه‌های حلقه (interval + ۳·deadline + retry ≤ maxStale، …) در ساخت سنجیده می‌شود.
 *  - `statementTimeoutMs ≤ refreshTimeoutMs`: پایگاه تلاش را پیش از رها کردنِ منبع قطع می‌کند (پیش‌فرض `min(۵۰۰۰، refreshTimeoutMs)`).
 *  - ساعت دو تاست: یکنوا برای سنِ تأیید (منبع)، دیواری فقط برای مهرِ نوشتنِ مدیر که این ریشه هرگز صدا نمی‌زند.
 */
import { createToolPolicyAdmin } from "@/modules/tool-policy-admin";
import { createPolicyRefresher } from "@/modules/tool-policy-refresher";
import { createPolicySource } from "@/modules/tool-policy-source";
import { createPgPolicyVersionStore, STORE_LIMITS } from "@/modules/tool-policy-store-pg";
import { createNodeTimer, createSystemClock } from "@/modules/settlement-runtime";
import { createMonotonicClock } from "./clock";
import { createToolPolicyRuntime } from "./runtime";
import type { PgToolPolicyRuntime, PreflightCode, PreflightResult, RuntimeResult } from "./types";

const KEYS = ["db", "schema", "statementTimeoutMs", "tuning", "clock", "wallClock", "timer"] as const;
const TUNING_KEYS = ["intervalMs", "retryMs", "attemptDeadlineMs", "refreshTimeoutMs", "maxStaleMs"] as const;

const PROBE_SOURCE = Object.freeze({ refresh: (): Promise<unknown> => Promise.resolve(undefined) });
const PROBE_DB = Object.freeze({ execute: (): Promise<never> => Promise.reject(new Error("probe")), transaction: (): Promise<never> => Promise.reject(new Error("probe")) });
const PROBE_TIMER = Object.freeze({ after: (): unknown => undefined, cancel: (): void => undefined });

function member(owner: unknown, key: string): unknown {
  try {
    return typeof owner === "object" && owner !== null ? (owner as Record<string, unknown>)[key] : undefined;
  } catch {
    return undefined; // دسترسی به کلید پرتاب کرد ⇒ نامعتبر
  }
}

const hasFns = (owner: unknown, names: readonly string[]): boolean => names.every((n) => typeof member(owner, n) === "function");

function fail(issues: string[]): RuntimeResult<never> {
  return { ok: false, error: Object.freeze({ code: "INVALID_CONFIG" as const, message: "پیکربندیِ ریشهٔ سیاستِ ابزار نامعتبر است.", issues: Object.freeze(issues.slice(0, 20)) }) };
}

function plain(owner: unknown): owner is Record<string, unknown> {
  return typeof owner === "object" && owner !== null && !Array.isArray(owner);
}

/** کدِ خطای ذخیره‌ساز ← کدِ پیش‌بازرسی؛ هر کدِ ناشناخته `UNAVAILABLE` (بسته). */
export function classifyStoreCode(code: unknown): PreflightCode {
  if (code === "NOT_MIGRATED") return "NOT_MIGRATED";
  if (code === "MIGRATION_TAMPERED" || code === "MIGRATION_UNKNOWN" || code === "CORRUPT_DATA" || code === "UNSAFE_SESSION") return "SCHEMA_MISMATCH";
  return "UNAVAILABLE";
}

/** پیش‌بازرسیِ فقط‌خواندنی؛ پاسخِ `status()` ورودیِ ناشناخته است (شکلِ ناشناخته ⇒ UNAVAILABLE). هرگز نمی‌پرتابد. */
export async function preflightOf(store: Readonly<{ status(): Promise<unknown> }>): Promise<PreflightResult> {
  try {
    const r = await store.status();
    const ok = member(r, "ok");
    if (ok === false) return bad(classifyStoreCode(member(member(r, "error"), "code")));
    if (ok !== true) return bad("UNAVAILABLE");
    const s = member(r, "value");
    const pending = member(s, "pending");
    const problems = member(s, "problems");
    const exists = member(s, "schemaExists");
    const contiguous = member(s, "contiguous");
    const ready = member(s, "ready");
    if (typeof exists !== "boolean" || typeof contiguous !== "boolean" || typeof ready !== "boolean" || !Array.isArray(pending) || !Array.isArray(problems)) return bad("UNAVAILABLE");
    if (!exists || pending.length > 0) return bad("NOT_MIGRATED");
    if (!ready || problems.length > 0 || !contiguous) return bad("SCHEMA_MISMATCH");
    return Object.freeze({ ok: true as const });
  } catch {
    return bad("UNAVAILABLE");
  }
}

/** پیش‌فرضِ سقفِ سمتِ پایگاه: `min(۵۰۰۰، refreshTimeoutMs)`؛ مقدارِ صریح همان است (رابطهٔ ≤ refreshTimeoutMs جدا سنجیده می‌شود). */
export function effectiveStatementTimeoutMs(explicit: number | undefined, refreshTimeoutMs: number): number {
  return explicit ?? Math.min(STORE_LIMITS.defaultTimeoutMs, refreshTimeoutMs);
}

const bad = (code: PreflightCode): PreflightResult => Object.freeze({ ok: false as const, code });

export function createPgToolPolicyRuntime(raw: unknown): RuntimeResult<PgToolPolicyRuntime> {
  const issues: string[] = [];
  const got: Record<string, unknown> = {};
  const tuning: Record<string, unknown> = {};
  if (!plain(raw)) return fail(["options"]);
  try {
    for (const k of Object.keys(raw)) if (!(KEYS as readonly string[]).includes(k)) issues.push(`unknown:${k.length <= 40 ? k : "?"}`);
    for (const k of KEYS) got[k] = raw[k];
    const t = got["tuning"];
    if (!plain(t)) issues.push("tuning");
    else {
      for (const k of Object.keys(t)) if (!(TUNING_KEYS as readonly string[]).includes(k)) issues.push(`tuning.unknown:${k.length <= 40 ? k : "?"}`);
      for (const k of TUNING_KEYS) tuning[k] = t[k];
    }
  } catch {
    return fail(["options"]);
  }

  const db = got["db"];
  const schema = got["schema"];
  const statementTimeoutMs = got["statementTimeoutMs"];
  const clock = got["clock"] === undefined ? createMonotonicClock() : got["clock"];
  const wallClock = got["wallClock"] === undefined ? createSystemClock() : got["wallClock"];
  const timer = got["timer"] === undefined ? createNodeTimer() : got["timer"];
  if (!hasFns(db, ["execute", "transaction"])) issues.push("db");
  if (!hasFns(clock, ["nowMs"])) issues.push("clock");
  if (!hasFns(wallClock, ["nowMs"])) issues.push("wallClock");
  if (!hasFns(timer, ["after", "cancel"])) issues.push("timer");
  if (schema !== undefined && typeof schema !== "string") issues.push("schema");
  else if (typeof schema === "string" && !createPgPolicyVersionStore(PROBE_DB, { schema }).ok) issues.push("schema");

  // رابطه‌ها و کران‌های tuning را خودِ حلقه می‌سنجد (منبعِ حقیقتِ یگانه)؛ این‌جا فقط یک بار با پورت‌های بی‌اثر پرسیده می‌شود.
  let tuningOk = false;
  if (plain(got["tuning"])) {
    const probe = createPolicyRefresher({ source: PROBE_SOURCE, timer: PROBE_TIMER, ...tuning } as never);
    if (!probe.ok) for (const i of probe.error.issues) issues.push(`tuning:${i}`);
    else tuningOk = true;
  }
  const refreshTimeoutMs = tuning["refreshTimeoutMs"] as number;
  if (statementTimeoutMs !== undefined) {
    const s = STORE_LIMITS;
    if (typeof statementTimeoutMs !== "number" || !Number.isSafeInteger(statementTimeoutMs) || statementTimeoutMs < s.minTimeoutMs || statementTimeoutMs > s.maxTimeoutMs) issues.push("statementTimeoutMs");
    else if (tuningOk && statementTimeoutMs > refreshTimeoutMs) issues.push("relation:statementTimeoutMs<=refreshTimeoutMs");
  }
  if (issues.length > 0) return fail(issues);

  const effectiveTimeout = effectiveStatementTimeoutMs(statementTimeoutMs as number | undefined, refreshTimeoutMs);
  const store = createPgPolicyVersionStore(db as never, { ...(schema === undefined ? {} : { schema: schema as string }), statementTimeoutMs: effectiveTimeout });
  if (!store.ok) return fail(["schema"]);
  const admin = createToolPolicyAdmin({ store: store.value, clock: wallClock as never });
  if (!admin.ok) return fail(["wallClock"]);
  const source = createPolicySource({ reader: admin.value, clock: clock as never, maxStaleMs: tuning["maxStaleMs"], refreshTimeoutMs });
  if (!source.ok) return fail(source.error.issues.map((i) => `source:${i}`));
  const refresher = createPolicyRefresher({ source: source.value, timer, ...tuning } as never);
  if (!refresher.ok) return fail(refresher.error.issues.map((i) => `tuning:${i}`));

  return createToolPolicyRuntime({
    preflight: () => preflightOf(store.value),
    source: source.value,
    refresher: refresher.value,
    timer,
    preflightDeadlineMs: tuning["attemptDeadlineMs"],
  });
}

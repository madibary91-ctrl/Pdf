/**
 * اعتبارسنجیِ مرز (ADR-0069): ورودیِ ادمین (`actor`، `reason`، شماره‌ها) و رکوردِ برگشتی از ذخیره‌ساز (ذخیره‌ساز هم یک مرز است).
 * هرگز نمی‌پرتابد؛ پیام‌ها ثابت‌اند و مقدارِ ورودی را بازتاب نمی‌دهند.
 */
import { deepFreeze, has, isPlain } from "./canonical";
import type { PolicyChange, PolicyVersionRecord, PolicyVersionSource } from "./types";

export const ADMIN_LIMITS = Object.freeze({ maxReasonChars: 500, maxHistoryLimit: 100, defaultHistoryLimit: 20, maxChanges: 64, maxPathChars: 64 });
export const ACTOR_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
/** کنترل‌ها، جداکننده‌های خط/بند، و کنترل‌های جهتِ دوسویه (حملهٔ «Trojan Source» در لاگ/رابطِ ممیزی)؛ نیم‌فاصلهٔ فارسی (U+200C) مجاز است. */
const FORBIDDEN_REASON_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const MAX_NODES = 4000;
const MAX_STRING = 2000;
const MAX_DEPTH = 5;
const BAD: unique symbol = Symbol("bad");

export const isSafeInt = (v: unknown, lo: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= lo;
const keyName = (k: string): string => JSON.stringify(k.length > 40 ? `${k.slice(0, 40)}…` : k);

export const checkActor = (v: unknown): boolean => typeof v === "string" && ACTOR_RE.test(v);

/** دلیلِ تغییر: متنِ تهی‌نشده، ≤ ۵۰۰ نویسه، بی‌کنترل؛ خودِ رشته (بدون trim) باید همان باشد که ذخیره می‌شود. */
export function normalizeReason(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t.length < 1 || t.length > ADMIN_LIMITS.maxReasonChars || FORBIDDEN_REASON_CHARS.test(t)) return null;
  return t;
}

/** کلیدهای ورودی را یک‌بار می‌خواند؛ کلیدِ ناشناخته رد (نه نادیده). */
export function readFields(raw: unknown, allowed: readonly string[]): { values: Map<string, unknown>; issues: string[] } {
  const values = new Map<string, unknown>();
  const issues: string[] = [];
  try {
    if (!isPlain(raw)) {
      issues.push("ورودی باید یک شیء ساده باشد.");
      return { values, issues };
    }
    for (const k of Object.keys(raw)) {
      if (!allowed.includes(k)) issues.push(`کلید ناشناخته: ${keyName(k)}.`);
      else values.set(k, raw[k]);
    }
  } catch {
    issues.push("خواندن ورودی ناموفق بود.");
  }
  return { values, issues };
}

type Copy = string | number | boolean | null | Copy[] | { [k: string]: Copy };

function plainCopy(v: unknown, depth: number, budget: { n: number }): Copy | typeof BAD {
  if (--budget.n < 0) return BAD;
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "string") return v.length <= MAX_STRING ? v : BAD;
  if (typeof v === "number") return Number.isFinite(v) ? v : BAD;
  if (depth <= 0) return BAD;
  if (Array.isArray(v)) {
    const out: Copy[] = [];
    for (const e of v as unknown[]) {
      const c = plainCopy(e, depth - 1, budget);
      if (c === BAD) return BAD;
      out.push(c);
    }
    return out;
  }
  if (!isPlain(v)) return BAD;
  const out: { [k: string]: Copy } = {};
  for (const k of Object.keys(v)) {
    if (k === "__proto__") return BAD;
    const c = plainCopy(v[k], depth - 1, budget);
    if (c === BAD) return BAD;
    out[k] = c;
  }
  return out;
}

const isRec = (c: unknown): c is { [k: string]: Copy } => typeof c === "object" && c !== null && !Array.isArray(c);
const exactKeys = (o: object, keys: readonly string[]): boolean => Object.keys(o).length === keys.length && keys.every((k) => has(o, k));
const isLeaf = (c: unknown): c is string | number => typeof c === "string" || typeof c === "number";
/** بخش‌ها ← کلیدها ← برگِ رشته/عدد. */
const isSectioned = (c: unknown): boolean => isRec(c) && Object.values(c).every((s) => isRec(s) && Object.values(s).every(isLeaf));

function parseChange(c: Copy): PolicyChange | null {
  if (!isRec(c) || !exactKeys(c, ["path", "from", "to"])) return null;
  const { path, from, to } = c;
  if (typeof path !== "string" || path.length < 1 || path.length > ADMIN_LIMITS.maxPathChars) return null;
  if (!(from === null || isLeaf(from)) || !(to === null || isLeaf(to))) return null;
  return Object.freeze({ path, from: from as string | number | null, to: to as string | number | null });
}

function parseSource(c: Copy | undefined, version: number): PolicyVersionSource | null {
  if (!isRec(c) || typeof c["kind"] !== "string") return null;
  if (c["kind"] === "set") return exactKeys(c, ["kind"]) ? Object.freeze({ kind: "set" as const }) : null;
  if (c["kind"] === "rollback" && exactKeys(c, ["kind", "toVersion"])) {
    const t = c["toVersion"];
    return isSafeInt(t, 1) && t <= version ? Object.freeze({ kind: "rollback" as const, toVersion: t }) : null;
  }
  return null;
}

/** رکوردِ ذخیره‌ساز ← رکوردِ معتبر، مستقل و عمیق‌یخ‌زده؛ `null` = خراب (شکل/کران). محتوای سیاست را نمی‌سنجد (آن با `resolveToolPolicy` و کدِ جاری است). */
export function parseRecord(raw: unknown): PolicyVersionRecord | null {
  try {
    const c = plainCopy(raw, MAX_DEPTH, { n: MAX_NODES });
    if (c === BAD || !isRec(c) || !exactKeys(c, ["version", "overrides", "policy", "changes", "source", "actor", "reason", "createdAtMs"])) return null;
    const { version, overrides, policy, changes, source, actor, reason, createdAtMs } = c;
    if (!isSafeInt(version, 1) || !isSafeInt(createdAtMs, 0)) return null;
    if (!isSectioned(overrides) || !isSectioned(policy)) return null;
    if (!Array.isArray(changes) || changes.length > ADMIN_LIMITS.maxChanges) return null;
    const parsedChanges: PolicyChange[] = [];
    for (const ch of changes) {
      const p = parseChange(ch);
      if (p === null) return null;
      parsedChanges.push(p);
    }
    const src = parseSource(source, version);
    if (src === null || !checkActor(actor) || typeof reason !== "string" || normalizeReason(reason) !== reason) return null;
    return deepFreeze({
      version,
      overrides: overrides as PolicyVersionRecord["overrides"],
      policy: policy as unknown as PolicyVersionRecord["policy"],
      changes: parsedChanges,
      source: src,
      actor: actor as string,
      reason,
      createdAtMs,
    });
  } catch {
    return null;
  }
}

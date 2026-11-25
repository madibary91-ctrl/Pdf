/**
 * اعتبارسنجیِ سیاست روی مرز (ADR-0067): بازنویسیِ جزئیِ `unknown` ← سیاستِ کاملِ یخ‌زده. هرگز نمی‌پرتابد؛ هر کلید فقط یک‌بار خوانده می‌شود
 * (getter/Proxy نتواند بین اعتبارسنجی و ساخت مقدار عوض کند)؛ کلیدِ ناشناخته رد می‌شود (نه نادیده)؛ مقدارِ نامعتبر هرگز بی‌صدا با پیش‌فرض
 * جایگزین نمی‌شود؛ مشکل‌ها فقط مسیرِ فیلد و کرانِ کدند، هرگز مقدار. خروجیِ موفق دوباره‌ورودیِ همین تابع است (خودهمانی).
 */
import { DEFAULT_TOOL_POLICY, MODEL_NAME_RE, POLICY_LIMITS, POLICY_SCHEMA, SECTION_ORDER, type FieldSpec } from "./policy";
import { checkPolicyRelations } from "./relations";
import type { OnUnknownCost, PolicyResult, ToolPolicy } from "./types";

const MESSAGE = "سیاستِ آستانه‌های دروازهٔ ابزار نامعتبر است.";
const MAX_ISSUES = 20;
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const keyName = (k: string): string => JSON.stringify(k.length > 40 ? `${k.slice(0, 40)}…` : k);

export const policyFail = (code: "INVALID_POLICY" | "INVALID_REQUEST_ID", message: string, issues: readonly string[]): { ok: false; error: { code: typeof code; message: string; issues: readonly string[] } } => {
  return { ok: false, error: Object.freeze({ code, message, issues: Object.freeze(issues.slice(0, MAX_ISSUES)) }) };
};

/** `null` ⇒ معتبر؛ وگرنه پیامِ ثابتِ بی‌مقدار. */
export function checkField(path: string, spec: FieldSpec, v: unknown): string | null {
  if (spec.kind === "int") {
    return typeof v === "number" && Number.isSafeInteger(v) && v >= spec.lo && v <= spec.hi ? null : `${path} باید عدد صحیح ${spec.lo} تا ${spec.hi} باشد.`;
  }
  if (spec.kind === "enum") {
    return typeof v === "string" && spec.values.includes(v) ? null : `${path} باید یکی از ${spec.values.map((x) => JSON.stringify(x)).join("، ")} باشد.`;
  }
  return typeof v === "string" && v.length >= 1 && v.length <= POLICY_LIMITS.maxModelNameChars && MODEL_NAME_RE.test(v)
    ? null
    : `${path} باید نامِ منطقیِ ۱ تا ${POLICY_LIMITS.maxModelNameChars} نویسه (حروف/ارقام و . _ : -) باشد.`;
}

/** بازنویسی را یک‌بار می‌خواند: کلیدِ «بخش.کلید» ← مقدار. */
function pick(raw: unknown, issues: string[]): Map<string, unknown> {
  const picked = new Map<string, unknown>();
  if (raw === undefined) return picked;
  try {
    if (!isRecord(raw)) {
      issues.push("سیاست باید یک شیء ساده باشد.");
      return picked;
    }
    for (const s of Object.keys(raw)) {
      const section = raw[s];
      if (!(SECTION_ORDER as readonly string[]).includes(s)) {
        issues.push(`کلید ناشناخته: ${keyName(s)}.`);
        continue;
      }
      const schema = POLICY_SCHEMA[s as keyof ToolPolicy];
      if (!isRecord(section)) {
        issues.push(`${s}: باید شیء ساده باشد.`);
        continue;
      }
      for (const k of Object.keys(section)) {
        if (!has(schema, k)) issues.push(`${s}: کلید ناشناخته: ${keyName(k)}.`);
        else picked.set(`${s}.${k}`, section[k]);
      }
    }
  } catch {
    issues.push("خواندن سیاست ناموفق بود.");
  }
  return picked;
}

/**
 * `undefined` ⇒ پیش‌فرض‌های کد. شیء ⇒ بازنویسی روی پیش‌فرض‌ها؛ سیاستِ مؤثر کامل اعتبارسنجی می‌شود: فیلدها، سپس (فقط وقتی هر پنج فیلدِ
 * درگیر خودشان معتبرند) `checkPolicyRelations`. بازنویسیِ ناسازگار رد می‌شود و هرگز خودکار «اصلاح» نمی‌شود (مثلاً `graceMs` را کم کنید و
 * `maxCallMs` را نه ⇒ رد؛ برای مجموعهٔ سازگار `timingFromGrace` را بزنید).
 */
export function resolveToolPolicy(raw: unknown): PolicyResult<ToolPolicy> {
  const issues: string[] = [];
  const picked = pick(raw, issues);
  const cand = new Map<string, unknown>();
  const bad = new Set<string>();
  for (const s of SECTION_ORDER) {
    const schema = POLICY_SCHEMA[s];
    const base = DEFAULT_TOOL_POLICY[s] as Readonly<Record<string, unknown>>;
    for (const k of Object.keys(schema)) {
      const path = `${s}.${k}`;
      const v = picked.has(path) ? picked.get(path) : base[k];
      cand.set(path, v);
      const problem = checkField(path, schema[k] as FieldSpec, v);
      if (problem !== null) {
        issues.push(problem);
        bad.add(path);
      }
    }
  }
  const RELATED = ["timing.maxCallMs", "timing.graceMs", "timing.reservationTtlMs", "model.timeoutMs", "run.totalTimeoutMs"];
  if (RELATED.every((p) => !bad.has(p))) {
    issues.push(
      ...checkPolicyRelations({
        maxCallMs: cand.get("timing.maxCallMs"),
        graceMs: cand.get("timing.graceMs"),
        reservationTtlMs: cand.get("timing.reservationTtlMs"),
        modelTimeoutMs: cand.get("model.timeoutMs"),
        totalTimeoutMs: cand.get("run.totalTimeoutMs"),
      }),
    );
  }
  if (issues.length > 0) return policyFail("INVALID_POLICY", MESSAGE, issues);
  const n = (p: string): number => cand.get(p) as number;
  return {
    ok: true,
    value: Object.freeze({
      loop: Object.freeze({ maxSteps: n("loop.maxSteps"), maxToolCalls: n("loop.maxToolCalls"), maxIdenticalCalls: n("loop.maxIdenticalCalls"), truncationRetries: n("loop.truncationRetries") }),
      run: Object.freeze({ totalTimeoutMs: n("run.totalTimeoutMs"), toolTimeoutMs: n("run.toolTimeoutMs"), maxResultChars: n("run.maxResultChars") }),
      answer: Object.freeze({ maxCards: n("answer.maxCards"), maxOutputTokens: n("answer.maxOutputTokens") }),
      model: Object.freeze({ name: cand.get("model.name") as string, timeoutMs: n("model.timeoutMs") }),
      timing: Object.freeze({ graceMs: n("timing.graceMs"), maxCallMs: n("timing.maxCallMs"), reservationTtlMs: n("timing.reservationTtlMs") }),
      metering: Object.freeze({ perMessageOverheadTokens: n("metering.perMessageOverheadTokens"), onUnknownCost: cand.get("metering.onUnknownCost") as OnUnknownCost }),
    }),
  };
}

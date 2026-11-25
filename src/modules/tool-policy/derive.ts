/**
 * مجموعهٔ زمانیِ سازگار از یک عدد (ADR-0067): `graceMs` ← `maxCallMs = ⌊۴۰٪ graceMs⌋` و `ttl = ۴×graceMs` (نسبت‌های تأییدشدهٔ مالک).
 * برای ادمین/ریشهٔ I/O که فقط `graceMs` را می‌خواهد عوض کند. `model.timeoutMs` را **عوض نمی‌کند**؛ اگر `graceMs` را کم کنید باید آن را هم کم کنید
 * (وگرنه `resolveToolPolicy` رد می‌کند و بی‌صدا اصلاح نمی‌شود).
 */
import { POLICY_RATIOS, POLICY_SCHEMA, type FieldSpec } from "./policy";
import { checkPolicyRelations } from "./relations";
import { checkField, policyFail } from "./resolve";

import type { PolicyResult, ToolPolicy } from "./types";

export function timingFromGrace(graceMs: unknown): PolicyResult<ToolPolicy["timing"]> {
  const msg = "مجموعهٔ زمانیِ مشتق‌شده از graceMs نامعتبر است.";
  const g = checkField("timing.graceMs", POLICY_SCHEMA.timing["graceMs"] as FieldSpec, graceMs);
  if (g !== null) return policyFail("INVALID_POLICY", msg, [g]);
  const grace = graceMs as number;
  const maxCallMs = Math.floor((grace * POLICY_RATIOS.callSharePercent) / 100);
  const reservationTtlMs = grace * POLICY_RATIOS.ttlFactor;
  const issues: string[] = [];
  for (const [k, v] of [["maxCallMs", maxCallMs], ["reservationTtlMs", reservationTtlMs]] as const) {
    const p = checkField(`timing.${k}`, POLICY_SCHEMA.timing[k] as FieldSpec, v);
    if (p !== null) issues.push(p);
  }
  if (issues.length === 0) issues.push(...checkPolicyRelations({ maxCallMs, graceMs: grace, reservationTtlMs, modelTimeoutMs: undefined, totalTimeoutMs: undefined }));
  if (issues.length > 0) return policyFail("INVALID_POLICY", msg, issues);
  return { ok: true, value: Object.freeze({ graceMs: grace, maxCallMs, reservationTtlMs }) };
}

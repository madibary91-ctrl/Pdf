/**
 * نگاشتِ سیاست به گزینه‌های ماژول‌های پایین‌دست (ADR-0067). ورودی دوباره اعتبارسنجی می‌شود (شیءِ جعلی/دست‌کاری‌شده هرگز نگاشت نمی‌شود)؛
 * `undefined` ⇒ پیش‌فرض‌های کد. هیچ `budget`، ارز، قیمت، حساب یا کلیدی نمی‌سازد؛ آن‌ها با ریشهٔ I/O و مالک است.
 */
import { resolveToolPolicy } from "./resolve";
import type { PolicyProjection, PolicyResult } from "./types";

export function projectToolPolicy(policy?: unknown): PolicyResult<PolicyProjection> {
  const r = resolveToolPolicy(policy);
  if (!r.ok) return r;
  const p = r.value;
  return {
    ok: true,
    value: Object.freeze({
      loop: Object.freeze({ ...p.loop }),
      service: Object.freeze({
        model: p.model.name,
        maxOutputTokens: p.answer.maxOutputTokens,
        maxCards: p.answer.maxCards,
        totalTimeoutMs: p.run.totalTimeoutMs,
        toolTimeoutMs: p.run.toolTimeoutMs,
        maxResultChars: p.run.maxResultChars,
      }),
      deadline: Object.freeze({ maxCallMs: p.timing.maxCallMs }),
      durable: Object.freeze({ graceMs: p.timing.graceMs, reservationTtlMs: p.timing.reservationTtlMs, perMessageOverheadTokens: p.metering.perMessageOverheadTokens, onUnknownCost: p.metering.onUnknownCost }),
      gatewayModel: Object.freeze({ timeoutMs: p.model.timeoutMs }),
    }),
  };
}

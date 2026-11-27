/**
 * پیش‌بازرسیِ یک بازنویسی (ADR-0078). قرارداد: «پیش‌بازرسی = همان مسیرِ اجرا». به‌جای کپیِ قواعد، بازنویسی از
 * `resolveToolPolicy` ← `projectToolPolicy` می‌گذرد، سپس از **همان `createPolicyBinding`** با یک منبعِ ساختگیِ تک‌نسخه‌ای و `build`ِ
 * واقعی؛ پس هر چیزی که در تولید `PROJECTION_INVALID/BUILD_FAILED` می‌شد، این‌جا هم می‌شود (هم‌ارزی با ساخت، نه با بازنویسیِ قاعده).
 * نمونهٔ ساخته‌شده دور ریخته می‌شود (`build` بی‌اثر جانبی است). هرگز نمی‌پرتابد و متنِ خطا/مقدار را بازتاب نمی‌دهد.
 */
import { projectToolPolicy, resolveToolPolicy } from "@/modules/tool-policy";
import { createPolicyBinding } from "@/modules/tool-policy-binding";
import type { PreflightError, PreflightOptions, PreflightResult, PreflightStage } from "./types";

const MESSAGES: Readonly<Record<PreflightStage, string>> = Object.freeze({
  CONFIG_INVALID: "پیکربندیِ پیش‌بازرسیِ سیاست نامعتبر است.",
  INPUT_UNREADABLE: "ورودیِ ادمین باید شیءِ سادهٔ JSON و کوچک باشد.",
  OVERRIDES_INVALID: "بازنویسیِ سیاست اعتبارسنجی را نگذراند.",
  PROJECTION_INVALID: "سیاستِ مؤثر در مسیرِ اجرا پذیرفته نمی‌شود.",
  BUILD_FAILED: "ساختنِ دروازه از این سیاست ناموفق است؛ انتشارش کلِ ترافیک را می‌بست.",
});

export function rejection(stage: PreflightStage, issues: readonly string[] = []): { ok: false; error: PreflightError } {
  return { ok: false, error: Object.freeze({ code: "PREFLIGHT_REJECTED" as const, stage, message: MESSAGES[stage], issues: Object.freeze([...issues]) }) };
}

export function preflightToolPolicy(options: unknown): PreflightResult {
  let overrides: unknown;
  let build: unknown;
  try {
    const o = options as Record<string, unknown> | null | undefined;
    overrides = o?.overrides;
    build = o?.build;
  } catch {
    return rejection("CONFIG_INVALID");
  }

  // منبعِ ساختگیِ تک‌نسخه‌ای: شکلِ `snapshot()` منبعِ واقعی. نسخهٔ ۱ ⇒ `stored` (نسخهٔ ۰ فقط پیش‌فرضِ کد است).
  // پیوند پیش از هر کارِ دیگر ساخته می‌شود تا «`build` تابع است» فقط **یک** منبعِ حقیقت داشته باشد (خودِ پیوند).
  let candidate: unknown;
  const made = createPolicyBinding({
    source: { snapshot: (): unknown => ({ ok: true, value: { version: 1, source: "stored", drift: false, ageMs: 0, projection: candidate } }) },
    build: build as PreflightOptions["build"],
  });
  if (!made.ok) return rejection("CONFIG_INVALID");

  const resolved = resolveToolPolicy(overrides);
  if (!resolved.ok) return rejection("OVERRIDES_INVALID", resolved.error.issues);
  const projected = projectToolPolicy(resolved.value);
  if (!projected.ok) return rejection("PROJECTION_INVALID");
  candidate = projected.value;

  const lease = made.value.acquire();
  if (!lease.ok) return rejection(lease.error.reason === "BUILD_FAILED" ? "BUILD_FAILED" : "PROJECTION_INVALID");
  return { ok: true, value: Object.freeze({ policy: resolved.value, projection: lease.value.projection }) };
}

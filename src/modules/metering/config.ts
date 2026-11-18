/**
 * اعتبارسنجی پیکربندی روی مرز (ورودی `unknown`؛ بی‌پرتاب؛ مشکل‌ها فقط نام فیلدند، هرگز مقدار).
 */
import { parsePrice } from "@/modules/ai-gateway";
import { ID_RE, LIMITS, parseKey } from "@/modules/ledger";
import { unitForCurrency } from "./estimate";
import type { MeteringResult, OnUnknownCost, ResolvedMeteringConfig, ResolvedModel } from "./types";

export const CONFIG_LIMITS = Object.freeze({ maxScopeIdChars: 96, maxProviderCalls: 20, maxOverheadTokens: 1000, maxFallbacks: 5, maxModels: 64 });

const KEYS: ReadonlySet<string> = new Set(["gateway", "ledger", "account", "currency", "models", "fallbacks", "scopeId", "reservationTtlMs", "maxProviderCalls", "perMessageOverheadTokens", "onUnknownCost"]);
const CURRENCY_RE = /^[A-Z]{3}$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isIntIn = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= lo && v <= hi;
const hasFns = (v: unknown, names: readonly string[]): boolean => (typeof v === "object" || typeof v === "function") && v !== null && names.every((n) => typeof (v as Record<string, unknown>)[n] === "function");

export function resolveMeteringConfig(raw: unknown): MeteringResult<ResolvedMeteringConfig> {
  const issues: string[] = [];
  try {
    if (!isRecord(raw)) return fail(["پیکربندی باید یک شیء ساده باشد."]);
    for (const k of Object.keys(raw)) if (!KEYS.has(k)) issues.push(`کلید ناشناخته: ${JSON.stringify(k.slice(0, 40))}.`);
    if (!hasFns(raw["gateway"], ["complete", "limits"])) issues.push("gateway باید complete و limits داشته باشد.");
    if (!hasFns(raw["ledger"], ["reserve", "charge", "close"])) issues.push("ledger باید reserve، charge و close داشته باشد.");
    const key = parseKey(raw["account"]);
    if (!key.ok) issues.push("account باید { tenantId, accountId } معتبر باشد.");
    const currency = raw["currency"];
    if (typeof currency !== "string" || !CURRENCY_RE.test(currency)) issues.push("currency باید کد سه‌حرفی بزرگ (مثل IRR) باشد.");
    const scopeId = raw["scopeId"];
    if (typeof scopeId !== "string" || !ID_RE.test(scopeId) || scopeId.length > CONFIG_LIMITS.maxScopeIdChars) issues.push(`scopeId باید شناسهٔ معتبر ≤ ${CONFIG_LIMITS.maxScopeIdChars} نویسه باشد.`);
    if (!isIntIn(raw["reservationTtlMs"], LIMITS.MIN_TTL_MS, LIMITS.MAX_TTL_MS)) issues.push(`reservationTtlMs باید عدد صحیح ${LIMITS.MIN_TTL_MS} تا ${LIMITS.MAX_TTL_MS} باشد.`);
    if (!isIntIn(raw["maxProviderCalls"], 1, CONFIG_LIMITS.maxProviderCalls)) issues.push(`maxProviderCalls باید عدد صحیح ۱ تا ${CONFIG_LIMITS.maxProviderCalls} باشد.`);
    if (!isIntIn(raw["perMessageOverheadTokens"], 0, CONFIG_LIMITS.maxOverheadTokens)) issues.push(`perMessageOverheadTokens الزامی است (صحیح ۰ تا ${CONFIG_LIMITS.maxOverheadTokens}).`);
    if (raw["onUnknownCost"] !== "forfeit" && raw["onUnknownCost"] !== "release") issues.push("onUnknownCost الزامی است: «forfeit» یا «release».");

    const models = new Map<string, ResolvedModel>();
    const rawModels = raw["models"];
    if (!isRecord(rawModels) || Object.keys(rawModels).length < 1 || Object.keys(rawModels).length > CONFIG_LIMITS.maxModels) issues.push(`models باید شیئی با ۱ تا ${CONFIG_LIMITS.maxModels} مدل باشد.`);
    else {
      for (const [name, spec] of Object.entries(rawModels)) {
        const at = `models[${JSON.stringify(name.slice(0, 40))}]`;
        if (!isRecord(spec)) {
          issues.push(`${at} باید شیء باشد.`);
          continue;
        }
        if (!isIntIn(spec["maxOutputTokens"], 1, Number.MAX_SAFE_INTEGER)) issues.push(`${at}.maxOutputTokens باید عدد صحیح مثبت باشد.`);
        let price = null;
        if (spec["price"] !== null) {
          const p = parsePrice(spec["price"]);
          if (!p.ok) issues.push(`${at}.price نامعتبر است.`);
          else price = p.value;
        }
        if (isIntIn(spec["maxOutputTokens"], 1, Number.MAX_SAFE_INTEGER)) models.set(name, { price, maxOutputTokens: spec["maxOutputTokens"] });
      }
    }

    const fallbacks = new Map<string, readonly string[]>();
    if (raw["fallbacks"] !== undefined) {
      if (!isRecord(raw["fallbacks"])) issues.push("fallbacks باید شیء باشد.");
      else {
        for (const [from, list] of Object.entries(raw["fallbacks"])) {
          const at = `fallbacks[${JSON.stringify(from.slice(0, 40))}]`;
          if (!models.has(from)) issues.push(`${at}: مدل مبدأ در models نیست.`);
          if (!Array.isArray(list) || list.length < 1 || list.length > CONFIG_LIMITS.maxFallbacks || list.some((m) => typeof m !== "string" || !models.has(m) || m === from) || new Set(list).size !== list.length) {
            issues.push(`${at} باید فهرست یکتای ۱ تا ${CONFIG_LIMITS.maxFallbacks} مدلِ موجود در models و جز خودش باشد.`);
          } else fallbacks.set(from, Object.freeze([...(list as string[])]));
        }
      }
    }
    if (issues.length > 0 || !key.ok) return fail(issues);
    return {
      ok: true,
      value: Object.freeze({
        gateway: raw["gateway"] as ResolvedMeteringConfig["gateway"],
        ledger: raw["ledger"] as ResolvedMeteringConfig["ledger"],
        account: key.value,
        currency: currency as string,
        unit: unitForCurrency(currency as string),
        models,
        fallbacks,
        scopeId: scopeId as string,
        reservationTtlMs: raw["reservationTtlMs"] as number,
        maxProviderCalls: raw["maxProviderCalls"] as number,
        perMessageOverheadTokens: raw["perMessageOverheadTokens"] as number,
        onUnknownCost: raw["onUnknownCost"] as OnUnknownCost,
      }),
    };
  } catch {
    return fail(["خواندن پیکربندی ناموفق بود."]);
  }
}

function fail(issues: readonly string[]): { ok: false; error: { code: "INVALID_CONFIG"; message: string; issues: readonly string[] } } {
  return { ok: false, error: Object.freeze({ code: "INVALID_CONFIG" as const, message: "پیکربندی اندازه‌گیری مصرف نامعتبر است.", issues: Object.freeze([...issues]) }) };
}

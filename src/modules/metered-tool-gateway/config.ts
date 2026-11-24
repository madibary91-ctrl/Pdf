/** اعتبارسنجیِ پیکربندی روی مرز. قاعده‌های مشترک را `resolveMeteringConfig` اعمال می‌کند (تا دو جا نباشد)؛ اینجا فقط آنچه ویژهٔ دروازهٔ ابزار است. */
import { resolveMeteringConfig, type MeteringConfigError, type ResolvedMeteringConfig } from "@/modules/metering";

const KEYS: ReadonlySet<string> = new Set(["gateway", "ledger", "account", "currency", "models", "scopeId", "reservationTtlMs", "perMessageOverheadTokens", "onUnknownCost"]);
const GATEWAY_FNS = ["completeStep", "toolFormat", "limits"] as const;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const keyName = (k: string): string => (k.length > 40 ? `${k.slice(0, 40)}…` : k);

export type ResolvedToolMeteringConfig = Omit<ResolvedMeteringConfig, "gateway" | "fallbacks" | "maxProviderCalls"> &
  Readonly<{ gateway: { completeStep: (input: unknown, options?: unknown) => Promise<unknown>; toolFormat: (model: string) => unknown; limits: (model: string) => unknown } }>;

type Resolved = Readonly<{ ok: true; value: ResolvedToolMeteringConfig }> | Readonly<{ ok: false; error: MeteringConfigError }>;

const fail = (issues: readonly string[]): Resolved => ({
  ok: false,
  error: Object.freeze({ code: "INVALID_CONFIG" as const, message: "پیکربندی اندازه‌گیریِ دروازهٔ ابزار نامعتبر است.", issues: Object.freeze(issues.slice(0, 20)) }),
});

export function resolveToolMeteringConfig(raw: unknown): Resolved {
  const issues: string[] = [];
  let o: Record<string, unknown>;
  try {
    if (!isRecord(raw)) return fail(["پیکربندی باید یک شیء ساده باشد."]);
    o = {};
    for (const k of Object.keys(raw)) {
      if (!KEYS.has(k)) issues.push(`کلید ناشناخته: ${JSON.stringify(keyName(k))}.`);
      else o[k] = raw[k];
    }
  } catch {
    return fail(["خواندن پیکربندی ناموفق بود."]);
  }
  const gw = o["gateway"];
  const hasGateway = isRecord(gw) && GATEWAY_FNS.every((n) => typeof gw[n] === "function");
  if (!hasGateway) issues.push("gateway باید completeStep، toolFormat و limits داشته باشد.");
  if (!hasGateway) {
    // بقیهٔ قاعده‌ها بی‌دروازه هم سنجیده می‌شوند تا همهٔ مشکل‌ها یک‌جا گزارش شود.
    const rest = resolveMeteringConfig({ ...o, gateway: { complete: () => null, limits: () => null }, maxProviderCalls: 1 });
    if (!rest.ok) issues.push(...rest.error.issues);
    return fail(issues);
  }
  const g = gw as Record<string, (...a: unknown[]) => unknown>;
  const limitsOf = (name: string): unknown => g["limits"]!(name);
  const shim = { complete: () => Promise.resolve(null), limits: limitsOf };
  const resolved = resolveMeteringConfig({ ...o, gateway: shim, maxProviderCalls: 1 });
  if (!resolved.ok) issues.push(...resolved.error.issues);
  if (issues.length > 0 || !resolved.ok) return fail(issues);

  // جدولِ پول باید با جدولِ دروازه یکی باشد؛ انحراف = هزینه‌ای که اندازه‌گیری نمی‌شود یا رزروِ نادرست.
  for (const [name, spec] of resolved.value.models) {
    const at = `models[${JSON.stringify(keyName(name))}]`;
    let lim: unknown;
    try {
      lim = limitsOf(name);
    } catch {
      issues.push(`${at}: بررسیِ حدِ مدل در دروازه ناموفق بود.`);
      continue;
    }
    if (!isRecord(lim)) issues.push(`${at}: مدل در دروازه نیست.`);
    else {
      if (lim["priced"] !== (spec.price !== null)) issues.push(`${at}: وضعیتِ قیمت با دروازه هم‌خوان نیست.`);
      if (lim["maxOutputTokens"] !== spec.maxOutputTokens) issues.push(`${at}: maxOutputTokens با دروازه هم‌خوان نیست.`);
    }
  }
  if (issues.length > 0) return fail(issues);
  const { gateway: _shim, fallbacks: _fb, maxProviderCalls: _mp, ...base } = resolved.value;
  void _shim;
  void _fb;
  void _mp;
  return { ok: true, value: Object.freeze({ ...base, gateway: g as unknown as ResolvedToolMeteringConfig["gateway"] }) };
}

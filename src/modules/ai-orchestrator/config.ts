/**
 * سنجش و «گرفتنِ» پیکربندی هنگام ساخت (ADR-0016 §۳): کلید ناشناخته رد؛ سیاست بی‌پیش‌فرض؛ متدهای پورت bind می‌شوند
 * تا ویرایش بعدیِ شیء ورودی اثری نداشته باشد.
 */
import { fail } from "./errors";
import type { AnswerPolicy, CitationChecker, OrchestratorConfig, OrchResult, RepairPolicy } from "./types";

const KEYS: ReadonlySet<string> = new Set(["searcher", "gateway", "checker", "policy"]);
const POLICY_KEYS: ReadonlySet<string> = new Set(["onRejectedCitation", "requireQuotes", "repair"]);
const REPAIR_KEYS: ReadonlySet<string> = new Set(["maxFirstAttemptSpendMicros", "currency"]);
const CURRENCY_RE = /^[A-Z]{3}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const hasFn = (o: unknown, name: string): boolean => typeof o === "object" && o !== null && typeof (o as Record<string, unknown>)[name] === "function";

/**
 * `policy.repair` (ADR-0017 §۱): نبودن (`undefined`) = بی‌ترمیم؛ هر مقدار دیگر باید یک شیء کاملِ معتبر باشد.
 * `null`/`false`/`true` رد می‌شود تا «غیرفعال» با «غلط‌تایپی» اشتباه نشود. بازگشت `null` = نامعتبر (issues پر شد).
 */
function parseRepair(v: unknown, issues: string[]): RepairPolicy | null {
  if (!isRecord(v)) {
    issues.push("policy.repair");
    return null;
  }
  const before = issues.length;
  for (const k of Object.keys(v)) if (!REPAIR_KEYS.has(k)) issues.push(`unknown:policy.repair.${k.slice(0, 40)}`);
  const spend = v["maxFirstAttemptSpendMicros"];
  const currency = v["currency"];
  if (typeof spend !== "number" || !Number.isSafeInteger(spend) || spend < 0) issues.push("policy.repair.maxFirstAttemptSpendMicros");
  if (typeof currency !== "string" || !CURRENCY_RE.test(currency)) issues.push("policy.repair.currency");
  if (issues.length > before) return null;
  return Object.freeze({ maxFirstAttemptSpendMicros: spend as number, currency: currency as string });
}

export type ResolvedConfig = Readonly<{
  searcher: OrchestratorConfig["searcher"];
  gateway: OrchestratorConfig["gateway"];
  checker: CitationChecker;
  policy: AnswerPolicy;
}>;

export function resolveConfig(config: unknown): OrchResult<ResolvedConfig> {
  if (!isRecord(config)) return fail("INVALID_CONFIG", { issues: ["config"] });
  const issues: string[] = [];
  for (const k of Object.keys(config)) if (!KEYS.has(k)) issues.push(`unknown:${k.slice(0, 40)}`);
  const { searcher, gateway, checker, policy } = config;
  if (!hasFn(searcher, "searchArticles")) issues.push("searcher");
  if (!hasFn(gateway, "complete") || !hasFn(gateway, "limits")) issues.push("gateway");
  if (!hasFn(checker, "open")) issues.push("checker");
  let onRejected: AnswerPolicy["onRejectedCitation"] | null = null;
  let requireQuotes: boolean | null = null;
  let repair: RepairPolicy | null = null;
  if (!isRecord(policy)) issues.push("policy");
  else {
    for (const k of Object.keys(policy)) if (!POLICY_KEYS.has(k)) issues.push(`unknown:policy.${k.slice(0, 40)}`);
    if (policy["onRejectedCitation"] === "redact" || policy["onRejectedCitation"] === "withhold") onRejected = policy["onRejectedCitation"];
    else issues.push("policy.onRejectedCitation");
    if (typeof policy["requireQuotes"] === "boolean") requireQuotes = policy["requireQuotes"];
    else issues.push("policy.requireQuotes");
    if (policy["repair"] !== undefined) repair = parseRepair(policy["repair"], issues);
  }
  if (issues.length > 0 || onRejected === null || requireQuotes === null) return fail("INVALID_CONFIG", { issues });

  const s = searcher as OrchestratorConfig["searcher"];
  const g = gateway as OrchestratorConfig["gateway"];
  const c = checker as CitationChecker;
  return {
    ok: true,
    value: Object.freeze({
      searcher: Object.freeze({ searchArticles: s.searchArticles.bind(s) }),
      gateway: Object.freeze({ complete: g.complete.bind(g), limits: g.limits.bind(g) }),
      checker: Object.freeze({ open: c.open.bind(c) }),
      policy: Object.freeze({ onRejectedCitation: onRejected, requireQuotes, ...(repair === null ? {} : { repair }) }),
    }),
  };
}

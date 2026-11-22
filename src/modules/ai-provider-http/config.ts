/**
 * اعتبارسنجیِ پیکربندیِ ارائه‌دهندهٔ HTTP روی مرز (قاعدهٔ ۵). سخت‌گیر: کلیدِ ناشناخته رد می‌شود؛ نشانی فقط `https:`
 * (یا `http:` صریحاً برای loopback)، بی‌userinfo و بی‌fragment؛ کلید در هیچ پیامی بازتاب نمی‌شود.
 */
import type { HttpProviderConfigError, ResolvedHttpOptions } from "./types";

export const HTTP_PROVIDER_LIMITS = Object.freeze({
  defaultMaxResponseBytes: 1_048_576,
  minMaxResponseBytes: 1_024,
  maxMaxResponseBytes: 16_777_216,
  maxEndpointChars: 2_048,
  maxKeyChars: 512,
  defaultAnthropicVersion: "2023-06-01",
});

const KEYS: ReadonlySet<string> = new Set([
  "format",
  "endpoint",
  "getApiKey",
  "fetch",
  "allowInsecureLoopback",
  "maxResponseBytes",
  "anthropicVersion",
  "openaiMaxTokensField",
  "now",
]);
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);
const VERSION_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ISSUES = 10;
const MESSAGE = "پیکربندی ارائه‌دهندهٔ HTTP نامعتبر است.";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export type ResolveResult = Readonly<{ ok: true; value: ResolvedHttpOptions }> | Readonly<{ ok: false; error: HttpProviderConfigError }>;

function bad(issues: readonly string[]): ResolveResult {
  return { ok: false, error: { code: "INVALID_CONFIG", message: MESSAGE, issues: issues.slice(0, MAX_ISSUES) } };
}

/** `null` = نشانی پذیرفته شد؛ وگرنه نامِ قاعدهٔ نقض‌شده (بی‌مقدار). */
function checkEndpoint(raw: unknown, allowLoopback: boolean): { href: string } | { issue: string } {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > HTTP_PROVIDER_LIMITS.maxEndpointChars) {
    return { issue: `endpoint باید رشتهٔ ناتهی تا ${HTTP_PROVIDER_LIMITS.maxEndpointChars} نویسه باشد.` };
  }
  if (/[\u0000-\u0020\u007f-\u009f\\]/.test(raw)) return { issue: "endpoint نباید فاصله، نویسهٔ کنترلی یا بک‌اسلش داشته باشد." };
  // WHATWG URL «ترمیم» می‌کند: `https:///v1` ⇒ میزبانِ `v1`، `https:host` ⇒ `host`؛ کلید نباید به میزبانِ ترمیم‌شده برود.
  if (!/^https?:\/\/[^/?#]/i.test(raw)) return { issue: "endpoint باید به شکل scheme://host/... باشد." };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { issue: "endpoint نشانیِ مطلق و معتبر نیست." };
  }
  if (url.username !== "" || url.password !== "") return { issue: "endpoint نباید userinfo داشته باشد." };
  if (url.hash !== "") return { issue: "endpoint نباید fragment داشته باشد." };
  if (url.protocol === "https:") return { href: url.href };
  if (url.protocol === "http:") {
    if (!allowLoopback) return { issue: "endpoint باید https باشد." };
    if (!LOOPBACK_HOSTS.has(url.hostname)) return { issue: "http فقط برای localhost/127.0.0.1/[::1] مجاز است." };
    return { href: url.href };
  }
  return { issue: "endpoint باید https باشد." };
}

export function resolveOptions(input: unknown): ResolveResult {
  if (!isRecord(input)) return bad(["options باید شیء باشد."]);
  const issues: string[] = [];
  for (const k of Object.keys(input)) {
    if (!KEYS.has(k)) issues.push(`کلیدِ ناشناخته: ${k.slice(0, 40)}.`);
  }
  const format = input["format"];
  if (format !== "openai-chat" && format !== "anthropic-messages") issues.push("format باید openai-chat یا anthropic-messages باشد.");
  if (typeof input["getApiKey"] !== "function") issues.push("getApiKey باید تابع باشد.");
  if (typeof input["fetch"] !== "function") issues.push("fetch باید تابع باشد.");

  const loop = input["allowInsecureLoopback"];
  if (loop !== undefined && typeof loop !== "boolean") issues.push("allowInsecureLoopback باید بولی باشد.");
  const ep = checkEndpoint(input["endpoint"], loop === true);
  if ("issue" in ep) issues.push(ep.issue);

  let maxResponseBytes: number = HTTP_PROVIDER_LIMITS.defaultMaxResponseBytes;
  const mrb = input["maxResponseBytes"];
  if (mrb !== undefined) {
    if (typeof mrb !== "number" || !Number.isInteger(mrb) || mrb < HTTP_PROVIDER_LIMITS.minMaxResponseBytes || mrb > HTTP_PROVIDER_LIMITS.maxMaxResponseBytes) {
      issues.push(`maxResponseBytes باید عددِ صحیحِ ${HTTP_PROVIDER_LIMITS.minMaxResponseBytes} تا ${HTTP_PROVIDER_LIMITS.maxMaxResponseBytes} باشد.`);
    } else maxResponseBytes = mrb;
  }
  let anthropicVersion: string = HTTP_PROVIDER_LIMITS.defaultAnthropicVersion;
  const av = input["anthropicVersion"];
  if (av !== undefined) {
    if (typeof av !== "string" || !VERSION_RE.test(av)) issues.push("anthropicVersion باید به شکل YYYY-MM-DD باشد.");
    else anthropicVersion = av;
  }
  let openaiMaxTokensField: "max_tokens" | "max_completion_tokens" = "max_tokens";
  const f = input["openaiMaxTokensField"];
  if (f !== undefined) {
    if (f !== "max_tokens" && f !== "max_completion_tokens") issues.push("openaiMaxTokensField باید max_tokens یا max_completion_tokens باشد.");
    else openaiMaxTokensField = f;
  }
  let now: () => number = Date.now;
  const n = input["now"];
  if (n !== undefined) {
    if (typeof n !== "function") issues.push("now باید تابع باشد.");
    else now = n as () => number;
  }
  if (issues.length > 0) return bad(issues);

  return {
    ok: true,
    value: Object.freeze({
      format: format as "openai-chat" | "anthropic-messages",
      endpoint: (ep as { href: string }).href,
      getApiKey: input["getApiKey"] as ResolvedHttpOptions["getApiKey"],
      fetch: input["fetch"] as ResolvedHttpOptions["fetch"],
      maxResponseBytes,
      anthropicVersion,
      openaiMaxTokensField,
      now,
    }),
  };
}

/** کلیدِ هر تماس: ASCII قابل‌چاپ بی‌فاصله (مانعِ تزریقِ سرایند). `null` = نامعتبر. */
export function sanitizeApiKey(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > HTTP_PROVIDER_LIMITS.maxKeyChars) return null;
  return /^[\x21-\x7e]+$/.test(raw) ? raw : null;
}

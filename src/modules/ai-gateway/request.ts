/**
 * اعتبارسنجی درخواست روی مرز: سخت‌گیر، بی‌حدس، و **بی‌نشتِ محتوا** (مشکل‌ها فقط نام فیلد و محدودیت‌اند).
 * همهٔ مشکل‌ها یک‌جا گزارش می‌شوند؛ هرگز پرتاب نمی‌کند (حتی با getter خصمانه).
 */
import { LIMITS } from "./config";
import type { ResolvedModel } from "./config";
import { fail } from "./errors";
import type { ChatMessage, GatewayResult, ParsedRequest, Role } from "./types";

export const REQUEST_LIMITS = Object.freeze({
  maxMessages: 64,
  maxMessageChars: 1_000_000,
  maxStopSequences: 4,
  maxStopChars: 64,
  maxRequestIdChars: 128,
  maxTemperature: 2,
});

const KEYS: ReadonlySet<string> = new Set(["model", "messages", "maxOutputTokens", "temperature", "stopSequences", "requestId", "timeoutMs"]);
const MESSAGE_KEYS: ReadonlySet<string> = new Set(["role", "content"]);
const ROLES: ReadonlySet<string> = new Set(["system", "user", "assistant"]);
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isIntIn = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
const key = (k: string): string => JSON.stringify(k.slice(0, 40));

/** متن معتبرِ Unicode و بدون NUL (جفت‌جانشینِ تنها در JSON ارائه‌دهنده خراب می‌شود؛ NUL در لاگ/پایگاه). */
function badText(s: string): string | null {
  if (!s.isWellFormed()) return "Unicode نامعتبر (جفت‌جانشین تنها)";
  if (s.includes("\u0000")) return "نویسهٔ NUL";
  return null;
}

type Lookup = (name: string) => ResolvedModel | undefined;

function readMessages(raw: unknown, model: ResolvedModel | undefined, issues: string[]): readonly ChatMessage[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > REQUEST_LIMITS.maxMessages) {
    issues.push(`messages باید آرایهٔ ۱ تا ${REQUEST_LIMITS.maxMessages} پیام باشد.`);
    return null;
  }
  const before = issues.length;
  const out: ChatMessage[] = [];
  let total = 0;
  raw.forEach((m: unknown, i) => {
    const at = `messages[${i}]`;
    if (!isRecord(m)) {
      issues.push(`${at} باید شیء باشد.`);
      return;
    }
    for (const k of Object.keys(m)) if (!MESSAGE_KEYS.has(k)) issues.push(`${at}: کلید ناشناخته ${key(k)} (فقط role و content).`);
    const role = m["role"];
    if (typeof role !== "string" || !ROLES.has(role)) issues.push(`${at}.role باید system، user یا assistant باشد.`);
    else if (role === "system" && i !== 0) issues.push(`${at}.role: system فقط می‌تواند پیام اول باشد.`);
    const content = m["content"];
    if (typeof content !== "string") {
      issues.push(`${at}.content باید متن باشد.`);
      return;
    }
    if (content.trim() === "") issues.push(`${at}.content نباید تهی یا فقط فاصله باشد.`);
    if (content.length > REQUEST_LIMITS.maxMessageChars) issues.push(`${at}.content از ${REQUEST_LIMITS.maxMessageChars} نویسه بیشتر است.`);
    const bt = badText(content);
    if (bt !== null) issues.push(`${at}.content: ${bt}.`);
    total += content.length;
    if (typeof role === "string") out.push({ role: role as Role, content });
  });
  if (isRecord(raw[raw.length - 1]) && (raw[raw.length - 1] as Record<string, unknown>)["role"] !== "user") issues.push("messages: آخرین پیام باید user باشد.");
  if (model !== undefined && total > model.maxInputChars) issues.push(`messages: مجموع نویسه‌ها از سقف مدل (${model.maxInputChars}) بیشتر است.`);
  return issues.length === before ? out : null;
}

function readStops(raw: unknown, issues: string[]): readonly string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > REQUEST_LIMITS.maxStopSequences) {
    issues.push(`stopSequences باید آرایهٔ حداکثر ${REQUEST_LIMITS.maxStopSequences} رشته باشد.`);
    return [];
  }
  const out: string[] = [];
  raw.forEach((s: unknown, i) => {
    if (typeof s !== "string" || s.length < 1 || s.length > REQUEST_LIMITS.maxStopChars) issues.push(`stopSequences[${i}] باید رشتهٔ ۱ تا ${REQUEST_LIMITS.maxStopChars} نویسه باشد.`);
    else if (badText(s) !== null) issues.push(`stopSequences[${i}]: ${badText(s)}.`);
    else if (out.includes(s)) issues.push(`stopSequences[${i}] تکراری است.`);
    else out.push(s);
  });
  return out;
}

export function parseRequest(input: unknown, lookup: Lookup): GatewayResult<ParsedRequest> {
  try {
    if (!isRecord(input)) return fail("INVALID_REQUEST", { issues: ["درخواست باید شیء باشد."] });
    const issues: string[] = [];
    for (const k of Object.keys(input)) if (!KEYS.has(k)) issues.push(`کلید ناشناخته ${key(k)} (مجاز: ${[...KEYS].join("، ")}).`);

    const modelName = input["model"];
    if (typeof modelName !== "string" || modelName === "") return fail("INVALID_REQUEST", { issues: [...issues, "model باید متن غیرتهی باشد."] });
    const model = lookup(modelName);
    if (model === undefined) return fail("UNKNOWN_MODEL", { issues });

    const messages = readMessages(input["messages"], model, issues);

    const mot = input["maxOutputTokens"];
    if (!isIntIn(mot, 1, model.maxOutputTokens)) issues.push(`maxOutputTokens الزامی و عدد صحیح ۱ تا ${model.maxOutputTokens} (سقف مدل) است.`);

    let temperature = 0;
    if (input["temperature"] !== undefined) {
      const t = input["temperature"];
      if (typeof t !== "number" || !Number.isFinite(t) || t < 0 || t > REQUEST_LIMITS.maxTemperature) issues.push(`temperature باید عددی ۰ تا ${REQUEST_LIMITS.maxTemperature} باشد.`);
      else temperature = t;
    }

    const stopSequences = readStops(input["stopSequences"], issues);

    let requestId: string | null = null;
    if (input["requestId"] !== undefined) {
      const r = input["requestId"];
      if (typeof r !== "string" || !REQUEST_ID_RE.test(r)) issues.push("requestId باید ۱ تا ۱۲۸ نویسه از A-Za-z0-9._:- باشد.");
      else requestId = r;
    }

    let timeoutMs = model.timeoutMs;
    if (input["timeoutMs"] !== undefined) {
      const t = input["timeoutMs"];
      if (!isIntIn(t, 1, LIMITS.maxTimeoutMs)) issues.push(`timeoutMs باید عدد صحیح ۱ تا ${LIMITS.maxTimeoutMs} باشد.`);
      else timeoutMs = t;
    }

    if (issues.length > 0) return fail("INVALID_REQUEST", { issues });
    return {
      ok: true,
      value: Object.freeze({
        model: model.name,
        messages: Object.freeze((messages as readonly ChatMessage[]).map((m) => Object.freeze({ ...m }))),
        maxOutputTokens: mot as number,
        temperature,
        stopSequences: Object.freeze([...stopSequences]),
        requestId,
        timeoutMs,
      }),
    };
  } catch {
    return fail("INVALID_REQUEST", { issues: ["درخواست قابل خواندن نیست."] });
  }
}

/** اعتبارسنجی ورودی `ask` روی مرز: سخت‌گیر، بی‌حدس، همهٔ مشکل‌ها یک‌جا و فقط با نام فیلد (هرگز محتوا). */
import { DEFAULT_CONTEXT_CHARS, MAX_CONTEXT_CHARS, MAX_QUESTION_CHARS, MIN_CONTEXT_CHARS, parseRequest as parseRetrievalRequest } from "@/modules/retrieval";
import { fail } from "./errors";
import type { OrchResult, ParsedAsk, RetrievalOptions } from "./types";

export const REQUEST_LIMITS = Object.freeze({
  maxQuestionChars: MAX_QUESTION_CHARS,
  minContextChars: MIN_CONTEXT_CHARS,
  maxContextChars: MAX_CONTEXT_CHARS,
  defaultContextChars: DEFAULT_CONTEXT_CHARS,
  maxModelChars: 128,
  maxDocumentIdChars: 256,
  maxTimeoutMs: 600_000,
});

const KEYS: ReadonlySet<string> = new Set(["question", "asOf", "model", "maxOutputTokens", "documentId", "contextMaxChars", "retrieval", "requestId", "timeoutMs"]);
const RETRIEVAL_KEYS: ReadonlySet<string> = new Set(["limit", "maxTerms", "minCoverage", "maxQueries"]);
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const CONTROL_RE = new RegExp("[\\u0000-\\u001f\\u007f]");

/** تاریخ تقویمی (میلادی) معتبر به شکل `YYYY-MM-DD`؛ با حساب خالص، بی‌ساعت. */
export function isCalendarDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m === null) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1] as number;
  return d <= days;
}

/** جفت‌جانشینِ تنهای Unicode (دروازه آن را رد می‌کند؛ پیش از هزینهٔ بازیابی می‌گیریم). */
export function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (n >= 0xdc00 && n <= 0xdfff) i++;
      else return true;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseAskRequest(input: unknown): OrchResult<ParsedAsk> {
  if (!isRecord(input)) return fail("INVALID_INPUT", { issues: ["input"] });
  const issues: string[] = [];
  for (const k of Object.keys(input)) if (!KEYS.has(k)) issues.push(`unknown:${k.slice(0, 40).replace(CONTROL_RE, "?")}`);

  const q = input["question"];
  if (typeof q !== "string" || q.trim() === "" || q.length > MAX_QUESTION_CHARS || q.includes("\u0000") || hasLoneSurrogate(q)) issues.push("question");
  const asOf = input["asOf"];
  if (typeof asOf !== "string" || !isCalendarDate(asOf)) issues.push("asOf");
  const model = input["model"];
  if (typeof model !== "string" || model === "" || model.length > REQUEST_LIMITS.maxModelChars || CONTROL_RE.test(model)) issues.push("model");
  const maxOut = input["maxOutputTokens"];
  if (typeof maxOut !== "number" || !Number.isInteger(maxOut) || maxOut < 1) issues.push("maxOutputTokens");

  let documentId: string | null = null;
  if (input["documentId"] !== undefined) {
    const d = input["documentId"];
    if (typeof d !== "string" || d === "" || d.length > REQUEST_LIMITS.maxDocumentIdChars || CONTROL_RE.test(d)) issues.push("documentId");
    else documentId = d;
  }
  let contextMaxChars: number = DEFAULT_CONTEXT_CHARS;
  if (input["contextMaxChars"] !== undefined) {
    const c = input["contextMaxChars"];
    if (typeof c !== "number" || !Number.isInteger(c) || c < MIN_CONTEXT_CHARS || c > MAX_CONTEXT_CHARS) issues.push("contextMaxChars");
    else contextMaxChars = c;
  }
  let retrieval: RetrievalOptions = {};
  if (input["retrieval"] !== undefined) {
    const r = input["retrieval"];
    // بازه‌ها را خودِ `retrieval` می‌سنجد (منبع حقیقت)؛ ورودی نمونهٔ ثابت است و محتوای کاربر به آن نمی‌رسد.
    if (!isRecord(r) || Object.keys(r).some((k) => !RETRIEVAL_KEYS.has(k)) || !parseRetrievalRequest({ question: "x", asOf: "2000-01-01", ...r }).ok) issues.push("retrieval");
    else retrieval = { ...r } as RetrievalOptions;
  }
  let requestId: string | null = null;
  if (input["requestId"] !== undefined) {
    const id = input["requestId"];
    if (typeof id !== "string" || !REQUEST_ID_RE.test(id)) issues.push("requestId");
    else requestId = id;
  }
  let timeoutMs: number | null = null;
  if (input["timeoutMs"] !== undefined) {
    const t = input["timeoutMs"];
    if (typeof t !== "number" || !Number.isInteger(t) || t < 1 || t > REQUEST_LIMITS.maxTimeoutMs) issues.push("timeoutMs");
    else timeoutMs = t;
  }
  if (issues.length > 0) return fail("INVALID_INPUT", { issues });
  return {
    ok: true,
    value: { question: q as string, asOf: asOf as string, model: model as string, maxOutputTokens: maxOut as number, documentId, contextMaxChars, retrieval, requestId, timeoutMs },
  };
}

/**
 * تفسیرِ پاسخِ HTTP: نگاشتِ وضعیت به نوعِ شکست، `Retry-After` و خواندنِ بدنه با سقفِ بایت. بدنهٔ پاسخِ **ناموفق هرگز خوانده یا بازتاب
 * نمی‌شود** (ممکن است کلید/متنِ پرسش را برگرداند). هرگز JSON را تفسیر نمی‌کند؛ فقط «خام و نامطمئن» برمی‌گرداند.
 */
import type { ProviderFailureKind } from "@/modules/ai-gateway";

export type StatusClass = "ok" | ProviderFailureKind;

/** ۲xx ⇒ ok؛ ۴۰۱/۴۰۳ ⇒ auth؛ ۴۲۹ ⇒ rate_limited؛ ۴۰۸ و ۵xx (از جمله ۵۲۹ِ Anthropic) ⇒ unavailable؛ بقیه (۱xx/۳xx/سایر ۴xx) ⇒ rejected. */
export function classifyStatus(status: number): StatusClass {
  if (!Number.isInteger(status)) return "rejected";
  if (status >= 200 && status <= 299) return "ok";
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status === 408 || (status >= 500 && status <= 599)) return "unavailable";
  return "rejected";
}

const DIGITS_MS = /^\d{1,9}$/;
const DIGITS_S = /^\d{1,7}$/;

/**
 * `retry-after-ms` (OpenAI)، سپس `retry-after` (ثانیهٔ صحیح یا تاریخِ HTTP). نامعتبر ⇒ `undefined`. سقفِ ۱ ساعت را `ProviderFailure` اعمال می‌کند.
 * هرگز عددِ اعشاری/منفی/نمادی نمی‌پذیرد (جلوگیری از انتظارِ نامعقول).
 */
export function parseRetryAfter(headers: Pick<Headers, "get">, now: () => number): number | undefined {
  const ms = headers.get("retry-after-ms");
  if (ms !== null && DIGITS_MS.test(ms.trim())) return Number(ms.trim());
  const ra = headers.get("retry-after");
  if (ra === null) return undefined;
  const v = ra.trim();
  if (DIGITS_S.test(v)) return Number(v) * 1000;
  if (!/[A-Za-z]/.test(v)) return undefined;
  const at = Date.parse(v);
  if (!Number.isFinite(at)) return undefined;
  const t = now();
  if (typeof t !== "number" || !Number.isFinite(t)) return undefined;
  return Math.max(0, Math.ceil(at - t));
}

/** رهاکردنِ بدنه برای آزادسازیِ اتصال؛ هیچ‌گاه پرتاب نمی‌کند. */
export async function discardBody(res: Pick<Response, "body">): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* بی‌اهمیت */
  }
}

/**
 * بدنه را تا `maxBytes` می‌خواند و JSON تفسیر می‌کند. بزرگ‌تر از سقف (با `content-length` یا حینِ خواندن)، UTF-8 نامعتبر یا JSON
 * نامعتبر ⇒ `null` (دروازه آن را `BAD_RESPONSE` می‌کند). خطای جریان (قطعِ اتصال/لغو) پرتاب می‌شود تا فراخواننده نگاشتش کند.
 */
export async function readJsonCapped(res: Pick<Response, "body" | "headers">, maxBytes: number): Promise<unknown> {
  const cl = res.headers.get("content-length");
  if (cl !== null && /^\d+$/.test(cl.trim()) && Number(cl.trim()) > maxBytes) {
    await discardBody(res);
    return null;
  }
  if (res.body === null) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array)) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(all);
  } catch {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

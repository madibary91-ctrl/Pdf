/**
 * ارائه‌دهندهٔ HTTPِ ابزار (ADR-0057). `createHttpToolProvider(options)` ⇒ `ToolModelProvider` برای `createToolGateway`.
 *
 * پایه‌های ایمنی: کلید فقط در سرایندِ همان تماس و هرگز در شیء/خطا/لاگ؛ `redirect: "error"` (سرایندِ `x-api-key` در تغییرِ مسیر
 * نباید به میزبانِ دیگر برود)؛ بدنهٔ پاسخِ ناموفق خوانده نمی‌شود؛ بدنهٔ موفق سقفِ بایت دارد؛ لغو/مهلت را خودِ دروازه تعیین می‌کند
 * و این‌جا فقط `signal` به `fetch` می‌رسد.
 */
import { ProviderFailure } from "@/modules/ai-gateway";
import type { ToolModelProvider, ToolProviderCall } from "@/modules/ai-gateway";
import { buildHeaders, buildRequestBody } from "./body";
import { resolveOptions, sanitizeApiKey } from "./config";
import { classifyStatus, discardBody, parseRetryAfter, readJsonCapped } from "./response";
import type { HttpProviderResult, ResolvedHttpOptions } from "./types";

async function readKey(opts: ResolvedHttpOptions): Promise<string> {
  let raw: unknown;
  try {
    raw = await opts.getApiKey();
  } catch {
    // علتِ اصلی عمداً دور ریخته می‌شود: ممکن است خودِ کلید یا مسیرِ فایلِ اسرار را بازتاب دهد.
    throw new ProviderFailure("auth");
  }
  const key = sanitizeApiKey(raw);
  if (key === null) throw new ProviderFailure("auth");
  return key;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("aborted");
}

async function send(opts: ResolvedHttpOptions, call: ToolProviderCall): Promise<unknown> {
  const key = await readKey(opts);
  if (call.signal.aborted) throw abortReason(call.signal);
  const body = JSON.stringify(buildRequestBody(opts.format, call, opts.openaiMaxTokensField));
  let res: Response;
  try {
    res = await opts.fetch(opts.endpoint, {
      method: "POST",
      headers: buildHeaders(opts.format, key, opts.anthropicVersion),
      body,
      signal: call.signal,
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
  } catch (e) {
    if (call.signal.aborted) throw abortReason(call.signal);
    throw new ProviderFailure("unavailable", { cause: e });
  }
  const cls = res.redirected === true ? "rejected" : classifyStatus(res.status);
  if (cls !== "ok") {
    // `Retry-After` فقط برای دو نوعِ قابل‌تلاش معنا دارد؛ برای auth/rejected هرگز منتقل نمی‌شود.
    const retryAfterMs = cls === "rate_limited" || cls === "unavailable" ? parseRetryAfter(res.headers, opts.now) : undefined;
    await discardBody(res);
    throw new ProviderFailure(cls, retryAfterMs === undefined ? {} : { retryAfterMs });
  }
  try {
    return await readJsonCapped(res, opts.maxResponseBytes);
  } catch (e) {
    if (call.signal.aborted) throw abortReason(call.signal);
    throw new ProviderFailure("unavailable", { cause: e });
  }
}

/** هرگز پرتاب نمی‌کند؛ پیکربندیِ نامعتبر ⇒ `{ ok: false }`. شیءِ نتیجه یخ‌زده است و هیچ فیلدِ حاویِ کلید/نشانی ندارد. */
export function createHttpToolProvider(options: unknown): HttpProviderResult {
  const r = resolveOptions(options);
  if (!r.ok) return r;
  const opts = r.value;
  const provider: ToolModelProvider = Object.freeze({
    completeWithTools: (call: ToolProviderCall): Promise<unknown> => send(opts, call),
  });
  return { ok: true, value: provider };
}

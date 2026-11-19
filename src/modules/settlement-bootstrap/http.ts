/**
 * settlement-bootstrap — پاسخ HTTP پروب‌ها (ADR-0033 تصمیم ۴). فقط ترجمهٔ `ProbeResult` به `Response` استاندارد؛
 * هرگز نمی‌پرتابد، هرگز کش نمی‌شود، و بدنه فقط `{probe, ok, state, sweep}` است (بسته؛ بی‌پیام خطا و بی‌شمارنده).
 * `kind` ناشناخته یا میزبانِ خراب ⇒ ۵۰۳ با بدنهٔ ثابت.
 */
import { probeSettlementHost } from "@/modules/settlement-host";
import type { ProbeKind } from "@/modules/settlement-host";

const HEADERS = Object.freeze({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });

export function probeHttpResponse(store: unknown, kind: ProbeKind): Response {
  try {
    if (kind !== "live" && kind !== "startup" && kind !== "ready") throw new TypeError("kind");
    const r = probeSettlementHost(store, kind);
    return new Response(JSON.stringify(r.body), { status: r.httpStatus, headers: { ...HEADERS } });
  } catch {
    return new Response(JSON.stringify({ ok: false }), { status: 503, headers: { ...HEADERS } });
  }
}

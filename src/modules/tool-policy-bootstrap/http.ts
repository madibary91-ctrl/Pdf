/**
 * tool-policy-bootstrap · پاسخ HTTP پروب‌ها (ADR-0076 تصمیم ۴). فقط ترجمهٔ `ProbeResult` به `Response` استاندارد؛
 * هرگز نمی‌پرتابد، هرگز کش نمی‌شود، و بدنه فقط `{probe, ok, state, reason}` است (بسته؛ بی‌پیام خطا و بی‌شمارنده).
 * `kind` ناشناخته، میزبانِ خراب یا پاسخِ ناهمساز (۲۰۰ با ok=false یا ۵۰۳ با ok=true) ⇒ ۵۰۳ با بدنهٔ ثابتِ `{ok:false}`:
 * هیچ مسیری از «نمی‌دانم» به ۲۰۰ نیست.
 */
import { probeToolPolicyHost } from "@/modules/tool-policy-host";
import type { ProbeKind } from "@/modules/tool-policy-host";

const HEADERS = Object.freeze({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });

const unavailable = (): Response => new Response(JSON.stringify({ ok: false }), { status: 503, headers: { ...HEADERS } });

export function probeHttpResponse(store: unknown, kind: ProbeKind): Response {
  try {
    if (kind !== "live" && kind !== "startup" && kind !== "ready") return unavailable();
    const r = probeToolPolicyHost(store, kind) as unknown;
    if (typeof r !== "object" || r === null) return unavailable();
    const status = (r as { httpStatus?: unknown }).httpStatus;
    const body = (r as { body?: unknown }).body;
    if ((status !== 200 && status !== 503) || typeof body !== "object" || body === null) return unavailable();
    const b = body as { ok?: unknown; state?: unknown; reason?: unknown };
    if (typeof b.ok !== "boolean" || b.ok !== (status === 200)) return unavailable();
    if (typeof b.state !== "string" || (b.reason !== null && typeof b.reason !== "string")) return unavailable();
    return new Response(JSON.stringify({ probe: kind, ok: b.ok, state: b.state, reason: b.reason }), { status, headers: { ...HEADERS } });
  } catch {
    return unavailable();
  }
}

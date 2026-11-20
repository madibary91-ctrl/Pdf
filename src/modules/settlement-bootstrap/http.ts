/**
 * settlement-bootstrap · پاسخ HTTP پروب‌ها (ADR-0033 تصمیم ۴، ADR-0043). فقط ترجمهٔ `ProbeResult` به `Response` استاندارد؛
 * هرگز نمی‌پرتابد، هرگز کش نمی‌شود، و بدنه فقط `{probe, ok, state, sweep}` است (بسته؛ بی‌پیام خطا و بی‌شمارنده).
 * `kind` ناشناخته یا میزبانِ خراب ⇒ ۵۰۳ با بدنهٔ ثابت.
 *
 * **پسماندِ زنگ (ADR-0043):** فقط وقتی پایشِ زنده در ظرف ثبت شده باشد (`SETTLEMENT_BACKLOG_WATCH=on`) کلیدِ پنجمِ اختیاریِ `backlog` به بدنهٔ
 * `ready` و `startup` افزوده می‌شود؛ بدونِ پایش بدنه و کد **بایت‌به‌بایت** مثلِ قبل است. سیاست را `projectBacklogForProbe` (تصمیمِ مالک، ADR-0042)
 * می‌گیرد: `live` هرگز گزارش/مسدود نمی‌شود، `startup` هرگز مسدود نمی‌شود، `ready` فقط با `gate_down ∧ down` ۵۰۳ می‌شود. پسماند **فقط می‌تواند
 * ۲۰۰ را ۵۰۳ کند**، هرگز ۵۰۳ را ۲۰۰؛ و هر خطایی در این بخش «نمی‌دانم» است که چیزی را مسدود نمی‌کند (پاسخِ میزبان دست‌نخورده).
 */
import { projectBacklogForProbe } from "@/modules/settlement-backlog-watch";
import { probeSettlementHost } from "@/modules/settlement-host";
import type { ProbeKind, ProbeResult } from "@/modules/settlement-host";

const HEADERS = Object.freeze({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });

/** کلیدِ ثبتِ پایشِ زنده روی ظرفِ singleton (کنارِ `SETTLEMENT_HOST_STORE_KEY`). فقط داخلِ همین ماژول است و از index صادر نمی‌شود. */
export const BACKLOG_WATCH_STORE_KEY: unique symbol = Symbol.for("legal-platform.settlement-bootstrap.backlog-watch");

const isObj = (v: unknown): v is Record<string | symbol, unknown> => (typeof v === "object" || typeof v === "function") && v !== null;

/** `present:false` ⇒ پایشی ثبت نشده (هیچ کلیدی افزوده نمی‌شود). ثبت‌شدهٔ خراب ⇒ `view: null` (بخشِ `unknown`، بی‌مسدودسازی). */
function readWatchView(store: unknown): { present: false } | { present: true; view: unknown } {
  try {
    if (!isObj(store)) return { present: false };
    const slot = store[BACKLOG_WATCH_STORE_KEY];
    if (slot === undefined) return { present: false };
    if (!isObj(slot) || typeof slot["view"] !== "function") return { present: true, view: null };
    try {
      return { present: true, view: (slot["view"] as () => unknown)() };
    } catch {
      return { present: true, view: null };
    }
  } catch {
    return { present: false };
  }
}

function withBacklog(store: unknown, kind: ProbeKind, r: ProbeResult): { status: number; body: unknown } {
  const plain = { status: r.httpStatus, body: r.body as unknown };
  try {
    const w = readWatchView(store);
    if (!w.present) return plain;
    const p = projectBacklogForProbe(kind, w.view);
    if (p.section === null) return plain;
    // `blocks` فقط به ۵۰۳ می‌رسد؛ مسیری از ۵۰۳ به ۲۰۰ وجود ندارد (میزبانِ ناسالم همین‌طور ۵۰۳ می‌ماند).
    return { status: p.blocks ? 503 : r.httpStatus, body: { ...r.body, ok: p.blocks ? false : r.body.ok, backlog: p.section } };
  } catch {
    return plain;
  }
}

export function probeHttpResponse(store: unknown, kind: ProbeKind): Response {
  try {
    if (kind !== "live" && kind !== "startup" && kind !== "ready") throw new TypeError("kind");
    const r = probeSettlementHost(store, kind);
    const out = withBacklog(store, kind, r);
    return new Response(JSON.stringify(out.body), { status: out.status, headers: { ...HEADERS } });
  } catch {
    return new Response(JSON.stringify({ ok: false }), { status: 503, headers: { ...HEADERS } });
  }
}

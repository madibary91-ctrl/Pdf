/**
 * دروازهٔ ابزارِ ماندگار (ADR-0063): `metered-tool-gateway` روی دفتر تسویهٔ ماندگار (`settlement`). هر گامِ ابزار پیش از تماس رزرو **و** در outbox ثبت می‌شود؛
 * شکستِ تسویه، مرگِ فرایند وسط تماس و `close`ِ ناتمام را رفتگرِ `settlement` با تکرارِ idempotent می‌بندد (کاربر مجانی نمی‌گیرد و پول گم نمی‌شود).
 * ترکیبِ خالصِ پیکربندی: منطقِ رزرو/تسویه در `metered-tool-gateway` و منطقِ outbox در `settlement` می‌ماند؛ این‌جا فقط یک منبعِ حقیقت برای
 * `onUnknownCost` و `ttl ≥ ۲ × graceMs` است. هرگز نمی‌پرتابد و متنِ استثنا را نمی‌گیرد.
 */
import { createMeteredToolGateway } from "@/modules/metered-tool-gateway";
import type { MeteredToolGateway } from "@/modules/metered-tool-gateway";
import { createDurableLedger } from "@/modules/settlement";
import type { SettlementResult } from "@/modules/settlement";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const fail = (issues: readonly string[]): SettlementResult<never> =>
  Object.freeze({
    ok: false as const,
    error: Object.freeze({ code: "INVALID_CONFIG" as const, message: "پیکربندی دروازهٔ ابزارِ ماندگار نامعتبر است.", issues: Object.freeze([...issues]) }),
  });

/**
 * ورودی = گزینه‌های `createMeteredToolGateway` (با `ledger` = **دفتر خام**؛ رفتگر را هم با همان بسازید) + `outbox` + `clock` + `graceMs`.
 * `reservationTtlMs` باید دست‌کم دو برابر `graceMs` باشد (وگرنه دفترِ ماندگار هر رزرو را رد می‌کرد و هر گام «ردّ» می‌شد).
 */
export function createDurableToolGateway(raw: unknown): SettlementResult<MeteredToolGateway> {
  try {
    if (!isRecord(raw)) return fail(["پیکربندی باید یک شیء ساده باشد."]);
    // هر کلید فقط یک بار خوانده می‌شود (getter/Proxy نتواند بین اعتبارسنجی و ساخت مقدار عوض کند).
    const { outbox, clock, graceMs, ...metered } = raw;
    const issues: string[] = [];
    const add = (xs: readonly string[]): void => {
      for (const x of xs) if (!issues.includes(x)) issues.push(x);
    };

    // `onUnknownCost` تنها یک منبع دارد: همان مقدارِ دروازه، برای رزروِ یتیمِ outbox هم می‌رود.
    const durable = createDurableLedger({ ledger: metered["ledger"], outbox, clock, graceMs, onUnknownCost: metered["onUnknownCost"] });
    if (!durable.ok) add(durable.error.issues);

    // همیشه سمتِ metered هم سنجیده می‌شود تا خطاها یک‌جا گزارش شوند؛ ساخت بی‌I/O است.
    const made = createMeteredToolGateway(durable.ok ? { ...metered, ledger: durable.value } : metered);
    if (!made.ok) add(made.error.issues);

    const ttl = metered["reservationTtlMs"];
    if (typeof ttl === "number" && typeof graceMs === "number" && Number.isFinite(ttl) && Number.isFinite(graceMs) && ttl < 2 * graceMs) {
      add(["reservationTtlMs باید دست‌کم دو برابر graceMs باشد."]);
    }

    if (issues.length > 0 || !durable.ok || !made.ok) return fail(issues);
    return { ok: true, value: made.value };
  } catch {
    return fail(["خواندن پیکربندی ناموفق بود."]);
  }
}

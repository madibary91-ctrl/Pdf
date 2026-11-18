/**
 * settlement — پوشش‌های ایمن روی پورت‌ها (outbox و دفتر). پورت‌ها بیرونی‌اند: ممکن است بپرتابند یا شکلِ نادرست برگردانند؛
 * هیچ‌کدام نباید فراخواننده را بشکنند. پیام خام پورت‌ها هرگز بیرون نمی‌آید (فقط کد).
 */
import type { LedgerError, LedgerResult } from "@/modules/ledger";
import type { OutboxError, OutboxResult } from "./types";

const isResult = (v: unknown): v is { ok: boolean } => typeof v === "object" && v !== null && typeof (v as { ok?: unknown }).ok === "boolean";

export async function safeOutbox<T>(op: () => Promise<OutboxResult<T>>): Promise<OutboxResult<T>> {
  try {
    const r: unknown = await op();
    if (isResult(r) && (r.ok ? "value" in r : typeof (r as { error?: { code?: unknown } }).error?.code === "string")) return r as OutboxResult<T>;
  } catch {
    // پرتاب پورت ⇒ شکست ذخیره
  }
  return { ok: false, error: Object.freeze({ code: "STORE_FAILURE", message: "ذخیرهٔ outbox در دسترس نیست." }) };
}

export async function safeLedger<T>(op: () => Promise<LedgerResult<T>>): Promise<LedgerResult<T>> {
  try {
    const r: unknown = await op();
    if (isResult(r) && (r.ok ? "value" in r : typeof (r as { error?: { code?: unknown } }).error?.code === "string")) return r as LedgerResult<T>;
  } catch {
    // پرتاب پورت ⇒ خطای داخلی (گذرا)
  }
  return { ok: false, error: Object.freeze({ code: "INTERNAL_ERROR", message: "دفتر نتیجهٔ معتبر نداد." }) };
}

const MESSAGES: Readonly<Record<OutboxError["code"], string>> = {
  INVALID_INPUT: "ورودیِ ثبت تسویه نامعتبر است؛ دفتر تغییر نکرد.",
  NOT_FOUND: "رزرو در outbox تسویه ثبت نیست؛ مصرف یا بستن بدون ردّ ماندگار ممنوع است.",
  NOT_ACTIVE: "تسویهٔ این رزرو پیش‌تر نهایی شده است؛ دفتر تغییر نکرد.",
  CONFLICT: "قصدِ تسویهٔ دیگری برای این رزرو ثبت شده است؛ دفتر تغییر نکرد.",
  STORE_FAILURE: "ثبت ماندگارِ قصدِ تسویه ناموفق بود؛ دفتر تغییر نکرد.",
};
const LEDGER_CODE: Readonly<Record<OutboxError["code"], LedgerError["code"]>> = {
  INVALID_INPUT: "INVALID_INPUT",
  NOT_FOUND: "RESERVATION_NOT_FOUND",
  NOT_ACTIVE: "RESERVATION_CLOSED",
  CONFLICT: "IDEMPOTENCY_CONFLICT",
  STORE_FAILURE: "STORE_FAILURE",
};

/** خطای outbox را (بی‌پژواکِ پیام پورت) به خطای دفتر ترجمه می‌کند تا فراخواننده‌ای که فقط دفتر می‌شناسد (metering) درست رفتار کند. */
export function toLedgerError(e: OutboxError): { ok: false; error: LedgerError } {
  return { ok: false, error: Object.freeze({ code: LEDGER_CODE[e.code], message: MESSAGES[e.code] }) };
}

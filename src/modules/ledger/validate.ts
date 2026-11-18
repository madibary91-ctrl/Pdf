/**
 * ledger — اعتبارسنجی مرزی (ADR-0018 §۱۰). همه‌چیز سخت‌گیرانه و بی‌پرتاب؛ پیام‌ها ثابت‌اند و مقدارِ ورودی را بازتاب نمی‌دهند.
 */
import type { Command, CommandKind, GrantSource, LedgerError, LedgerResult } from "./types";

export const LIMITS = Object.freeze({
  MAX_ID_LENGTH: 128,
  MIN_TTL_MS: 1_000,
  MAX_TTL_MS: 86_400_000,
  MAX_OPEN_RESERVATIONS: 1_000,
  MAX_ATTEMPTS_PER_RESERVATION: 16,
  MAX_AMOUNT: Number.MAX_SAFE_INTEGER,
});

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const UNIT_RE = /^[A-Z][A-Z0-9_]{1,15}$/;
export const GRANT_SOURCES: readonly GrantSource[] = ["purchase", "promo", "adjustment"];

export function fail(code: LedgerError["code"], message: string): { ok: false; error: LedgerError } {
  return { ok: false, error: Object.freeze({ code, message }) };
}

type Field = "id" | "unit" | "amount1" | "amount0" | "ttl" | "source" | "remainder";

const SHAPES: Readonly<Record<CommandKind, Readonly<Record<string, Field>>>> = {
  open: { tenantId: "id", accountId: "id", unit: "unit" },
  grant: { tenantId: "id", accountId: "id", grantId: "id", unit: "unit", amount: "amount1", source: "source" },
  reserve: { tenantId: "id", accountId: "id", reservationId: "id", unit: "unit", amount: "amount1", ttlMs: "ttl" },
  charge: { tenantId: "id", accountId: "id", reservationId: "id", attemptId: "id", unit: "unit", amount: "amount0" },
  close: { tenantId: "id", accountId: "id", reservationId: "id", remainder: "remainder" },
  refund: { tenantId: "id", accountId: "id", refundId: "id", reservationId: "id", attemptId: "id", unit: "unit", amount: "amount1" },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null) return false;
  const proto = Object.getPrototypeOf(v) as unknown; // آرایه و نمونهٔ کلاس‌ها همین‌جا رد می‌شوند
  return proto === Object.prototype || proto === null;
}

function checkField(kind: Field, v: unknown): boolean {
  switch (kind) {
    case "id":
      return typeof v === "string" && ID_RE.test(v);
    case "unit":
      return typeof v === "string" && UNIT_RE.test(v);
    case "amount1":
      return typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
    case "amount0":
      return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
    case "ttl":
      return typeof v === "number" && Number.isSafeInteger(v) && v >= LIMITS.MIN_TTL_MS && v <= LIMITS.MAX_TTL_MS;
    case "source":
      return typeof v === "string" && (GRANT_SOURCES as readonly string[]).includes(v);
    case "remainder":
      return v === "release" || v === "forfeit";
  }
}

/** `raw` را (بدون `kind`) به فرمان معتبر و منجمد تبدیل می‌کند. `-0` به `0` نرمال می‌شود. */
export function parseCommand(kind: CommandKind, raw: unknown): LedgerResult<Command> {
  try {
    if (!isPlainObject(raw)) return fail("INVALID_INPUT", "ورودی باید یک شیء ساده باشد.");
    const shape = SHAPES[kind];
    const keys = Object.keys(raw);
    for (const k of keys) {
      if (!Object.hasOwn(shape, k)) return fail("INVALID_INPUT", `کلید ناشناخته: ${safeKey(k)}`);
    }
    const out: Record<string, unknown> = { kind };
    for (const [name, field] of Object.entries(shape)) {
      const v = raw[name];
      if (!checkField(field, v)) return fail("INVALID_INPUT", `فیلد «${name}» نامعتبر یا نبود.`);
      out[name] = typeof v === "number" && v === 0 ? 0 : v;
    }
    return { ok: true, value: Object.freeze(out) as unknown as Command };
  } catch {
    return fail("INVALID_INPUT", "خواندن ورودی ناموفق بود.");
  }
}

/** نام کلیدِ ناشناخته فقط اگر کوتاه و بی‌خطر باشد پژواک می‌شود (کلید ≠ دادهٔ کاربر، ولی لاگ را آلوده نکنیم). */
function safeKey(k: string): string {
  return /^[A-Za-z0-9_]{1,32}$/.test(k) ? k : "؟";
}

/** شناسهٔ حساب/مستأجر برای کلید ذخیره. */
export function parseKey(raw: unknown): LedgerResult<Readonly<{ tenantId: string; accountId: string }>> {
  try {
    if (!isPlainObject(raw)) return fail("INVALID_INPUT", "ورودی باید یک شیء ساده باشد.");
    for (const k of Object.keys(raw)) {
      if (k !== "tenantId" && k !== "accountId") return fail("INVALID_INPUT", `کلید ناشناخته: ${safeKey(k)}`);
    }
    const { tenantId, accountId } = raw;
    if (typeof tenantId !== "string" || !ID_RE.test(tenantId)) return fail("INVALID_INPUT", "فیلد «tenantId» نامعتبر یا نبود.");
    if (typeof accountId !== "string" || !ID_RE.test(accountId)) return fail("INVALID_INPUT", "فیلد «accountId» نامعتبر یا نبود.");
    return { ok: true, value: Object.freeze({ tenantId, accountId }) };
  } catch {
    return fail("INVALID_INPUT", "خواندن ورودی ناموفق بود.");
  }
}

/**
 * خواننده‌های سخت‌گیرِ مرزی برای ورودی `unknown` (داخلی).
 * قاعده: هر خطا یک مسئلهٔ دقیق با مسیر؛ مقدار جایگزین فقط برای ادامهٔ بررسی است و هرگز به خروجی نمی‌رسد.
 */
import { canonicalArticleLabel } from "./label";
import { isValidIsoDate } from "./dates";
import { addIssue, KB_LIMITS, type Ctx } from "./issues";
import type { IsoDate } from "./types";

export type Rec = Readonly<Record<string, unknown>>;

export function isPlainObject(v: unknown): v is Rec {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** نویسه‌های کنترلی، علامت‌های جهت‌دهی «Trojan Source» و BOM؛ (تب و خط‌جدید و RLM/LRM مجازند.) */
const FORBIDDEN_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\uFEFF]/;

export function record(ctx: Ctx, v: unknown, path: string, allowed: readonly string[]): Rec | null {
  if (!isPlainObject(v)) {
    addIssue(ctx, "INVALID_FIELD", path, "باید یک شیء (object) باشد.");
    return null;
  }
  for (const k of Object.keys(v)) {
    if (!allowed.includes(k)) addIssue(ctx, "UNKNOWN_FIELD", `${path}.${k}`, `کلید ناشناخته «${k}»؛ کلیدهای مجاز: ${allowed.join("، ")}.`);
  }
  return v;
}

function has(rec: Rec, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(rec, key) && rec[key] !== undefined;
}

export function readArray(ctx: Ctx, rec: Rec, key: string, path: string, max: number, required: boolean): readonly unknown[] {
  const p = `${path}.${key}`;
  if (!has(rec, key)) {
    if (required) addIssue(ctx, "MISSING_FIELD", p, "این کلید الزامی است.");
    return [];
  }
  const v = rec[key];
  if (!Array.isArray(v)) {
    addIssue(ctx, "INVALID_FIELD", p, "باید آرایه باشد.");
    return [];
  }
  if (v.length > max) {
    addIssue(ctx, "LIMIT_EXCEEDED", p, `حداکثر ${max} عضو مجاز است.`);
    return [];
  }
  // Array.from خانه‌های خالیِ آرایهٔ تُنُک (sparse) را به undefined تبدیل می‌کند تا خواندنِ عضو آن را مسئله کند؛
  // `.map` مستقیم روی آرایهٔ تُنُک خانه‌های خالی را بی‌صدا رد می‌کرد (باگی که تست فازی گرفت).
  return Array.from(v);
}

type TextOpts = Readonly<{ multiline?: boolean; max?: number }>;

function cleanText(ctx: Ctx, raw: unknown, p: string, opts: TextOpts): string | null {
  if (typeof raw !== "string") {
    addIssue(ctx, "INVALID_FIELD", p, "باید متن باشد.");
    return null;
  }
  const multiline = opts.multiline === true;
  const max = opts.max ?? (multiline ? KB_LIMITS.textChars : KB_LIMITS.lineChars);
  const s = (multiline ? raw.replace(/\r\n?/g, "\n") : raw).trim();
  if (s === "") {
    addIssue(ctx, "INVALID_FIELD", p, "نباید خالی باشد.");
    return null;
  }
  if (s.length > max) {
    addIssue(ctx, "LIMIT_EXCEEDED", p, `حداکثر ${max} نویسه مجاز است.`);
    return null;
  }
  if (FORBIDDEN_CHARS.test(s)) {
    addIssue(ctx, "INVALID_FIELD", p, "نویسهٔ کنترلی یا علامت جهت‌دهی ممنوع دارد.");
    return null;
  }
  if (!multiline && s.indexOf("\n") >= 0) {
    addIssue(ctx, "INVALID_FIELD", p, "باید تک‌خطی باشد.");
    return null;
  }
  return s;
}

export function reqText(ctx: Ctx, rec: Rec, key: string, path: string, opts: TextOpts = {}): string {
  const p = `${path}.${key}`;
  if (!has(rec, key)) {
    addIssue(ctx, "MISSING_FIELD", p, "این کلید الزامی است.");
    return "";
  }
  return cleanText(ctx, rec[key], p, opts) ?? "";
}

/** اختیاری: غایب یا `null` ⇒ `null`. */
export function optText(ctx: Ctx, rec: Rec, key: string, path: string, opts: TextOpts = {}): string | null {
  if (!has(rec, key) || rec[key] === null) return null;
  return cleanText(ctx, rec[key], `${path}.${key}`, opts);
}

export function reqEnum<T extends string>(ctx: Ctx, rec: Rec, key: string, path: string, list: readonly T[], fallback: T): T {
  const p = `${path}.${key}`;
  if (!has(rec, key)) {
    addIssue(ctx, "MISSING_FIELD", p, "این کلید الزامی است.");
    return fallback;
  }
  const v = rec[key];
  if (typeof v === "string" && (list as readonly string[]).includes(v)) return v as T;
  addIssue(ctx, "INVALID_FIELD", p, `مقدار باید یکی از این‌ها باشد: ${list.join("، ")}.`);
  return fallback;
}

function readDateValue(ctx: Ctx, v: unknown, p: string): IsoDate | null {
  if (isValidIsoDate(v)) return v;
  addIssue(ctx, "INVALID_FIELD", p, "تاریخ باید میلادی و با قالب YYYY-MM-DD (و واقعاً موجود در تقویم) باشد.");
  return null;
}

export function reqDate(ctx: Ctx, rec: Rec, key: string, path: string): IsoDate {
  const p = `${path}.${key}`;
  if (!has(rec, key)) {
    addIssue(ctx, "MISSING_FIELD", p, "این کلید الزامی است.");
    return "1900-01-01";
  }
  return readDateValue(ctx, rec[key], p) ?? "1900-01-01";
}

/** کلید باید **صریحاً** بیاید؛ مقدار `null` مجاز است (برای جلوگیری از «فراموشی بی‌صدا»). */
export function explicitNullableDate(ctx: Ctx, rec: Rec, key: string, path: string): IsoDate | null {
  const p = `${path}.${key}`;
  if (!has(rec, key)) {
    addIssue(ctx, "MISSING_FIELD", p, "این کلید الزامی است؛ اگر ناشناخته یا بی‌پایان است صریحاً null بگذارید.");
    return null;
  }
  if (rec[key] === null) return null;
  return readDateValue(ctx, rec[key], p);
}

export function optDate(ctx: Ctx, rec: Rec, key: string, path: string): IsoDate | null {
  if (!has(rec, key) || rec[key] === null) return null;
  return readDateValue(ctx, rec[key], `${path}.${key}`);
}

export function optUrl(ctx: Ctx, rec: Rec, key: string, path: string): string | null {
  if (!has(rec, key) || rec[key] === null) return null;
  const p = `${path}.${key}`;
  const v = rec[key];
  if (typeof v !== "string" || v.length > KB_LIMITS.urlChars || !/^https?:\/\/[^\s<>"']+$/i.test(v)) {
    addIssue(ctx, "INVALID_FIELD", p, "نشانی باید با http:// یا https:// شروع شود، بدون فاصله باشد و حداکثر ۲۰۴۸ نویسه.");
    return null;
  }
  return v;
}

/** برچسب ماده را به شکل متعارف درمی‌آورد؛ خطا ⇒ مسئله. */
export function articleLabelValue(ctx: Ctx, v: unknown, p: string): string {
  if (typeof v !== "string") {
    addIssue(ctx, "INVALID_FIELD", p, "برچسب ماده باید متن باشد.");
    return "";
  }
  const r = canonicalArticleLabel(v);
  if (!r.ok) {
    addIssue(ctx, "INVALID_FIELD", p, r.error.message);
    return "";
  }
  return r.value;
}

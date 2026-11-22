/**
 * زیرمجموعهٔ کوچکِ JSON Schema که هم «توصیف ابزار برای مدل» است و هم «قاعدهٔ اعتبارسنجی آرگومان».
 * یک منبعِ حقیقت: توصیفی که مدل می‌بیند عیناً همان چیزی است که در مرز اجرا می‌شود (آزمونِ توافق).
 *
 * سخت‌گیری عمدی: کلیدِ ناشناخته رد می‌شود، رشته به عدد تبدیل نمی‌شود، رقم فارسی حدس زده نمی‌شود (قاعدهٔ ۹ AGENTS.md).
 * هیچ عددِ حقوقی در این فایل نیست؛ حدّها فقط «ساختاری/فنی»اند و تصمیمِ حقوقی (مثلاً مثبت‌بودنِ اصل دین) با legal-calc است.
 */
import { err, ok, type DomainError, type Result } from "@/modules/shared-types";

export type SchemaObject = Readonly<{
  type: "object";
  description?: string;
  properties: Readonly<Record<string, Schema>>;
  required: readonly string[];
  additionalProperties: false;
}>;
export type SchemaInteger = Readonly<{ type: "integer"; description?: string; minimum: number; maximum: number }>;
export type SchemaString = Readonly<{
  type: "string";
  description?: string;
  enum?: readonly string[];
  maxLength?: number;
}>;
export type Schema = SchemaObject | SchemaInteger | SchemaString;

/** بیشینهٔ ژرفای تو‌در‌تویی که اعتبارسنج می‌پیماید (محافظ فنی؛ شماهای ما خیلی کم‌عمق‌اند). */
const MAX_SCHEMA_DEPTH = 8;
/** بیشینهٔ تعدادِ مشکلی که گزارش می‌شود تا پیامِ خطا بی‌کران نشود. */
const MAX_ISSUES = 10;

/** رشته‌ای که سقفِ طول ندارد هم سقفِ فنی دارد. */
export const DEFAULT_MAX_STRING_LENGTH = 200;

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function describeKind(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "آرایه";
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "NaN";
    if (!Number.isFinite(v)) return "بی‌نهایت";
    return Number.isInteger(v) ? "عدد صحیح" : "عدد اعشاری";
  }
  if (typeof v === "string") return "رشته";
  if (typeof v === "boolean") return "بولی";
  if (typeof v === "undefined") return "تهی (undefined)";
  return typeof v === "object" ? "شیء غیرساده" : typeof v;
}

/** بیشینهٔ نویسه‌ای از نامِ کلیدِ ورودی که در پیام می‌آید (کلیدها را مدل/مهاجم تعیین می‌کند). */
const MAX_KEY_SHOWN = 40;
const shown = (key: string): string => (key.length > MAX_KEY_SHOWN ? `${key.slice(0, MAX_KEY_SHOWN)}…` : key);
const at = (path: string): string => (path === "" ? "آرگومان‌ها" : `«${path}»`);
const join = (path: string, key: string): string => (path === "" ? shown(key) : `${path}.${shown(key)}`);
/** افزودنِ مشکل با سقف: پیامِ خطا هرگز بی‌کران نمی‌شود، حتی با هزاران کلیدِ اضافه. */
const report = (issues: string[], message: string): void => {
  if (issues.length < MAX_ISSUES) issues.push(message);
};

function walk(schema: Schema, value: unknown, path: string, depth: number, issues: string[]): void {
  if (issues.length >= MAX_ISSUES) return;
  if (depth > MAX_SCHEMA_DEPTH) {
    report(issues, `${at(path)} بیش از حد تو‌در‌تو است.`);
    return;
  }
  switch (schema.type) {
    case "integer": {
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        report(issues, `${at(path)} باید عدد صحیحِ لاتین (نه رشته/اعشار) باشد؛ دریافت‌شده: ${describeKind(value)}.`);
      } else if (value < schema.minimum || value > schema.maximum) {
        report(issues, `${at(path)} باید بین ${schema.minimum} و ${schema.maximum} باشد.`);
      }
      return;
    }
    case "string": {
      if (typeof value !== "string") {
        report(issues, `${at(path)} باید رشته باشد؛ دریافت‌شده: ${describeKind(value)}.`);
      } else if (schema.enum !== undefined) {
        if (!schema.enum.includes(value)) report(issues, `${at(path)} باید یکی از این مقدارها باشد: ${schema.enum.join("، ")}.`);
      } else if (value.length === 0 || value.length > (schema.maxLength ?? DEFAULT_MAX_STRING_LENGTH)) {
        report(issues, `${at(path)} باید رشتهٔ ناتهی و حداکثر ${schema.maxLength ?? DEFAULT_MAX_STRING_LENGTH} نویسه باشد.`);
      }
      return;
    }
    case "object": {
      if (!isPlainRecord(value)) {
        report(issues, `${at(path)} باید شیء ساده باشد؛ دریافت‌شده: ${describeKind(value)}.`);
        return;
      }
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties, key)) report(issues, `کلیدِ ناشناختهٔ «${join(path, key)}» مجاز نیست.`);
      }
      for (const key of schema.required) {
        if (!Object.hasOwn(value, key) || value[key] === undefined) report(issues, `«${join(path, key)}» الزامی است.`);
      }
      for (const key of Object.keys(schema.properties)) {
        if (!Object.hasOwn(value, key) || value[key] === undefined) continue;
        const child = schema.properties[key];
        if (child !== undefined) walk(child, value[key], join(path, key), depth + 1, issues);
      }
      return;
    }
  }
}

/**
 * آرگومان‌های نامطمئنِ مدل را با شما می‌سنجد. هرگز نمی‌پرتابد (حتی با Proxy/getterِ بدجنس) و همهٔ مشکل‌ها (تا سقف) را یک‌جا می‌گوید
 * تا مدل بتواند در یک تلاش اصلاح کند. نتیجهٔ موفق همان مقدارِ ورودی است (بی‌تبدیل)، فقط «تأییدشده».
 */
export function validateAgainstSchema(schema: Schema, value: unknown): Result<Record<string, unknown>, DomainError> {
  const issues: string[] = [];
  try {
    walk(schema, value, "", 0, issues);
  } catch {
    return err("INVALID_INPUT", "آرگومان‌ها قابل‌خواندن نیستند (شیء نامعتبر).");
  }
  if (issues.length > 0) return err("INVALID_INPUT", issues.join(" "));
  return ok(value as Record<string, unknown>);
}

/** یخ‌زدنِ ژرف تا ارکستراتور نتواند توصیفِ ابزار را (حتی تصادفی) تغییر دهد. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

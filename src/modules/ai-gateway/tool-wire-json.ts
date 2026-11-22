/**
 * ابزارهای مشترکِ سنجشِ رمزگذارِ ابزار: JSONِ امن، نویسه‌های ممنوع، و ساختنِ خطا با پیامِ کران‌دار.
 * همهٔ ورودی‌ها (توصیفِ ابزار از کد، پاسخِ ارائه‌دهنده از شبکه) `unknown` فرض می‌شوند.
 */
import type { ToolWireError, ToolWireErrorCode, ToolWireUsage } from "./tool-wire-types";
import { parseUsage } from "./pricing";

export const MAX_ISSUES = 10;
export const MAX_KEY_SHOWN = 40;
/** بیشینهٔ ژرفا و تعدادِ گرهٔ JSONِ قابل‌قبول (محافظِ فنی در برابر پاسخ/توصیفِ عظیم). */
export const MAX_JSON_DEPTH = 16;
export const MAX_JSON_NODES = 5000;

export const isPlainRecord = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
};

export const shown = (s: string): string => (s.length > MAX_KEY_SHOWN ? `${s.slice(0, MAX_KEY_SHOWN)}…` : s);

/** افزودنِ مشکل با سقف؛ پیام هرگز بی‌کران نمی‌شود. */
export function report(issues: string[], message: string): void {
  if (issues.length < MAX_ISSUES) issues.push(message);
}

export function fail(code: ToolWireErrorCode, message: string, issues: readonly string[], usage: ToolWireUsage | null = null): { ok: false; error: ToolWireError } {
  return { ok: false, error: Object.freeze({ code, message, issues: Object.freeze(issues.slice(0, MAX_ISSUES)), usage }) };
}

/** NUL یا جفت‌جانشینِ تنهای Unicode (ارائه‌دهنده‌ها این‌ها را با ۴۰۰ رد می‌کنند). */
export function hasForbiddenChars(s: string): boolean {
  if (s.includes("\u0000")) return true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (n >= 0xdc00 && n <= 0xdfff) i++;
      else return true;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

/**
 * آیا `v` یک مقدارِ JSONِ بی‌ابهام است؟ (null، بولی، عددِ متناهی، رشتهٔ سالم، آرایه، شیءِ ساده.)
 * `undefined`، تابع، symbol، bigint، NaN/∞، شیءِ غیرساده، چرخه و ژرفا/اندازهٔ بیش‌ازحد ⇒ خطا؛ هرگز «null»ِ بی‌صدا نمی‌شود.
 * کلیدِ `__proto__` رد می‌شود. `showKeys=false` (برای دادهٔ مدل) نامِ کلیدها را در مسیرِ گزارش نمی‌آورد. ممکن است در برخورد با getter/Proxyِ بدجنس پرتاب کند؛ فراخواننده try/catch دارد.
 */
export function checkJson(v: unknown, path: string, issues: string[], showKeys = true): void {
  let nodes = 0;
  const seen = new Set<object>();
  const walk = (x: unknown, p: string, depth: number): void => {
    if (issues.length >= MAX_ISSUES) return;
    if (++nodes > MAX_JSON_NODES) {
      report(issues, `${p}: بیش از ${MAX_JSON_NODES} گره.`);
      return;
    }
    if (depth > MAX_JSON_DEPTH) {
      report(issues, `${p}: بیش از ${MAX_JSON_DEPTH} سطح تو‌در‌تو.`);
      return;
    }
    if (x === null || typeof x === "boolean") return;
    if (typeof x === "number") {
      if (!Number.isFinite(x)) report(issues, `${p}: عدد باید متناهی باشد.`);
      return;
    }
    if (typeof x === "string") {
      if (hasForbiddenChars(x)) report(issues, `${p}: متن شامل NUL یا جفت‌جانشینِ تنها است.`);
      return;
    }
    if (typeof x !== "object") {
      report(issues, `${p}: مقدار JSON نیست.`);
      return;
    }
    if (seen.has(x)) {
      report(issues, `${p}: ارجاعِ چرخه‌ای.`);
      return;
    }
    seen.add(x);
    if (Array.isArray(x)) {
      for (let i = 0; i < x.length; i++) walk(x[i], `${p}[${i}]`, depth + 1);
    } else if (isPlainRecord(x)) {
      for (const k of Object.keys(x)) {
        if (k === "__proto__") report(issues, `${p}: کلیدِ ممنوع.`);
        else walk(x[k], `${p}.${showKeys ? shown(k) : "…"}`, depth + 1);
      }
    } else report(issues, `${p}: شیءِ غیرساده.`);
    seen.delete(x);
  };
  walk(v, path, 0);
}

/** نسخهٔ ژرفِ یخ‌زده از JSONِ سنجیده‌شده (پس از `checkJson`). */
export function freezeClone<T>(v: T): T {
  if (typeof v !== "object" || v === null) return v;
  if (Array.isArray(v)) return Object.freeze(v.map((x) => freezeClone(x as unknown))) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v)) out[k] = freezeClone((v as Record<string, unknown>)[k]);
  return Object.freeze(out) as T;
}

/**
 * مصرفِ سخت‌گیرانه از دو عددِ خام با همان قاعدهٔ `parseUsage`ِ دروازه (صحیح ۰…۱۰⁹)؛ نامعتبر ⇒ `null` (ناشناخته، نه صفر).
 */
export function strictUsage(input: unknown, output: unknown): ToolWireUsage | null {
  const u = parseUsage({ inputTokens: input, outputTokens: output });
  return u === null ? null : { inputTokens: u.inputTokens, outputTokens: u.outputTokens };
}

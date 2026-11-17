/**
 * ممیزی عدد (خالص): عددهای پاسخ که در متن منابع یا پرسش نیستند. فقط هشدار است (ADR-0016 §۱۰).
 * نمی‌بیند: عددِ حروفی («بیست روز»)، عددِ درست در جایگاه نادرست، و حساب‌وکتاب (مثلاً ۲×۱۰).
 */
import { markerCandidate } from "./markers";

const DIGITS_FA = "\u06F0\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6\u06F7\u06F8\u06F9";
const DIGITS_AR = "\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669";

function toLatinDigits(s: string): string {
  let out = "";
  for (const ch of s) {
    const fa = DIGITS_FA.indexOf(ch);
    if (fa >= 0) out += String(fa);
    else {
      const ar = DIGITS_AR.indexOf(ch);
      out += ar >= 0 ? String(ar) : ch;
    }
  }
  return out;
}

/** عددهای یکتای متن به ترتیب ظهور، با ارقام لاتین (علامت حذفِ `REDACTION_MARK` رقم ندارد و آزموده می‌شود)؛ نشانه‌های ارجاع، شمارندهٔ سرِ خط و جداکنندهٔ هزارگان کنار گذاشته می‌شوند. */
export function extractNumbers(text: string): string[] {
  let t = text.replace(markerCandidate(), " ");
  t = toLatinDigits(t).replace(/\u066B/g, ".");
  t = t.replace(/^[ \t]*[0-9]{1,2}[.)\-:][ \t]/gm, " ");
  t = t.replace(/([0-9])[,\u066C](?=[0-9]{3}(?![0-9]))/g, "$1");
  return [...new Set(t.match(/[0-9]+(?:\.[0-9]+)?/g) ?? [])];
}

/** عددهای `answer` که در هیچ‌یک از `allowedTexts` نیستند. */
export function auditNumbers(answer: string, allowedTexts: readonly string[]): string[] {
  const allowed = new Set<string>();
  for (const t of allowedTexts) for (const n of extractNumbers(t)) allowed.add(n);
  return extractNumbers(answer).filter((n) => !allowed.has(n));
}

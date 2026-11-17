/**
 * برچسب ماده، برچسب تبصره/بند، شناسهٔ سند و کلید ارجاع — نرمال‌سازی و قالب متعارف.
 *
 * چرا نرمال‌سازی خودش را دارد؟ registry این ماژول را فقط به shared-types وابسته کرده (persian-text مجاز نیست)؛
 * نیاز اینجا کوچک و بسته است (ارقام، ی/ک، نیم‌فاصله) و تست‌های جداگانه دارد.
 *
 * شکل‌های ماده که می‌پذیریم (همه‌چیز دیگر = خطای صریح، نه حدس):
 *   `10` · `10 مکرر` · `10 مکرر 2` · `واحده` ،  با پیشوند اختیاری «ماده»/«اصل» و ارقام فارسی/عربی/لاتین.
 * «مکرر ۲» یک امکان فنی است (شمارندهٔ دوم)؛ وجودش در قانون واقعی یکی از پرسش‌های باز برای حقوقدان است (ADR-0003).
 */
import { err, ok, type Result } from "@/modules/shared-types";
import type { CitationRef, SubpartKind } from "./types";
import { SUBPART_KINDS } from "./types";

export type ArticleLabel =
  | Readonly<{ kind: "numbered"; number: number; /** ۰ = بدون «مکرر»، ۱ = «مکرر»، n≥۲ = «مکرر n» */ repeat: number }>
  | Readonly<{ kind: "single" }>;

export const MAX_ARTICLE_NUMBER = 99999;
export const MAX_REPEAT = 99;
const REPEAT_WORD = "مکرر";

const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";

/** ارقام فارسی/عربی → لاتین، ی/ک عربی → فارسی، حذف کشیده و نویسه‌های نامرئی، نیم‌فاصله و فاصله‌های خاص → فاصلهٔ ساده. */
export function normalizeLabelText(input: string): string {
  let out = "";
  for (const ch of input) {
    const p = PERSIAN_DIGITS.indexOf(ch);
    if (p >= 0) out += String(p);
    else {
      const a = ARABIC_DIGITS.indexOf(ch);
      if (a >= 0) out += String(a);
      else if (ch === "ي" || ch === "ى") out += "ی";
      else if (ch === "ك") out += "ک";
      else if (ch === "\u0640" || ch === "\u200E" || ch === "\u200F" || ch === "\u200B" || ch === "\uFEFF") out += "";
      else if (/\s/.test(ch) || ch === "\u200C" || ch === "\u00A0") out += " ";
      else out += ch;
    }
  }
  return out.replace(/ +/g, " ").trim();
}

const ARTICLE_RE = new RegExp(`^(?:(?:ماده|اصل) )?(?:(\\d{1,5})(?: ${REPEAT_WORD}(?: (\\d{1,2}))?)?|واحده)$`);

export function parseArticleLabel(input: string): Result<ArticleLabel> {
  if (typeof input !== "string") return err("INVALID_INPUT", "برچسب ماده باید متن باشد.");
  const s = normalizeLabelText(input);
  if (s === "") return err("INVALID_INPUT", "برچسب ماده خالی است.");
  const m = ARTICLE_RE.exec(s);
  if (!m) {
    return err("INVALID_INPUT", `برچسب ماده «${input}» شناخته نشد؛ شکل‌های پذیرفته: «۱۰»، «۱۰ مکرر»، «۱۰ مکرر ۲»، «واحده».`);
  }
  if (m[1] === undefined) return ok({ kind: "single" });
  const number = Number(m[1]);
  if (number < 1 || number > MAX_ARTICLE_NUMBER) {
    return err("OUT_OF_RANGE", `شمارهٔ ماده باید از ۱ تا ${MAX_ARTICLE_NUMBER} باشد.`);
  }
  const hasRepeat = s.includes(` ${REPEAT_WORD}`);
  let repeat = 0;
  if (hasRepeat) {
    if (m[2] === undefined) repeat = 1;
    else {
      repeat = Number(m[2]);
      // «مکرر ۱» با «مکرر» یکی است و دو شکل برای یک چیز نمی‌پذیریم؛ «مکرر ۰» بی‌معنی است.
      if (repeat < 2 || repeat > MAX_REPEAT) return err("OUT_OF_RANGE", `شمارندهٔ «مکرر» باید از ۲ تا ${MAX_REPEAT} باشد (برای حالت اول فقط «مکرر» بنویسید).`);
    }
  }
  return ok({ kind: "numbered", number, repeat });
}

/** شکل متعارف برای ذخیره و مقایسه: `10`، `10 مکرر`، `10 مکرر 2`، `واحده`. */
export function formatArticleLabel(label: ArticleLabel): string {
  if (label.kind === "single") return "واحده";
  if (label.repeat === 0) return String(label.number);
  if (label.repeat === 1) return `${label.number} ${REPEAT_WORD}`;
  return `${label.number} ${REPEAT_WORD} ${label.repeat}`;
}

export function canonicalArticleLabel(input: string): Result<string> {
  const r = parseArticleLabel(input);
  return r.ok ? ok(formatArticleLabel(r.value)) : r;
}

/** ترتیب طبیعی: «واحده» پیش از همه؛ سپس شماره؛ سپس بدون‌مکرر < مکرر < مکرر ۲ … */
export function compareArticleLabels(a: ArticleLabel, b: ArticleLabel): number {
  if (a.kind === "single") return b.kind === "single" ? 0 : -1;
  if (b.kind === "single") return 1;
  return a.number - b.number || a.repeat - b.repeat;
}

/** کلید ASCII برای ذخیره/نشانی: `10`، `10-bis`، `10-bis-2`، `single`. */
export function articleKey(label: ArticleLabel): string {
  if (label.kind === "single") return "single";
  if (label.repeat === 0) return String(label.number);
  if (label.repeat === 1) return `${label.number}-bis`;
  return `${label.number}-bis-${label.repeat}`;
}

export function parseArticleKey(key: string): Result<ArticleLabel> {
  if (typeof key !== "string") return err("INVALID_INPUT", "کلید ماده باید متن باشد.");
  if (key === "single") return ok({ kind: "single" });
  const m = /^(\d{1,5})(?:-bis(?:-(\d{1,2}))?)?$/.exec(key);
  if (!m) return err("INVALID_INPUT", `کلید ماده «${key}» معتبر نیست.`);
  const number = Number(m[1]);
  if (number < 1 || number > MAX_ARTICLE_NUMBER) return err("OUT_OF_RANGE", "شمارهٔ ماده خارج از حد است.");
  const repeat = key.indexOf("-bis") < 0 ? 0 : m[2] === undefined ? 1 : Number(m[2]);
  if (repeat > MAX_REPEAT || (m[2] !== undefined && repeat < 2)) return err("OUT_OF_RANGE", "شمارندهٔ «مکرر» خارج از حد است.");
  // قالب متعارف: بدون صفر پیشرو (`07` رد می‌شود تا یک ماده دو کلید نداشته باشد)
  if (articleKey({ kind: "numbered", number, repeat }) !== key) return err("INVALID_INPUT", `کلید ماده «${key}» متعارف نیست.`);
  return ok({ kind: "numbered", number, repeat });
}

// ───────────── تبصره / بند ─────────────

/** حروف مجاز برچسب بند (الف، ب، پ، ت …). عمداً فهرست صریح، نه بازه (بازهٔ یونیکد ارقام عربی را هم می‌گیرد). */
const LABEL_LETTERS = "آابپتثجچحخدذرزژسشصضطظعغفقکگلمنوهی";
const SUBPART_LABEL_RE = new RegExp(`^(?:\\d{1,3}|[${LABEL_LETTERS}]{1,6})$`);

export function canonicalSubpartLabel(input: string): Result<string> {
  if (typeof input !== "string") return err("INVALID_INPUT", "برچسب تبصره/بند باید متن باشد.");
  const s = normalizeLabelText(input);
  if (!SUBPART_LABEL_RE.test(s)) {
    return err("INVALID_INPUT", `برچسب تبصره/بند «${input}» شناخته نشد؛ فقط عدد (حداکثر ۳ رقم) یا حروف فارسی (مثل «الف»).`);
  }
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (n < 1) return err("OUT_OF_RANGE", "شمارهٔ تبصره/بند باید از ۱ باشد.");
    return ok(String(n)); // «۰۲» → «2»
  }
  return ok(s);
}

// ───────────── شناسهٔ سند ─────────────

export const MAX_DOCUMENT_ID_LENGTH = 64;
const DOC_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidDocumentId(id: unknown): id is string {
  return typeof id === "string" && id.length <= MAX_DOCUMENT_ID_LENGTH && DOC_ID_RE.test(id);
}

/** شناسهٔ رکوردهای دیگر (رأی) با همان قاعدهٔ شناسهٔ سند. */
export const isValidRecordId = isValidDocumentId;

// ───────────── کلید ارجاع ─────────────

/**
 * کلید ارجاع (پایدار، ASCII به‌جز برچسب حروفی بند):
 *   `sample-law/10-bis` یا `sample-law/10/note/2` یا `sample-law/10/clause/الف`.
 */
export function formatCitationKey(ref: CitationRef): Result<string> {
  if (!isValidDocumentId(ref.documentId)) return err("INVALID_INPUT", "شناسهٔ سند نامعتبر است.");
  const label = parseArticleLabel(ref.article);
  if (!label.ok) return label;
  const base = `${ref.documentId}/${articleKey(label.value)}`;
  if (ref.subpart === null) return ok(base);
  if (!SUBPART_KINDS.includes(ref.subpart.kind)) return err("INVALID_INPUT", "نوع تبصره/بند نامعتبر است.");
  const sub = canonicalSubpartLabel(ref.subpart.label);
  if (!sub.ok) return sub;
  return ok(`${base}/${ref.subpart.kind}/${sub.value}`);
}

export function parseCitationKey(key: string): Result<CitationRef> {
  if (typeof key !== "string") return err("PARSE_ERROR", "کلید ارجاع باید متن باشد.");
  const parts = key.split("/");
  if (parts.length !== 2 && parts.length !== 4) return err("PARSE_ERROR", "کلید ارجاع باید «سند/ماده» یا «سند/ماده/نوع/برچسب» باشد.");
  const [documentId, articlePart, kindPart, labelPart] = parts as [string, string, string | undefined, string | undefined];
  if (!isValidDocumentId(documentId)) return err("PARSE_ERROR", "شناسهٔ سند در کلید نامعتبر است.");
  const label = parseArticleKey(articlePart);
  if (!label.ok) return err("PARSE_ERROR", label.error.message);
  const article = formatArticleLabel(label.value);
  if (kindPart === undefined || labelPart === undefined) return ok({ documentId, article, subpart: null });
  if (kindPart !== "note" && kindPart !== "clause") return err("PARSE_ERROR", "نوع بخش در کلید باید note یا clause باشد.");
  const sub = canonicalSubpartLabel(labelPart);
  // برچسب باید همان شکل متعارف باشد (کلید یکتا)
  if (!sub.ok || sub.value !== labelPart) return err("PARSE_ERROR", "برچسب بخش در کلید متعارف نیست.");
  return ok({ documentId, article, subpart: { kind: kindPart as SubpartKind, label: sub.value } });
}

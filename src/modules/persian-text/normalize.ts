import { toLatinDigits, toPersianDigits } from "./digits";

/**
 * نرمال‌سازی متن فارسی — کاملاً خالص و قطعی.
 * سه «پروفایل» آمادهٔ مصرف در انتهای فایل هست؛ تابع پایه برای کنترل دقیق‌تر.
 *
 * نکتهٔ طراحی: regexها عمداً با `new RegExp(string)` ساخته شده‌اند تا
 * به هدف کامپایل (ES2017) گیر ندهند، و از lookbehind پرهیز شده تا در مرورگرهای قدیمی‌تر هم کار کند.
 */

/** حروف فارسی/عربیِ مورد نیاز برای قواعد نیم‌فاصله و نشانه‌گذاری (بدون ارقام). */
const L = "\\u0621-\\u063A\\u0641-\\u064A\\u067E\\u0686\\u0698\\u06A9\\u06AF\\u06CC\\u06C0";
export const ZWNJ = "\u200C";

export type NormalizeOptions = Readonly<{
  /** ارقام: keep (پیش‌فرض) | persian | latin */
  digits?: "keep" | "persian" | "latin";
  /** حذف اعراب (فتحه، کسره، تشدید، …) */
  removeDiacritics?: boolean;
  /** چسباندن «می‌/نمی‌» و «ها/های/تر/ترین» با نیم‌فاصله */
  fixHalfSpace?: boolean;
  /** `? , ;` ← `؟ ، ؛` وقتی بعد از حرف فارسی می‌آیند */
  localizePunctuation?: boolean;
  /** حذف فاصلهٔ پیش از نشانه‌ها و افزودن فاصله پس از آن‌ها */
  fixPunctuationSpacing?: boolean;
  /** یکی‌کردن همزه‌ها و ریختن «ۀ ة ؤ ئ» به ه/و/ی (فقط برای کلید جست‌وجو) */
  foldHamza?: boolean;
}>;

// ---------- مرحلهٔ ۱: نویسه‌ها ----------

const PRESENTATION_FORMS = /[\uFB50-\uFDFF\uFE70-\uFEFE]/g;

/** نگاشت یک‌به‌یکِ نویسه‌های عربی/متفرقه به فارسی استاندارد. */
const CHAR_MAP: Readonly<Record<string, string>> = {
  "\u064A": "\u06CC", // ي → ی
  "\u0649": "\u06CC", // ى → ی
  "\u06D0": "\u06CC", // ې → ی
  "\u0643": "\u06A9", // ك → ک
  "\u06AA": "\u06A9", // ڪ → ک
  "\u06BE": "\u0647", // ھ → ه
  "\u06C1": "\u0647", // ہ → ه
  "\u06D5": "\u0647", // ە → ه
};
const CHAR_MAP_RE = new RegExp(`[${Object.keys(CHAR_MAP).join("")}]`, "g");

const HAMZA_FOLD: Readonly<Record<string, string>> = {
  "\u0623": "\u0627", // أ → ا
  "\u0625": "\u0627", // إ → ا
  "\u0671": "\u0627", // ٱ → ا
  "\u0622": "\u0627", // آ → ا
  "\u06C0": "\u0647", // ۀ → ه
  "\u0629": "\u0647", // ة → ه
  "\u0624": "\u0648", // ؤ → و
  "\u0626": "\u06CC", // ئ → ی
};
const HAMZA_FOLD_RE = new RegExp(`[${Object.keys(HAMZA_FOLD).join("")}]`, "g");

const TATWEEL = /\u0640/g;
const DIACRITICS = /[\u064B-\u065F\u0670]/g;
// نشانه‌های جهت و فاصلهٔ نامرئیِ بی‌اثر (به‌جز نیم‌فاصله): ZWSP، ZWJ، LRM/RLM، embedding/isolate، BOM، soft hyphen
const INVISIBLES = /[\u00AD\u200B\u200D\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

// ---------- مرحلهٔ ۲: فاصله‌ها ----------

const EXOTIC_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\t\v\f]/g;

function normalizeWhitespace(text: string): string {
  let s = text.replace(/\r\n?|\u2028|\u2029/g, "\n").replace(EXOTIC_SPACES, " ");
  s = s.replace(new RegExp(`${ZWNJ}{2,}`, "g"), ZWNJ); // نیم‌فاصلهٔ تکراری
  s = s.replace(new RegExp(`${ZWNJ}+(?=[ \\n]|$)`, "g"), ""); // نیم‌فاصله پیش از فاصله/پایان
  s = s.replace(new RegExp(`(^|[ \\n])${ZWNJ}+`, "g"), "$1"); // نیم‌فاصله پس از فاصله/آغاز
  s = s.replace(/ {2,}/g, " ");
  s = s.replace(/ ?\n ?/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

// ---------- مرحلهٔ ۳: نیم‌فاصله ----------

const MI_PREFIX = new RegExp(`(^|[^${L}])(ن?می) (?=[${L}]{2})`, "g");
const SUFFIXES = new RegExp(`([${L}]) (هایی|های|ها|ترین|تر)(?![${L}])`, "g");

function fixHalfSpaces(s: string): string {
  return s.replace(MI_PREFIX, `$1$2${ZWNJ}`).replace(SUFFIXES, `$1${ZWNJ}$2`);
}

// ---------- مرحلهٔ ۴: نشانه‌گذاری ----------

function localizePunctuation(s: string): string {
  return s
    .replace(new RegExp(`([${L}]\\s*)\\?`, "g"), "$1\u061F")
    .replace(new RegExp(`([${L}])(\\s*),`, "g"), "$1$2\u060C")
    .replace(new RegExp(`([${L}])(\\s*);`, "g"), "$1$2\u061B");
}

function fixPunctuationSpacing(s: string): string {
  return s
    .replace(/ +([\u060C\u061B\u061F!:.)»])/g, "$1") // فاصله پیش از نشانه
    .replace(/([(«]) +/g, "$1") // فاصله پس از پرانتز/گیومهٔ بازشونده
    .replace(new RegExp(`([\\u060C\\u061B\\u061F!:])(?=[${L}])`, "g"), "$1 "); // فاصله پس از نشانه
}

/** تبدیل شکل‌های ارائه (ﻛ ﻳ ﻻ …) به حروف پایه. */
function foldPresentationForms(s: string): string {
  return s.replace(PRESENTATION_FORMS, (c) => c.normalize("NFKC"));
}

export function normalizePersianText(text: string, options: NormalizeOptions = {}): string {
  const { digits = "keep", removeDiacritics = false } = options;
  let s = foldPresentationForms(String(text));
  s = s.replace(CHAR_MAP_RE, (c) => CHAR_MAP[c] ?? c);
  s = s.replace(TATWEEL, "").replace(INVISIBLES, "");
  if (removeDiacritics) s = s.replace(DIACRITICS, "");
  if (options.foldHamza) s = s.replace(HAMZA_FOLD_RE, (c) => HAMZA_FOLD[c] ?? c);
  if (digits === "persian") s = toPersianDigits(s);
  else if (digits === "latin") s = toLatinDigits(s);
  s = normalizeWhitespace(s);
  if (options.fixHalfSpace) s = fixHalfSpaces(s);
  if (options.localizePunctuation) s = localizePunctuation(s);
  if (options.fixPunctuationSpacing) s = fixPunctuationSpacing(s);
  return s;
}

/**
 * ذخیره در پایگاه داده: محافظه‌کارانه. معنی و ارقام متن را عوض نمی‌کند؛
 * فقط نویسه‌ها و فاصله‌ها را استاندارد می‌کند.
 */
export function normalizeForStorage(text: string): string {
  return normalizePersianText(text);
}

/** نمایش به کاربر: نویسه‌ها استاندارد، نیم‌فاصله و نشانه‌گذاری اصلاح، ارقام فارسی. */
export function normalizeForDisplay(text: string): string {
  return normalizePersianText(text, {
    digits: "persian",
    fixHalfSpace: true,
    localizePunctuation: true,
    fixPunctuationSpacing: true,
  });
}

/**
 * کلید جست‌وجو: تهاجمی و فقط برای مقایسه (هرگز برای نمایش).
 * اعراب و همزه‌ها یکی، ارقام لاتین، حروف لاتین کوچک، نیم‌فاصله و نشانه‌ها → فاصله.
 * ← «ماده ۱۰» و «ماده 10» و «مادهٔ ۱۰» یک کلید دارند.
 * اگر `zwnj: "remove"` باشد نیم‌فاصله حذف می‌شود (کتاب‌ها ≈ کتابها)؛ پیش‌فرض: space (می‌خواهم ≈ می خواهم).
 */
export function searchKey(text: string, options: Readonly<{ zwnj?: "space" | "remove" }> = {}): string {
  let s = normalizePersianText(text, { digits: "latin", removeDiacritics: true, foldHamza: true });
  s = s.toLowerCase();
  s = s.replace(/[\u066B]/g, ".").replace(/[\u066C]/g, ","); // جداکننده‌های عربی
  s = s.replace(/(\d)[,.](?=\d{3}(?!\d))/g, "$1"); // ۱٬۰۰۰٬۰۰۰ → ۱۰۰۰۰۰۰
  s = s.replace(new RegExp(ZWNJ, "g"), options.zwnj === "remove" ? "" : " ");
  s = s.replace(new RegExp("[^\\p{L}\\p{N}\\s]", "gu"), " ");
  return s.replace(/\s+/g, " ").trim();
}

/** شکستن متن به واژه‌های کلید جست‌وجو. */
export function tokenize(text: string): string[] {
  const key = searchKey(text);
  return key === "" ? [] : key.split(" ");
}

export function containsPersian(text: string): boolean {
  return new RegExp(`[${L}]`).test(text);
}

/**
 * واژه‌بندی و هم‌سان‌سازی نگارش برای سنجش نقل‌قول و تشخیص ارجاع در متن آزاد.
 *
 * چرا ماژول خودش را دارد؟ registry این ماژول را فقط به legal-kb-schema و shared-types وابسته کرده (persian-text مجاز نیست؛
 * افزودنِ وابستگی = تغییر registry و تأیید معماری). نیاز اینجا کوچک و بسته است و تست جداگانه دارد.
 *
 * هم‌سان‌سازی (فقط نگارش، هرگز معنا): ارقام فارسی/عربی → لاتین، «ي ى ك» عربی → «ی ک»، حذف اعراب و کشیده،
 * حروف لاتین کوچک. نیم‌فاصله و هر نشانه‌گذاری **مرز واژه** است (واژه = دنباله‌ای از حرف/عدد). بنابراین «می‌شود» و «می شود»
 * یکی‌اند ولی «میشود» نه (محافظه‌کارانه: شبیه‌ترین‌ها را نمی‌پذیریم).
 */

const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
// ساخت با RegExp(...) تا هدف ES2017 در tsconfig مانع «\p{…}» نشود؛ زمان اجرا Node ≥ 22 است.
const WORD_RE = new RegExp("[\\p{L}\\p{N}\\p{M}]+", "gu");
const MARK_RE = new RegExp("\\p{M}", "u");

export type Token = Readonly<{ raw: string; folded: string; start: number; end: number }>;

/** یک واژه را هم‌سان می‌کند (بی‌اثر روی طول معنا؛ ممکن است کوتاه‌تر شود). */
export function foldWord(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const p = PERSIAN_DIGITS.indexOf(ch);
    if (p >= 0) out += String(p);
    else {
      const a = ARABIC_DIGITS.indexOf(ch);
      if (a >= 0) out += String(a);
      else if (ch === "ي" || ch === "ى") out += "ی";
      else if (ch === "ك") out += "ک";
      else if (ch === "\u0640" || MARK_RE.test(ch)) continue;
      else out += ch.toLowerCase();
    }
  }
  return out;
}

/** واژه‌های متن با جایگاهشان در متن اصلی. واژهٔ تهی پس از هم‌سان‌سازی (مثلاً فقط اعراب) حذف می‌شود. */
export function tokenize(text: string): readonly Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(WORD_RE)) {
    const raw = m[0];
    const folded = foldWord(raw);
    if (folded === "") continue;
    const start = m.index ?? 0;
    out.push({ raw, folded, start, end: start + raw.length });
  }
  return out;
}

/** فاصله‌ای که اجازهٔ «پیوستگی» می‌دهد: فاصله/نیم‌فاصله/پرانتز/گیومه/خط‌تیره؛ نه نقطه، ویرگول و هر مرز جمله. */
const LINK_GAP_RE = /^[\s\u200c\u00a0()[\]«»"'\-–—]*$/;
export function isLinkGap(gap: string): boolean {
  return LINK_GAP_RE.test(gap);
}

// ───────────── نقل‌قول ─────────────

/** کمینهٔ طول (نویسه‌های هم‌سان‌شده) برای اینکه نقل‌قول معنادار باشد؛ «و» یا «ماده» در هر متنی هست. */
export const MIN_QUOTE_CHARS = 8;

const ELLIPSIS_RE = /\s*(?:\.{3,}|…|\[\s*(?:\.{3}|…)\s*\])\s*/;

export type QuoteCheck = Readonly<{ ok: true } | { ok: false; reason: string }>;

/** پیدا کردن دنبالهٔ پیوستهٔ `needle` در `hay` از اندیس `from`؛ `-1` اگر نبود. واژه‌به‌واژه (نه زیررشته). */
function findSubsequence(hay: readonly string[], needle: readonly string[], from: number): number {
  outer: for (let i = from; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/**
 * آیا `quote` در یکی از `texts` آمده است؟ هر بخش (جداشده با «…») باید واژه‌به‌واژه و به‌ترتیب، بدون هم‌پوشانی بیاید.
 * همهٔ بخش‌ها باید در **یک** متن بیایند (نه پراکنده بین چند متن).
 */
export function checkQuote(quote: string, texts: readonly string[]): QuoteCheck {
  const fragments = quote
    .split(ELLIPSIS_RE)
    .map((f) => tokenize(f).map((t) => t.folded))
    .filter((f) => f.length > 0);
  if (fragments.length === 0) return { ok: false, reason: "نقل‌قول خالی است." };
  const chars = fragments.reduce((n, f) => n + f.reduce((m, w) => m + w.length, 0), 0);
  if (chars < MIN_QUOTE_CHARS) return { ok: false, reason: `نقل‌قول بسیار کوتاه است (کمتر از ${MIN_QUOTE_CHARS} نویسه)؛ سنجش آن معنا ندارد.` };
  for (const text of texts) {
    const hay = tokenize(text).map((t) => t.folded);
    let from = 0;
    let all = true;
    for (const f of fragments) {
      const at = findSubsequence(hay, f, from);
      if (at < 0) {
        all = false;
        break;
      }
      from = at + f.length;
    }
    if (all) return { ok: true };
  }
  return { ok: false, reason: "نقل‌قول در متن این ماده/تبصره/بند (در تاریخ مورد نظر) پیدا نشد." };
}

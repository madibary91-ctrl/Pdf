/**
 * برنامه‌ریزی پرسش (خالص، بدون پایگاه): نرمال‌سازی، حذف واژه‌های ربطی، سقف واژه‌ها، و فهرست «گونه‌های آرام‌سازی».
 *
 * چرا؟ `searchArticles` معنای AND دارد (همهٔ واژه‌ها باید در متن باشند) و ریشه‌یابی ندارد؛ پرسشِ طبیعی («آیا فروشنده مکلف به
 * تحویل مبیع است؟») با یک واژهٔ ربطی یا یک صورتِ دیگرِ واژه هیچ نتیجه‌ای نمی‌دهد. این فایل پرسش را به واژه‌های محتوایی
 * می‌کاهد و گونه‌هایی با «یک/چند واژهٔ کمتر» را به ترتیب کم‌خطر می‌چیند؛ هر نتیجه بعداً با `coverage` برچسب می‌خورد، پس
 * آرام‌سازی هرگز پنهان نیست.
 *
 * ⚠️ فهرست `STOPWORDS_FA` فقط واژه‌های دستوری/پرسشی است، نه اصطلاح حقوقی؛ عمداً شامل «ماده»، «مگر»، «بدون»، «قبل/بعد»،
 * «حق» و ارقام نیست (معنای حقوقی یا ارجاعی دارند).
 */
import { SEARCH_LIMITS } from "@/modules/legal-kb-store";
import { searchKey } from "@/modules/persian-text";
import type { QueryPlan, RetrievalResult } from "./types";

export const MAX_QUESTION_CHARS = 2000;
export const DEFAULT_MAX_TERMS = 8;

/** واژه‌های دستوری و پرسشی (نگارش عادی؛ پیش از استفاده با `searchKey` نرمال می‌شوند). */
export const STOPWORDS_FA: readonly string[] = [
  "و", "در", "به", "از", "که", "را", "با", "این", "آن", "برای", "تا", "یا", "هم", "اما", "اگر", "ولی", "نیز", "پس", "چون", "زیرا",
  "چه", "چرا", "چگونه", "چطور", "کجا", "کی", "کدام", "چند", "چیست", "آیا", "کدامند", "کیست",
  "است", "هست", "بود", "باشد", "باشند", "شود", "شد", "شده", "می", "نمی", "کرد", "کند", "کنند", "کنید", "دارد", "دارند", "داشت", "داشته",
  "بر", "بی", "همه", "هر", "یک", "ها", "های", "ای", "تر", "ترین", "خود", "وی", "او", "ایشان", "آنها", "آنان", "ما", "شما", "من", "تو",
  "همین", "همان", "چنین", "چنان", "اینکه", "آنکه", "هیچ", "نه", "بین", "میان", "روی", "طبق", "درباره", "چقدر", "آنچه", "هنگامی", "وقتی",
];

const keyWords = (text: string): string[] => {
  const key = searchKey(text);
  return key === "" ? [] : key.split(" ").filter((t) => t !== "");
};

const STOP: ReadonlySet<string> = new Set(STOPWORDS_FA.flatMap(keyWords));

export const isStopword = (token: string): boolean => STOP.has(token);

const bad = (message: string): RetrievalResult<never> => ({ ok: false, error: { code: "INVALID_INPUT", message } });

/** برنامهٔ پرسش. هیچ واژه‌ای بی‌صدا حذف نمی‌شود: هر حذف در `stopwords`/`unsearchable`/`truncated` ثبت است. */
export function planQuery(question: unknown, maxTerms: number = DEFAULT_MAX_TERMS): RetrievalResult<QueryPlan> {
  if (typeof question !== "string") return bad("question باید متن باشد.");
  if (question.length > MAX_QUESTION_CHARS) return bad(`پرسش بیش از ${MAX_QUESTION_CHARS} نویسه است؛ کوتاه‌تر کنید (بی‌صدا برش نمی‌دهیم).`);
  if (!Number.isInteger(maxTerms) || maxTerms < 1 || maxTerms > SEARCH_LIMITS.maxQueryTokens) {
    return bad(`maxTerms باید عدد صحیح ۱ تا ${SEARCH_LIMITS.maxQueryTokens} باشد.`);
  }

  const seen = new Set<string>();
  const content: string[] = [];
  const stopwords: string[] = [];
  const unsearchable: string[] = [];
  for (const t of keyWords(question)) {
    if (seen.has(t)) continue;
    seen.add(t);
    if (t.length > SEARCH_LIMITS.maxTokenChars) unsearchable.push(t);
    else if (STOP.has(t)) stopwords.push(t);
    else content.push(t);
  }
  if (content.length === 0) {
    return { ok: false, error: { code: "EMPTY_QUERY", message: "پرسش واژهٔ محتوایی قابل‌جست‌وجو ندارد (فقط واژه‌های ربطی، نشانه یا واژه‌های بیش‌ازحد بلند)." } };
  }

  let tokens = content;
  let truncated: string[] = [];
  if (content.length > maxTerms) {
    // کوتاه‌ترین واژه‌ها کم‌تمایزترند؛ هم‌طول ⇒ واژهٔ دیرتر می‌افتد. ترتیب ورود در خروجی حفظ می‌شود.
    const keep = new Set(
      content
        .map((t, i) => ({ t, i }))
        .sort((a, b) => b.t.length - a.t.length || a.i - b.i)
        .slice(0, maxTerms)
        .map((x) => x.i),
    );
    tokens = content.filter((_, i) => keep.has(i));
    truncated = content.filter((_, i) => !keep.has(i));
  }
  return { ok: true, value: { tokens, stopwords, unsearchable, truncated } };
}

export type RelaxationOptions = Readonly<{ minCoverage: number; maxQueries: number }>;
export type RelaxationPlan = Readonly<{
  /** گونه‌ها به ترتیب اجرا؛ نخستین همیشه کامل است. هر گونه زیردنبالهٔ واژه‌های ورودی است. */
  variants: readonly (readonly string[])[];
  /** `false` = سقف `maxQueries` بخشی از گونه‌ها را حذف کرد. */
  complete: boolean;
}>;

function* combinations(n: number, d: number, start = 0, acc: number[] = []): Generator<number[]> {
  if (acc.length === d) {
    yield [...acc];
    return;
  }
  for (let i = start; i <= n - (d - acc.length); i++) {
    acc.push(i);
    yield* combinations(n, d, i + 1, acc);
    acc.pop();
  }
}

/**
 * گونه‌های آرام‌سازی: ابتدا کامل؛ سپس همهٔ گونه‌های «یک واژه کمتر»، بعد «دو واژه کمتر» و … تا کفِ `ceil(n × minCoverage)`.
 * در هر سطح، گونه‌ای زودتر می‌آید که واژه‌های افتاده‌اش کوتاه‌تر (کم‌تمایزتر) باشند؛ سپس ترتیب ورود (قطعی).
 */
export function planRelaxation(tokens: readonly string[], options: RelaxationOptions): RelaxationPlan {
  const n = tokens.length;
  if (n === 0) return { variants: [], complete: true };
  const { minCoverage, maxQueries } = options;
  const cap = Math.max(1, Math.floor(maxQueries));
  const variants: (readonly string[])[] = [tokens];
  if (n > SEARCH_LIMITS.maxQueryTokens) return { variants, complete: n === 1 };
  const minTerms = Math.min(n, Math.max(1, Math.ceil(n * minCoverage - 1e-9)));
  let total = 1;
  for (let k = n - 1; k >= minTerms; k--) {
    const level = [...combinations(n, n - k)]
      .map((dropped) => ({ dropped, weight: dropped.reduce((s, i) => s + (tokens[i] ?? "").length, 0) }))
      .sort((a, b) => a.weight - b.weight || compareLex(a.dropped, b.dropped));
    for (const { dropped } of level) {
      total++;
      if (variants.length < cap) {
        const drop = new Set(dropped);
        variants.push(tokens.filter((_, i) => !drop.has(i)));
      }
    }
  }
  return { variants, complete: total <= cap };
}

function compareLex(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

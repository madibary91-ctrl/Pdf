/**
 * `retrieve`: پرسش طبیعی ← بندهای معتبرِ در تاریخ، از پورت جست‌وجو (ADR-0013).
 *
 * اصول:
 *  • `asOf` الزامی و `verifiedOnly` پیش‌فرض `true` است و **بی‌تغییر** به ذخیره‌گاه می‌رسد؛ این ماژول هیچ متنی نمی‌سازد، فقط
 *    آنچه ذخیره‌گاه (از جدول اصلی) داده را رتبه می‌دهد؛
 *  • آرام‌سازی کنترل‌شده: ابتدا AND کامل؛ فقط اگر کم بود، گونه‌های با واژهٔ کمتر؛ هر نتیجه `coverage` و واژه‌های گم‌شده دارد؛
 *  • هیچ حذف بی‌صدایی نیست: واژه‌های افتاده در `plan`، کهنگی نمایه در `staleSkipped/incomplete`، سقف‌ها در `budgetExhausted/hasMore`؛
 *  • هرگز پرتاب نمی‌کند (`Result`)، حتی اگر پورت پرتاب کند.
 */
import { searchKey } from "@/modules/persian-text";
import { SEARCH_LIMITS } from "@/modules/legal-kb-store";
import { DEFAULT_MAX_TERMS, planQuery, planRelaxation } from "./query";
import { comparePassages, passageKey } from "./rank";
import type { SearchHit, SearchInput } from "./store-types";
import type { Passage, Retrieval, RetrievalResult, RetrieveRequest, Searcher } from "./types";

export const DEFAULTS = Object.freeze({ limit: 10, maxTerms: DEFAULT_MAX_TERMS, minCoverage: 0.6, maxQueries: 12, maxQueriesCeiling: 64 });

const KEYS: ReadonlySet<string> = new Set(["question", "asOf", "verifiedOnly", "documentId", "limit", "maxTerms", "minCoverage", "maxQueries"]);
const bad = (message: string): RetrievalResult<never> => ({ ok: false, error: { code: "INVALID_INPUT", message } });

type Parsed = Readonly<{
  question: string;
  asOf: string;
  verifiedOnly: boolean;
  documentId: string | null;
  limit: number;
  maxTerms: number;
  minCoverage: number;
  maxQueries: number;
}>;

function intIn(v: unknown, name: string, lo: number, hi: number, dflt: number): RetrievalResult<number> {
  if (v === undefined) return { ok: true, value: dflt };
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) return bad(`${name} باید عدد صحیح ${lo} تا ${hi} باشد.`);
  return { ok: true, value: v };
}

/** اعتبارسنجی ورودی روی مرز (سخت‌گیر، بی‌حدس). */
export function parseRequest(input: unknown): RetrievalResult<Parsed> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return bad("ورودی بازیابی باید شیء باشد.");
  const rec = input as Record<string, unknown>;
  for (const k of Object.keys(rec)) if (!KEYS.has(k)) return bad(`کلید ناشناختهٔ «${k}» در ورودی بازیابی (مجاز: ${[...KEYS].join("، ")}).`);
  if (typeof rec["question"] !== "string") return bad("question باید متن باشد.");
  if (typeof rec["asOf"] !== "string") return bad("asOf (تاریخ ISO، مثل 2024-03-01) الزامی است؛ پیش‌فرضِ پنهان نداریم.");
  const verifiedOnly = rec["verifiedOnly"] === undefined ? true : rec["verifiedOnly"];
  if (typeof verifiedOnly !== "boolean") return bad("verifiedOnly باید true یا false باشد.");
  let documentId: string | null = null;
  if (rec["documentId"] !== undefined) {
    if (typeof rec["documentId"] !== "string" || rec["documentId"] === "") return bad("documentId باید متن غیرتهی باشد.");
    documentId = rec["documentId"];
  }
  const limit = intIn(rec["limit"], "limit", 1, SEARCH_LIMITS.maxLimit, DEFAULTS.limit);
  if (!limit.ok) return limit;
  const maxTerms = intIn(rec["maxTerms"], "maxTerms", 1, SEARCH_LIMITS.maxQueryTokens, DEFAULTS.maxTerms);
  if (!maxTerms.ok) return maxTerms;
  const maxQueries = intIn(rec["maxQueries"], "maxQueries", 1, DEFAULTS.maxQueriesCeiling, DEFAULTS.maxQueries);
  if (!maxQueries.ok) return maxQueries;
  const mc = rec["minCoverage"] === undefined ? DEFAULTS.minCoverage : rec["minCoverage"];
  if (typeof mc !== "number" || !Number.isFinite(mc) || mc <= 0 || mc > 1) return bad("minCoverage باید عددی در بازهٔ (۰،۱] باشد.");
  return {
    ok: true,
    value: { question: rec["question"], asOf: rec["asOf"], verifiedOnly, documentId, limit: limit.value, maxTerms: maxTerms.value, minCoverage: mc, maxQueries: maxQueries.value },
  };
}

function wordsOf(text: string): string[] {
  const key = searchKey(text);
  return key === "" ? [] : key.split(" ").filter((t) => t !== "" && t.length <= SEARCH_LIMITS.maxTokenChars);
}

/** تبدیل نتیجهٔ ذخیره‌گاه به بند، با پوشش و امتیازِ محاسبه‌شدهٔ محلی روی **همهٔ** واژه‌های پرسش. */
export function toPassage(hit: SearchHit, terms: readonly string[]): Passage {
  const counts = new Map<string, number>();
  for (const w of wordsOf([hit.text, ...hit.subparts.map((s) => s.text)].join("\n"))) counts.set(w, (counts.get(w) ?? 0) + 1);
  const matchedTerms: string[] = [];
  const missingTerms: string[] = [];
  let score = 0;
  for (const t of terms) {
    const c = counts.get(t) ?? 0;
    if (c > 0) {
      matchedTerms.push(t);
      score += c;
    } else missingTerms.push(t);
  }
  return {
    ref: { documentId: hit.ref.documentId, article: hit.ref.article, validFrom: hit.ref.validFrom },
    citation: { documentId: hit.ref.documentId, article: hit.ref.article, subpart: null },
    documentTitle: hit.documentTitle,
    validTo: hit.validTo,
    text: hit.text,
    subparts: hit.subparts,
    verified: hit.verified,
    contentHash: hit.contentHash,
    matchedTerms,
    missingTerms,
    coverage: terms.length === 0 ? 0 : matchedTerms.length / terms.length,
    score,
  };
}

export async function retrieve(searcher: Searcher, request: unknown): Promise<RetrievalResult<Retrieval>> {
  const parsed = parseRequest(request);
  if (!parsed.ok) return parsed;
  const req = parsed.value;
  const planned = planQuery(req.question, req.maxTerms);
  if (!planned.ok) return planned;
  const plan = planned.value;
  const { variants, complete } = planRelaxation(plan.tokens, { minCoverage: req.minCoverage, maxQueries: req.maxQueries });

  const merged = new Map<string, Passage>();
  let queriesRun = 0;
  let staleSkipped = 0;
  let storeHasMore = false;
  let stoppedEarly = false;
  let level = variants[0]?.length ?? 0;

  for (const variant of variants) {
    if (variant.length < level) {
      // سطح تازه (واژهٔ کمتر) فقط وقتی باز می‌شود که سطح پیشین به `limit` نتیجه نرسیده باشد.
      if (merged.size >= req.limit) {
        stoppedEarly = true;
        break;
      }
      level = variant.length;
    }
    const input: SearchInput = {
      text: variant.join(" "),
      asOf: req.asOf,
      verifiedOnly: req.verifiedOnly,
      limit: req.limit,
      ...(req.documentId === null ? {} : { documentId: req.documentId }),
    };
    let res: Awaited<ReturnType<Searcher["searchArticles"]>>;
    try {
      res = await searcher.searchArticles(input);
    } catch {
      return { ok: false, error: { code: "STORE_ERROR", message: "جست‌وجو در پایگاه دانش با خطای پیش‌بینی‌نشده شکست خورد." } };
    }
    queriesRun++;
    if (!res.ok) return { ok: false, error: { code: "STORE_ERROR", message: res.error.message, storeCode: res.error.code } };
    staleSkipped = Math.max(staleSkipped, res.value.staleSkipped);
    storeHasMore = storeHasMore || res.value.hasMore;
    for (const hit of res.value.hits) {
      const p = toPassage(hit, plan.tokens);
      const key = passageKey(p.ref);
      if (!merged.has(key)) merged.set(key, p);
    }
  }

  const all = [...merged.values()].sort(comparePassages);
  return {
    ok: true,
    value: {
      asOf: req.asOf,
      verifiedOnly: req.verifiedOnly,
      plan,
      passages: all.slice(0, req.limit),
      hasMore: all.length > req.limit || storeHasMore,
      queriesRun,
      relaxed: queriesRun > 1,
      budgetExhausted: !stoppedEarly && !complete,
      staleSkipped,
      incomplete: staleSkipped > 0,
    },
  };
}

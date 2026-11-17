/**
 * متن جست‌وجو (خالص، بدون پایگاه) — بخش ۴ب‑۳.
 *
 * هر دو سمت (نمایه و پرسش) از **همین** `searchKey` ماژول `persian-text` می‌گذرند؛ تنها راهِ تضمین اینکه «ماده ۱۰»، «ماده 10» و «مادهٔ ۱۰»
 * و «كتاب/کتاب» یکی دیده شوند. اگر قاعدهٔ نرمال‌سازی روزی عوض شود، نمایه‌های قدیمی با پرسش‌های جدید نمی‌خوانند و بی‌صدا چیز گم می‌شود؛
 * برای همین **اثر انگشتِ قاعده** (`searchKeyFingerprint`) در هر ردیف نمایه نگه داشته می‌شود و ردیفِ ناهمخوان «کهنه» حساب می‌شود (و با
 * `reindexSearch` خودکار بازسازی می‌شود) — بی‌آنکه کسی یادش باشد نسخه را دستی بالا ببرد.
 */
import { parseIsoDate, type IsoDate, type Subpart } from "@/modules/legal-kb-schema";
import { searchKey } from "@/modules/persian-text";
import { createHash } from "node:crypto";
import { versionContentHash } from "./content-hash";
import type { SearchInput } from "./search-types";
import type { StoreResult } from "./types";

export const SEARCH_LIMITS = Object.freeze({
  maxQueryChars: 500,
  maxQueryTokens: 12,
  /** واژه‌ی بلندتر از این نه نمایه می‌شود نه می‌تواند پرسیده شود (رشتهٔ بی‌معنی/خراب OCR). */
  maxTokenChars: 64,
  defaultLimit: 20,
  maxLimit: 100,
});

/** برچسب قالب نمایه؛ اگر شکلِ سطرها (نه فقط نرمال‌سازی) عوض شد بالا برده شود. */
const SCHEME = "kb-search-key/v1";

/** نمونه‌های آزمون برای اثر انگشت: حرف عربی/فارسی، ارقام، همزه، نیم‌فاصله، اعراب، شکل‌های ارائه، جداکننده‌ها، کشیده، لاتین، نشانه‌ها. */
const PROBES: readonly string[] = [
  "ي ك ى ۀ ة ؤ ئ أ إ آ ھ ہ",
  "۱۲۳ ٤٥٦ 789 ۰",
  "مادهٔ ۱۰ مکرر و ماده‌ی 10",
  "می‌خواهم کتاب‌ها و نمی‌توانم بروم",
  "اَعراب و تَشدیدٌ و كِتَابٌ",
  "ﻛﺘﺎﺏ ﻟﻼ ﻳﺎ",
  "۱٬۰۰۰٬۰۰۰ و 1,000,000 و ۱٫۵",
  "کــشیــده",
  "ABC Def ÉCOLE",
  "a/b-c_d (e)؟ «x»؛ ، ! ?",
  "\u200Cنیم\u200C\u200Cفاصله\u200C \u200Fراست\u200E",
];

let fingerprintCache: string | null = null;

/** اثر انگشت رفتار فعلیِ `searchKey` (و قالب نمایه). همیشه ۶۴ نویسهٔ هگز. */
export function searchKeyFingerprint(): string {
  if (fingerprintCache === null) {
    fingerprintCache = createHash("sha256")
      .update(JSON.stringify([SCHEME, SEARCH_LIMITS.maxTokenChars, PROBES.map((p) => tokensOf(p))]), "utf8")
      .digest("hex");
  }
  return fingerprintCache;
}

/** واژه‌های کلید جست‌وجو؛ واژهٔ بلندتر از سقف حذف می‌شود. ترتیب و تکرار حفظ می‌شود (تکرار برای امتیاز لازم است). */
function tokensOf(text: string): string[] {
  const key = searchKey(text);
  if (key === "") return [];
  return key.split(" ").filter((t) => t !== "" && t.length <= SEARCH_LIMITS.maxTokenChars);
}

export type IndexRow = Readonly<{ contentHash: string; keyFingerprint: string; tokens: readonly string[] }>;

/** ردیف نمایهٔ یک نسخه: واژه‌های متن و همهٔ تبصره/بندها (برچسب‌ها نه). */
export function buildIndexRow(content: Readonly<{ text: string; subparts: readonly Pick<Subpart, "kind" | "label" | "text">[] }>): IndexRow {
  return {
    contentHash: versionContentHash(content),
    keyFingerprint: searchKeyFingerprint(),
    tokens: tokensOf([content.text, ...content.subparts.map((s) => s.text)].join("\n")),
  };
}

export type ParsedSearch = Readonly<{
  tokens: readonly string[];
  asOf: IsoDate;
  verifiedOnly: boolean;
  documentId: string | null;
  limit: number;
}>;

const KEYS: ReadonlySet<string> = new Set(["text", "asOf", "verifiedOnly", "documentId", "limit"]);
const DOC_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const bad = (message: string): StoreResult<never> => ({ ok: false, error: { code: "INVALID_INPUT", message } });

/**
 * اعتبارسنجی ورودی روی مرز. سخت‌گیرانه و بی‌حدس: کلید ناشناخته (غلط املایی مثل `verifiedonly` که پیش‌فرض ایمن را بی‌صدا دور می‌زند)،
 * تاریخ نامعتبر، بیش از ۱۲ واژه (بی‌صدا برش نمی‌خورد) و واژهٔ بیش از ۶۴ نویسه همه `INVALID_INPUT` هستند.
 */
export function parseSearchInput(input: unknown): StoreResult<ParsedSearch> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return bad("ورودی جست‌وجو باید شیء باشد.");
  const rec = input as Record<string, unknown>;
  for (const k of Object.keys(rec)) if (!KEYS.has(k)) return bad(`کلید ناشناختهٔ «${k}» در ورودی جست‌وجو (مجاز: ${[...KEYS].join("، ")}).`);

  if (typeof rec["text"] !== "string") return bad("text باید متن باشد.");
  if (rec["text"].length > SEARCH_LIMITS.maxQueryChars) return bad(`پرسش بیش از ${SEARCH_LIMITS.maxQueryChars} نویسه است.`);

  if (typeof rec["asOf"] !== "string") return bad("asOf (تاریخ ISO، مثل 2024-03-01) الزامی است؛ پیش‌فرضِ پنهان نداریم.");
  const date = parseIsoDate(rec["asOf"]);
  if (!date.ok) return bad(`asOf نامعتبر است: ${date.error.message}`);

  const verifiedOnly = rec["verifiedOnly"] === undefined ? true : rec["verifiedOnly"];
  if (typeof verifiedOnly !== "boolean") return bad("verifiedOnly باید true یا false باشد.");

  let documentId: string | null = null;
  if (rec["documentId"] !== undefined) {
    const d = rec["documentId"];
    if (typeof d !== "string" || d.length > 64 || !DOC_ID_RE.test(d)) return bad("documentId نامعتبر است (حروف کوچک لاتین، عدد و -، حداکثر ۶۴ نویسه).");
    documentId = d;
  }

  const limit = rec["limit"] === undefined ? SEARCH_LIMITS.defaultLimit : rec["limit"];
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > SEARCH_LIMITS.maxLimit) return bad(`limit باید عدد صحیح ۱ تا ${SEARCH_LIMITS.maxLimit} باشد.`);

  const key = searchKey(rec["text"]);
  const all = key === "" ? [] : key.split(" ");
  if (all.length === 0) return bad("پرسش هیچ واژهٔ قابل‌جست‌وجو ندارد (فقط نشانه یا فاصله).");
  const long = all.find((t) => t.length > SEARCH_LIMITS.maxTokenChars);
  if (long !== undefined) return bad(`واژه‌ای بیش از ${SEARCH_LIMITS.maxTokenChars} نویسه دارد؛ چنین واژه‌ای هرگز نمایه نمی‌شود و پیدا نخواهد شد.`);
  const tokens = [...new Set(all)];
  if (tokens.length > SEARCH_LIMITS.maxQueryTokens) return bad(`پرسش بیش از ${SEARCH_LIMITS.maxQueryTokens} واژهٔ متمایز دارد؛ کوتاه‌تر کنید (بی‌صدا برش نمی‌دهیم).`);

  return { ok: true, value: { tokens, asOf: date.value, verifiedOnly, documentId, limit } };
}

export type { SearchInput };

/**
 * «اوراکل» خالص همان معنای جست‌وجو (برای تست تفاضلی با پایگاه): همهٔ واژه‌های پرسش در واژه‌های متن باشند؛ امتیاز = جمع دفعات ظاهر شدن.
 * (در تولید استفاده نمی‌شود؛ تعریف مرجعِ معنا است.)
 */
export function referenceMatches(queryTokens: readonly string[], row: Pick<IndexRow, "tokens">): number | null {
  const set = new Set(queryTokens);
  const present = new Set<string>();
  let score = 0;
  for (const t of row.tokens) {
    if (set.has(t)) {
      present.add(t);
      score++;
    }
  }
  return present.size === set.size ? score : null;
}

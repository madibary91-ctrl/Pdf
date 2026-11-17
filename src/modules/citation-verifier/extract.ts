/**
 * تشخیص ارجاع‌های حقوقی در متن آزاد فارسی (خالص).
 *
 * اصل طراحی: **شکست‌به‌سمت‌ایمنی**. هر چیزی که شبیه ارجاع است ولی نمی‌توانیم به یک «سند + ماده (+ تبصره/بند)»ی یکتا
 * نسبتش دهیم، `Mention` با وضعیتِ ردشونده می‌شود؛ هرگز بی‌صدا نادیده گرفته نمی‌شود.
 *
 * دستور زبانِ پشتیبانی‌شده (عمداً کوچک و صریح؛ بقیه یا نادیده‌اند یا `unsupported-form`):
 *   [تبصره|بند <برچسب>] (ماده|اصل) <عدد> [مکرر [<عدد>]] | ماده واحده   [از] <نام سند>
 *   نام سند = عنوان یا عنوان کوتاه یکی از سندهای پایگاه (از همان داده ساخته می‌شود؛ هیچ نام قانونی در کد نیست).
 *
 * محدودیت‌های صادقانه (ADR-0010): عددِ حروفی («ماده ده»)، «همین قانون»، ارجاعِ سند‌-نخست («در قانون X ماده ۲»)
 * و «تبصره/بند» بدونِ ماده، تشخیص داده نمی‌شوند. این لایه خط دوم است؛ خروجی مدل باید ارجاع‌های ساختاریافته (verifyCitations) بدهد.
 */
import { canonicalArticleLabel, canonicalSubpartLabel, type CorpusIndex } from "@/modules/legal-kb-schema";
import { isLinkGap, tokenize, type Token } from "./tokens";
import type { Mention, MentionStatus } from "./types";

type Alias = Readonly<{ tokens: readonly string[]; docIds: readonly string[] }>;
export type AliasTable = Readonly<{ byFirstToken: ReadonlyMap<string, readonly Alias[]> }>;

const PARENS_RE = /\([^)]*\)|（[^）]*）|\[[^\]]*\]/g;

/** نام‌های ممکنِ هر سند: عنوان، عنوان بدون بخش‌های پرانتزی (مثل «(ساختگی)») و عنوان کوتاه. */
export function buildAliasTable(index: CorpusIndex): AliasTable {
  const byKey = new Map<string, { tokens: string[]; docIds: Set<string> }>();
  const add = (name: string | null, docId: string): void => {
    if (name === null) return;
    const tokens = tokenize(name).map((t) => t.folded);
    if (tokens.length === 0) return;
    const key = tokens.join(" ");
    const entry = byKey.get(key);
    if (entry) entry.docIds.add(docId);
    else byKey.set(key, { tokens, docIds: new Set([docId]) });
  };
  for (const doc of index.corpus.documents) {
    add(doc.title, doc.id);
    add(doc.title.replace(PARENS_RE, " "), doc.id);
    add(doc.shortTitle, doc.id);
  }
  const byFirst = new Map<string, Alias[]>();
  for (const e of byKey.values()) {
    const first = e.tokens[0] as string;
    const list = byFirst.get(first) ?? [];
    list.push({ tokens: e.tokens, docIds: [...e.docIds].sort() });
    byFirst.set(first, list);
  }
  for (const list of byFirst.values()) list.sort((a, b) => b.tokens.length - a.tokens.length || a.tokens.join(" ").localeCompare(b.tokens.join(" ")));
  return { byFirstToken: byFirst };
}

const tableCache = new WeakMap<CorpusIndex, AliasTable>();
export function aliasTableFor(index: CorpusIndex): AliasTable {
  let t = tableCache.get(index);
  if (t === undefined) {
    t = buildAliasTable(index);
    tableCache.set(index, t);
  }
  return t;
}

const ARTICLE_WORDS: ReadonlySet<string> = new Set(["ماده", "اصل", "مواد"]);
const SUBPART_WORDS: Readonly<Record<string, "note" | "clause">> = { تبصره: "note", بند: "clause" };
/** واژه‌هایی که پس از «ماده N» یعنی «نام یک سند می‌آید» (حتی اگر در پایگاه نباشد ⇒ unknown-document). */
const DOCUMENT_WORDS: ReadonlySet<string> = new Set(["قانون", "آیین", "دستورالعمل", "بخشنامه", "مصوبه", "اساسنامه", "لایحه"]);
const DIGITS_RE = /^\d+$/;
const LIST_WORDS: ReadonlySet<string> = new Set(["و", "تا"]);
const isListGap = (gap: string): boolean => /^[\s\u200c\u00a0,،]*$/.test(gap);

export function extractMentions(text: string, table: AliasTable, defaultDocumentId: string | null = null): readonly Mention[] {
  const toks = tokenize(text);
  const n = toks.length;
  const at = (i: number): Token | undefined => toks[i];
  const linked = (a: number, b: number): boolean => {
    const x = at(a);
    const y = at(b);
    return x !== undefined && y !== undefined && isLinkGap(text.slice(x.end, y.start));
  };
  /** عنوانی مثل «قانون … (ساختگی)» پرانتزِ بازِ بی‌بسته در بازه نگذارد؛ وگرنه پس از حذف «)» یتیم می‌ماند. */
  const closeBrackets = (start: number, end: number): number => {
    const span = text.slice(start, end);
    const count = (ch: string): number => span.split(ch).length - 1;
    let open = count("(") - count(")");
    let guard = open;
    let e = end;
    while (open > 0 && guard-- > 0) {
      const m = /^\s*\)/.exec(text.slice(e));
      if (m === null) break;
      e += m[0].length;
      open -= 1;
    }
    return e;
  };
  const out: Mention[] = [];
  const emit = (startTok: number, endTok: number, status: MentionStatus, claim: Mention["claim"], reason: string): void => {
    const start = (at(startTok) as Token).start;
    const end = closeBrackets(start, (at(endTok) as Token).end);
    out.push({ start, end, text: text.slice(start, end), status, claim, reason });
  };

  type Article =
    | Readonly<{ kind: "none" }>
    | Readonly<{ kind: "plural"; last: number }>
    | Readonly<{ kind: "article"; last: number; label: string | null; problem: string }>;

  /** تحلیل بخش «ماده …» از توکن j (که یکی از ARTICLE_WORDS است). */
  const parseArticle = (j: number): Article => {
    const word = (at(j) as Token).folded;
    const next = at(j + 1);
    if (next === undefined || !linked(j, j + 1)) return { kind: "none" };
    if (word === "مواد") {
      if (!DIGITS_RE.test(next.folded)) return { kind: "none" };
      // «مواد ۲ و ۳»، «مواد ۲، ۳ تا ۵»: تمام فهرست عددی را در یک بازه می‌گیریم تا پس از حذف چیزی از آن نماند.
      let last = j + 1;
      for (;;) {
        const a = at(last + 1);
        const b = at(last + 2);
        if (a !== undefined && DIGITS_RE.test(a.folded) && isListGap(text.slice((at(last) as Token).end, a.start))) last += 1;
        else if (a !== undefined && b !== undefined && LIST_WORDS.has(a.folded) && DIGITS_RE.test(b.folded) && isListGap(text.slice((at(last) as Token).end, a.start)) && isListGap(text.slice(a.end, b.start))) last += 2;
        else break;
      }
      return { kind: "plural", last };
    }
    let last = j + 1;
    let raw: string;
    if (next.folded === "واحده" && word === "ماده") raw = "واحده";
    else if (DIGITS_RE.test(next.folded)) {
      raw = next.folded;
      const rep = at(last + 1);
      if (rep !== undefined && rep.folded === "مکرر" && linked(last, last + 1)) {
        raw += " مکرر";
        last += 1;
        const num = at(last + 1);
        if (num !== undefined && DIGITS_RE.test(num.folded) && linked(last, last + 1)) {
          raw += ` ${num.folded}`;
          last += 1;
        }
      }
    } else return { kind: "none" };
    const label = canonicalArticleLabel(raw);
    return label.ok ? { kind: "article", last, label: label.value, problem: "" } : { kind: "article", last, label: null, problem: label.error.message };
  };

  /** نسبت دادن به سند پس از آخرین توکنِ بخش ماده (`last`). */
  const resolveDocument = (last: number): { status: "resolved" | MentionStatus; docId: string | null; end: number; reason: string } => {
    let p = last + 1;
    if (at(p)?.folded === "از" && linked(last, p)) p += 1;
    if (at(p) === undefined || !linked(p - 1, p)) return noDocument(last);
    const candidates = table.byFirstToken.get((at(p) as Token).folded) ?? [];
    for (const alias of candidates) {
      let ok = true;
      for (let k = 0; k < alias.tokens.length; k++) {
        const t = at(p + k);
        if (t === undefined || t.folded !== alias.tokens[k] || (k > 0 && !linked(p + k - 1, p + k))) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const end = p + alias.tokens.length - 1;
      if (alias.docIds.length === 1) return { status: "resolved", docId: alias.docIds[0] as string, end, reason: "" };
      return { status: "ambiguous-document", docId: null, end, reason: `نام قانون به ${alias.docIds.length} سند می‌خورد (${alias.docIds.join("، ")}).` };
    }
    if (DOCUMENT_WORDS.has((at(p) as Token).folded)) return { status: "unknown-document", docId: null, end: p, reason: "قانونی نام برده شده که در پایگاه دانش نیست؛ راستی‌آزمایی‌پذیر نیست." };
    return noDocument(last);
  };
  const noDocument = (last: number): { status: "resolved" | MentionStatus; docId: string | null; end: number; reason: string } =>
    defaultDocumentId !== null
      ? { status: "resolved", docId: defaultDocumentId, end: last, reason: "" }
      : { status: "no-document", docId: null, end: last, reason: "نام قانون نیامده؛ ارجاعِ بی‌سند قابل‌راستی‌آزمایی نیست." };

  let consumed = -1; // آخرین اندیس توکنِ مصرف‌شده
  let i = 0;
  while (i < n) {
    const word = (at(i) as Token).folded;
    const subKind = SUBPART_WORDS[word];

    // ─ ارجاع با پیشوند «تبصره/بند <برچسب>» ─
    if (subKind !== undefined && i + 2 < n && linked(i, i + 1) && linked(i + 1, i + 2) && ARTICLE_WORDS.has((at(i + 2) as Token).folded)) {
      const art = parseArticle(i + 2);
      if (art.kind !== "none") {
        if (art.kind === "plural") {
          const end = resolveDocument(art.last).end;
          emit(i, end, "unsupported-form", null, "ارجاع به چند ماده یکجا (مواد …) پشتیبانی نمی‌شود؛ هر ماده جدا و ساختاریافته بیاید.");
          consumed = end;
          i = end + 1;
          continue;
        }
        const sub = canonicalSubpartLabel((at(i + 1) as Token).raw);
        const doc = resolveDocument(art.last);
        const end = doc.end;
        if (art.label === null) emit(i, art.last, "malformed", null, art.problem);
        else if (!sub.ok) emit(i, art.last, "malformed", null, sub.error.message);
        else if (doc.status === "resolved") {
          emit(i, end, "resolved", { ref: { documentId: doc.docId as string, article: art.label, subpart: { kind: subKind, label: sub.value } }, quote: null }, "");
        } else emit(i, end, doc.status as MentionStatus, null, doc.reason);
        consumed = Math.max(art.last, end);
        i = consumed + 1;
        continue;
      }
    }

    // ─ ارجاع به ماده ─
    if (ARTICLE_WORDS.has(word)) {
      const art = parseArticle(i);
      if (art.kind === "none") {
        i += 1;
        continue;
      }
      // «تبصره/بند» که بی‌الگوی کامل درست پیش از ماده آمده (مثل «تبصره ماده ۲») ⇒ نفهمیدیم؛ رد، نه نادیده.
      const prev = at(i - 1);
      if (prev !== undefined && i - 1 > consumed && SUBPART_WORDS[prev.folded] !== undefined && linked(i - 1, i)) {
        emit(i - 1, art.last, "unsupported-form", null, "شکل «تبصره/بند … ماده …» بی‌برچسب مشخص پشتیبانی نمی‌شود؛ برچسب تبصره/بند را صریح بنویسید.");
        consumed = art.last;
        i = art.last + 1;
        continue;
      }
      if (art.kind === "plural") {
        const end = resolveDocument(art.last).end;
        emit(i, end, "unsupported-form", null, "ارجاع به چند ماده یکجا (مواد …) پشتیبانی نمی‌شود؛ هر ماده جدا و ساختاریافته بیاید.");
        consumed = end;
        i = end + 1;
        continue;
      }
      const doc = resolveDocument(art.last);
      if (art.label === null) emit(i, art.last, "malformed", null, art.problem);
      else if (doc.status === "resolved") emit(i, doc.end, "resolved", { ref: { documentId: doc.docId as string, article: art.label, subpart: null }, quote: null }, "");
      else emit(i, doc.end, doc.status as MentionStatus, null, doc.reason);
      consumed = Math.max(art.last, doc.end);
      i = consumed + 1;
      continue;
    }
    i += 1;
  }
  return out;
}

/**
 * آزمون تفاضلی/خاصیتی روی Corpusهای تصادفیِ بذردار: ماژول در برابر یک اوراکل مستقل
 * (که مستقیم روی دادهٔ خام می‌خواند، نه روی شاخص و نه با resolveCitation).
 */
import { describe, expect, it } from "vitest";
import { buildCorpusIndex, loadCorpus, type CorpusIndex } from "@/modules/legal-kb-schema";
import { buildAliasTable, checkQuote, checkText, DEFAULT_REDACTION, extractMentions, MIN_QUOTE_CHARS, redactRejected, verifyCitation, type CitationClaim, type VerdictCode } from "./index";

// ───────── مولد شبه‌تصادفی ─────────
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type R = () => number;
const int = (r: R, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T,>(r: R, xs: readonly T[]): T => xs[int(r, 0, xs.length - 1)] as T;

const COLORS = ["آبی", "سبز", "سرخ", "زرد", "نارنجی", "بنفش", "خاکستری", "سفید", "قهوه‌ای", "طلایی"];
const VOCAB = ["پرداخت", "مهلت", "ابلاغ", "دادگاه", "خوانده", "خواهان", "اجرا", "تعهد", "قرارداد", "رسیدگی", "اعتراض", "تجدیدنظر", "ابطال", "مطالبه", "وثیقه", "ضمانت", "رأی", "دلیل", "شاهد", "سوگند"];
const FILLER = ["بنابراین", "در نتیجه", "همچنین", "افزون بر این", "به‌طور کلی", "دادگاه چنین رأی داد", "پرسش شما", "پاسخ کوتاه"];
const DAY = 86_400_000;
const iso = (dayNumber: number): string => new Date(dayNumber * DAY).toISOString().slice(0, 10);
const BASE_DAY = Date.UTC(2000, 0, 1) / DAY;

const words = (r: R, n: number): string => Array.from({ length: n }, () => pick(r, VOCAB)).join(" ");

type RawVersion = { validFrom: string; validTo: string | null; text: string; subparts: { kind: "note" | "clause"; label: string; text: string }[]; provenance: unknown };
type RawArticle = { label: string; versions: RawVersion[] };
type RawDoc = { id: string; kind: string; title: string; shortTitle: null; enactedOn: null; provenance: unknown; articles: RawArticle[] };
type RawCorpus = { documents: RawDoc[]; relations: []; rulings: [] };

const prov = (verified: boolean) => ({
  sourceName: "منبع ساختگی",
  sourceUrl: null,
  sourceKind: verified ? "official" : "secondary",
  retrievedOn: "2025-01-10",
  review: verified ? { status: "legally-verified", reviewedBy: "بازبین فرضی", reviewedOn: "2025-02-01" } : { status: "pending-legal-review", reviewedBy: null, reviewedOn: null },
});

function genCorpus(seed: number): RawCorpus {
  const r = rng(seed);
  const pairs: string[] = [];
  for (const a of COLORS) for (const b of COLORS) if (a !== b) pairs.push(`قانون ${a} ${b}`);
  const documents: RawDoc[] = [];
  const nDocs = int(r, 2, 5);
  const used = new Set<string>();
  for (let d = 0; d < nDocs; d++) {
    let title = pick(r, pairs);
    while (used.has(title)) title = pick(r, pairs);
    used.add(title);
    const labels = new Set<string>();
    const articles: RawArticle[] = [];
    const nArt = int(r, 1, 6);
    for (let a = 0; a < nArt; a++) {
      const n = int(r, 1, 40);
      const shape = int(r, 0, 9);
      const label = shape === 0 ? "واحده" : shape < 3 ? `${n} مکرر` : shape === 3 ? `${n} مکرر ${int(r, 2, 4)}` : String(n);
      if (labels.has(label)) continue;
      labels.add(label);
      const versions: RawVersion[] = [];
      let from = BASE_DAY + int(r, 0, 3000);
      const nVer = int(r, 1, 4);
      for (let v = 0; v < nVer; v++) {
        const last = v === nVer - 1;
        const len = int(r, 30, 900);
        const gap = r() < 0.3;
        const to = last ? (r() < 0.5 ? null : from + len) : from + len;
        const subparts: RawVersion["subparts"] = [];
        for (let k = 1; k <= int(r, 0, 2); k++) subparts.push({ kind: "note", label: String(k), text: words(r, int(r, 5, 9)) });
        for (const l of ["الف", "ب", "پ"].slice(0, int(r, 0, 2))) subparts.push({ kind: "clause", label: l, text: words(r, int(r, 5, 9)) });
        versions.push({ validFrom: iso(from), validTo: to === null ? null : iso(to), text: words(r, int(r, 8, 16)), subparts, provenance: prov(r() < 0.5) });
        if (to !== null) from = to + (gap ? int(r, 1, 300) : 0);
      }
      articles.push({ label, versions });
    }
    documents.push({ id: `doc-${d + 1}`, kind: "statute", title, shortTitle: null, enactedOn: null, provenance: prov(true), articles });
  }
  return { documents, relations: [], rulings: [] };
}

function indexOf(raw: RawCorpus): CorpusIndex {
  const loaded = loadCorpus(JSON.parse(JSON.stringify(raw)));
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.error.slice(0, 3)));
  return buildCorpusIndex(loaded.value);
}

// ───────── اوراکل مستقل ─────────
function oracle(raw: RawCorpus, c: CitationClaim, date: string): VerdictCode {
  const doc = raw.documents.find((d) => d.id === c.ref.documentId);
  if (!doc) return "unknown-document";
  const art = doc.articles.find((a) => a.label === c.ref.article);
  if (!art) return "unknown-article";
  const v = art.versions.find((x) => x.validFrom <= date && (x.validTo === null || date < x.validTo));
  if (!v) {
    if (date < (art.versions[0] as RawVersion).validFrom) return "not-yet-in-force";
    return art.versions.some((x) => x.validFrom > date) ? "gap" : "no-longer-in-force";
  }
  if (c.ref.subpart !== null && !v.subparts.some((s) => s.kind === c.ref.subpart?.kind && s.label === c.ref.subpart.label)) return "unknown-subpart";
  return (v.provenance as { review: { status: string } }).review.status === "legally-verified" ? "valid" : "unverified-source";
}

/** همهٔ ادعاهای ممکن (واقعی و ساختگی) برای یک Corpus + تاریخ‌های مرزی. */
function claimsFor(raw: RawCorpus, r: R): CitationClaim[] {
  const out: CitationClaim[] = [];
  for (const d of raw.documents) {
    for (const a of d.articles) {
      out.push({ ref: { documentId: d.id, article: a.label, subpart: null } });
      out.push({ ref: { documentId: d.id, article: a.label, subpart: { kind: "note", label: String(int(r, 1, 3)) } } });
      out.push({ ref: { documentId: d.id, article: a.label, subpart: { kind: "clause", label: pick(r, ["الف", "ب", "پ", "ت"]) } } });
    }
    out.push({ ref: { documentId: d.id, article: String(int(r, 41, 60)), subpart: null } }); // ماده‌ای که نیست
  }
  out.push({ ref: { documentId: "doc-99", article: "1", subpart: null } });
  return out;
}
function datesFor(raw: RawCorpus): string[] {
  const s = new Set<string>(["1999-12-31", "2000-01-01", "2090-01-01"]);
  for (const d of raw.documents) for (const a of d.articles) for (const v of a.versions) {
    for (const x of [v.validFrom, v.validTo]) {
      if (x === null) continue;
      const n = Date.parse(x) / DAY;
      s.add(iso(n - 1));
      s.add(x);
      s.add(iso(n + 1));
    }
  }
  return [...s];
}

const SEEDS = Array.from({ length: 30 }, (_, i) => 1000 + i * 7919);

describe("تفاضلی: verifyCitation ≡ اوراکل مستقل (Corpus تصادفی، تاریخ‌های مرزی ±۱)", () => {
  it("حکم همهٔ ادعاها در همهٔ تاریخ‌های مرزی با اوراکل برابر است و پذیرش فقط برای valid است", () => {
    let checked = 0;
    const seen = new Set<VerdictCode>();
    for (const seed of SEEDS) {
      const raw = genCorpus(seed);
      const index = indexOf(raw);
      const r = rng(seed ^ 0x5bd1e995);
      const claims = claimsFor(raw, r);
      for (const date of datesFor(raw)) {
        for (const c of claims) {
          const expected = oracle(raw, c, date);
          const strict = verifyCitation(index, c, date);
          expect(strict.code, `${seed} ${date} ${JSON.stringify(c.ref)}`).toBe(expected);
          expect(strict.accepted).toBe(expected === "valid");
          const lax = verifyCitation(index, c, date, { allowUnverified: true });
          expect(lax.code).toBe(expected);
          expect(lax.accepted).toBe(expected === "valid" || expected === "unverified-source");
          seen.add(expected);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(20_000);
    // آزمون تهی نیست: همهٔ حکم‌های وابسته به داده دیده شده‌اند
    for (const code of ["valid", "unverified-source", "unknown-document", "unknown-article", "unknown-subpart", "not-yet-in-force", "no-longer-in-force", "gap"] as const) {
      expect(seen.has(code), code).toBe(true);
    }
  });
});

describe("خاصیت: نقل‌قول", () => {
  it("برشِ واقعیِ پیوسته از متن همان نسخه پذیرفته می‌شود؛ تغییر یک واژه یا جابه‌جایی رد می‌شود", () => {
    let accepted = 0;
    let rejected = 0;
    for (const seed of SEEDS) {
      const raw = genCorpus(seed);
      const index = indexOf(raw);
      const r = rng(seed + 17);
      for (const d of raw.documents) for (const a of d.articles) for (const v of a.versions) {
        const mid = Date.parse(v.validFrom) / DAY;
        const date = iso(mid);
        const target = pick(r, [{ text: v.text, sub: null as null | { kind: "note" | "clause"; label: string } }, ...v.subparts.map((s) => ({ text: s.text, sub: { kind: s.kind, label: s.label } }))]);
        const ws = target.text.split(" ");
        if (ws.length < 4) continue;
        const from = int(r, 0, ws.length - 3);
        const len = int(r, 3, ws.length - from);
        const piece = ws.slice(from, from + len);
        if (piece.join("").length < MIN_QUOTE_CHARS) continue;
        const claim = (quote: string): CitationClaim => ({ ref: { documentId: d.id, article: a.label, subpart: target.sub }, quote });
        const base = oracle(raw, claim(""), date);
        if (base !== "valid" && base !== "unverified-source") continue; // نسخهٔ معتبر در آن روز نیست
        const good = verifyCitation(index, claim(piece.join(" ")), date, { allowUnverified: true });
        expect(good.code, `${seed} ${piece.join(" ")}`).toBe(base);
        accepted++;
        const changed = [...piece];
        changed[int(r, 0, changed.length - 1)] = "زنجیره";
        expect(verifyCitation(index, claim(changed.join(" ")), date, { allowUnverified: true }).code).toBe("quote-mismatch");
        const reversed = [...piece].reverse();
        // اوراکلِ بی‌واسطه: آیا دنبالهٔ معکوس به‌طور اتفاقی هم در متن هست؟ (واژگان کوچک است)
        const occurs = ws.some((_, i) => reversed.every((w, j) => ws[i + j] === w));
        expect(checkQuote(reversed.join(" "), [target.text]).ok, "ترتیب معکوس").toBe(occurs);
        rejected++;
      }
    }
    expect(accepted).toBeGreaterThan(100);
    expect(rejected).toBeGreaterThan(100);
  });
});

describe("خاصیت: متن آزاد — استخراج، حکم و حذف در برابر اوراکل", () => {
  const toPersianDigits = (s: string): string => s.replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)] as string);

  it("متنِ ساخته‌شده از ارجاع‌های تصادفی: بازه‌ها، وضعیت‌ها، حکم‌ها و حذفِ بی‌نقص", () => {
    let mentionsTotal = 0;
    let rejectedTotal = 0;
    let acceptedTotal = 0;
    for (const seed of SEEDS) {
      const raw = genCorpus(seed);
      const index = indexOf(raw);
      const table = buildAliasTable(index);
      const r = rng(seed * 31 + 5);
      const dates = datesFor(raw);
      for (let round = 0; round < 12; round++) {
        const date = pick(r, dates);
        type Expect = { text: string; status: "resolved" | "unknown-document"; code: VerdictCode | null };
        const exps: Expect[] = [];
        let text = "";
        const n = int(r, 1, 5);
        for (let k = 0; k < n; k++) {
          const doc = pick(r, raw.documents);
          const art = pick(r, doc.articles);
          const known = r() < 0.8;
          const num = (s: string): string => (r() < 0.5 ? toPersianDigits(s) : s);
          const label = art.label === "واحده" ? "واحده" : num(art.label).replace("مکرر", "مکرر");
          const sub = r() < 0.4 ? pick(r, [{ kind: "note", label: "1", word: "تبصره" }, { kind: "note", label: "2", word: "تبصره" }, { kind: "clause", label: "الف", word: "بند" }, { kind: "clause", label: "ب", word: "بند" }] as const) : null;
          const articleWord = art.label !== "واحده" && r() < 0.15 ? "اصل" : "ماده";
          const articlePart = `${articleWord} ${label}`.replace("اصل واحده", "ماده واحده");
          const subPart = sub === null ? "" : `${sub.word} ${sub.word === "تبصره" ? num(sub.label) : sub.label} `;
          if (known) {
            const claim: CitationClaim = { ref: { documentId: doc.id, article: art.label, subpart: sub === null ? null : { kind: sub.kind, label: sub.label } } };
            const cite = `${subPart}${articlePart.replace("اصل واحده", "ماده واحده")} ${doc.title}`;
            exps.push({ text: cite, status: "resolved", code: oracle(raw, claim, date) });
            text += `${pick(r, FILLER)} ${cite}${pick(r, [" و ", "، ", ". ", " "])}`;
          } else {
            const unknownTitle = "قانون نمونهٔ ناموجود";
            const cite = `${subPart}${articlePart} قانون`;
            exps.push({ text: cite, status: "unknown-document", code: null });
            text += `${pick(r, FILLER)} ${cite} ${unknownTitle.replace("قانون ", "")}${pick(r, [" و ", "، ", ". "])}`;
          }
        }
        text += pick(r, FILLER);

        const mentions = extractMentions(text, table);
        expect(mentions.map((m) => m.text), `${seed}/${round}: ${text}`).toEqual(exps.map((e) => e.text));
        expect(mentions.map((m) => m.status)).toEqual(exps.map((e) => e.status));
        for (const m of mentions) expect(text.slice(m.start, m.end)).toBe(m.text);

        const check = checkText(index, text, date);
        check.mentions.forEach((cm, i) => {
          const e = exps[i] as Expect;
          expect(cm.verdict?.code ?? null).toBe(e.code);
          expect(cm.accepted).toBe(e.code === "valid");
        });
        mentionsTotal += mentions.length;
        const redacted = redactRejected(text, check);
        expect(redacted.ok).toBe(true);
        if (!redacted.ok) continue;
        // سلامت: پس از حذف هیچ ارجاعِ ردشونده‌ای نمی‌ماند؛ پایداری: دوباره حذف چیزی را عوض نمی‌کند.
        const again = checkText(index, redacted.value, date);
        expect(again.ok, `${seed}/${round}: ${redacted.value}`).toBe(true);
        expect(redactRejected(redacted.value, again)).toEqual({ ok: true, value: redacted.value });
        // کامل‌بودن: هر ارجاعِ پذیرفته‌شده در خروجی مانده و هر ردشده رفته است.
        expect(redacted.value.split(DEFAULT_REDACTION).length - 1).toBe(check.rejected.length);
        check.mentions.forEach((cm) => {
          if (cm.accepted) {
            expect(redacted.value).toContain(cm.mention.text);
            acceptedTotal++;
          } else rejectedTotal++;
        });
      }
    }
    expect(mentionsTotal).toBeGreaterThan(500);
    expect(acceptedTotal).toBeGreaterThan(50);
    expect(rejectedTotal).toBeGreaterThan(50);
  });

  it("پایداری: متن دلخواهِ تصادفی (واژه‌های ارجاع‌گونه و نشانه‌گذاری) هرگز پرتاب نمی‌کند و پس از حذف سبز می‌شود", () => {
    const pieces = ["ماده", "مواد", "اصل", "تبصره", "بند", "مکرر", "واحده", "قانون", "از", "و", "تا", "۱", "۲", "10", "۰", "الف", "ب", "،", ".", "(", ")", "«", "»", "آبی", "سبز", "\u200c", " ", "  ", "؛", "قانون آبی سبز"];
    for (const seed of SEEDS.slice(0, 15)) {
      const raw = genCorpus(seed);
      const index = indexOf(raw);
      const r = rng(seed ^ 0xabc);
      for (let k = 0; k < 120; k++) {
        const text = Array.from({ length: int(r, 0, 25) }, () => pick(r, pieces)).join(r() < 0.5 ? " " : "");
        const date = pick(r, datesFor(raw));
        const check = checkText(index, text, date);
        for (const cm of check.mentions) {
          expect(text.slice(cm.mention.start, cm.mention.end)).toBe(cm.mention.text);
          if (cm.mention.status !== "resolved") expect(cm.accepted).toBe(false);
        }
        const red = redactRejected(text, check);
        expect(red.ok, text).toBe(true);
        if (red.ok) expect(checkText(index, red.value, date).ok, `${JSON.stringify(text)} → ${JSON.stringify(red.value)}`).toBe(true);
      }
    }
  });
});

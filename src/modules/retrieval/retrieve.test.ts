import { describe, expect, it } from "vitest";
import { searchKey } from "@/modules/persian-text";
import { fakeSearcher, words, type FakeArticle } from "./fake-searcher";
import { comparePassages, passageKey } from "./rank";
import { planRelaxation } from "./query";
import { DEFAULTS, parseRequest, retrieve } from "./retrieve";
import type { Retrieval } from "./types";

const art = (n: string, text: string, extra: Partial<FakeArticle> = {}): FakeArticle => ({ documentId: "law-a", article: n, validFrom: "2001-01-01", validTo: null, text, verified: true, ...extra });
const ok = async (s: ReturnType<typeof fakeSearcher>, req: unknown): Promise<Retrieval> => {
  const r = await retrieve(s, req);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};
const refs = (r: Retrieval): string[] => r.passages.map((p) => `${p.ref.documentId}/${p.ref.article}`);

const corpus: FakeArticle[] = [
  art("1", "فروشنده مکلف است مبیع را تحویل دهد."),
  art("2", "خریدار مکلف است ثمن را بپردازد."),
  art("3", "تحویل مبیع در محل عقد انجام می‌شود.", { verified: false }),
  art("4", "هزینهٔ تحویل بر عهدهٔ فروشنده است.", { subparts: [{ kind: "note", label: "1", text: "مبیع باید سالم باشد." }] }),
];

describe("retrieval · parseRequest", () => {
  it("پیش‌فرض‌ها: فقط تأییدشده، limit=10، maxTerms=8، minCoverage=0.6، maxQueries=12", () => {
    const r = parseRequest({ question: "ثمن", asOf: "2024-03-01" });
    expect(r).toEqual({ ok: true, value: { question: "ثمن", asOf: "2024-03-01", verifiedOnly: true, documentId: null, limit: 10, maxTerms: 8, minCoverage: 0.6, maxQueries: 12 } });
    expect(DEFAULTS).toMatchObject({ limit: 10, maxTerms: 8, minCoverage: 0.6, maxQueries: 12 });
  });

  it("ورودی نامعتبر INVALID_INPUT؛ کلید ناشناخته (غلط املایی) رد؛ مرزهای عددی دقیق", () => {
    const base = { question: "ثمن", asOf: "2024-03-01" };
    const bad: unknown[] = [null, "x", [], 1, {}, { question: "x" }, { asOf: "2024-03-01" }, { question: 5, asOf: "2024-03-01" }, { question: "x", asOf: 20240301 },
      { ...base, verifiedonly: false }, { ...base, verifiedOnly: "false" }, { ...base, verifiedOnly: 0 }, { ...base, documentId: "" }, { ...base, documentId: 5 },
      { ...base, limit: 0 }, { ...base, limit: 101 }, { ...base, limit: 1.5 }, { ...base, limit: "5" },
      { ...base, maxTerms: 0 }, { ...base, maxTerms: 13 }, { ...base, maxQueries: 0 }, { ...base, maxQueries: 65 },
      { ...base, minCoverage: 0 }, { ...base, minCoverage: 1.01 }, { ...base, minCoverage: -1 }, { ...base, minCoverage: Number.NaN }, { ...base, minCoverage: "0.5" }];
    for (const b of bad) {
      const r = parseRequest(b);
      expect(r.ok, JSON.stringify(b)).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
    }
    for (const good of [{ limit: 1 }, { limit: 100 }, { maxTerms: 1 }, { maxTerms: 12 }, { maxQueries: 1 }, { maxQueries: 64 }, { minCoverage: 1 }, { minCoverage: 0.01 }, { verifiedOnly: false }, { documentId: "law-a" }]) {
      expect(parseRequest({ ...base, ...good }).ok, JSON.stringify(good)).toBe(true);
    }
  });
});

describe("retrieval · retrieve (ذخیره‌گاه ساختگی هم‌معنا با store)", () => {
  it("asOf و پیش‌فرض ایمنِ verifiedOnly=true بی‌تغییر به ذخیره‌گاه می‌رسد؛ documentId فقط وقتی هست", async () => {
    const s = fakeSearcher(corpus);
    await ok(s, { question: "تحویل مبیع", asOf: "2024-03-01", limit: 7 });
    expect(s.calls[0]).toEqual({ text: "تحویل مبیع", asOf: "2024-03-01", verifiedOnly: true, limit: 7 });
    expect("documentId" in (s.calls[0] ?? {})).toBe(false);
    const s2 = fakeSearcher(corpus);
    await ok(s2, { question: "تحویل مبیع", asOf: "2024-03-01", verifiedOnly: false, documentId: "law-a" });
    expect(s2.calls[0]).toMatchObject({ verifiedOnly: false, documentId: "law-a" });
  });

  it("تأییدنشده به‌طور پیش‌فرض نمی‌آید؛ با verifiedOnly:false می‌آید و verified:false دارد", async () => {
    const strict = await ok(fakeSearcher(corpus), { question: "تحویل مبیع", asOf: "2024-03-01", minCoverage: 1 });
    expect(refs(strict)).toEqual(["law-a/1", "law-a/4"]);
    expect(strict.passages.every((p) => p.verified)).toBe(true);
    const loose = await ok(fakeSearcher(corpus), { question: "تحویل مبیع", asOf: "2024-03-01", verifiedOnly: false, minCoverage: 1 });
    expect(refs(loose)).toEqual(["law-a/1", "law-a/3", "law-a/4"]);
    expect(loose.passages.find((p) => p.ref.article === "3")?.verified).toBe(false);
  });

  it("پرسش طبیعی با واژهٔ ربطی پیدا می‌شود؛ پوشش ۱ و ارجاع ساختاریافته آماده است", async () => {
    const r = await ok(fakeSearcher(corpus), { question: "آیا فروشنده مکلف به تحویل مبیع است؟", asOf: "2024-03-01" });
    expect(r.plan.tokens).toEqual(["فروشنده", "مکلف", "تحویل", "مبیع"]);
    expect(r.queriesRun).toBeGreaterThan(1); // AND کامل نتیجه‌ای ندارد (ماده ۱ «تحویل دهد» دارد ولی…)
    const p = r.passages[0];
    expect(p?.citation).toEqual({ documentId: "law-a", article: p?.ref.article, subpart: null });
  });

  it("آرام‌سازی: وقتی AND کامل خالی است، نتیجه‌های ناقص با coverage و واژهٔ گم‌شده برچسب می‌خورند و به ترتیب پوشش‌اند", async () => {
    const s = fakeSearcher([art("1", "الف ب ج"), art("2", "الف ب"), art("3", "الف د"), art("4", "ه و ز")]);
    const r = await ok(s, { question: "الفا بتا جیم", asOf: "2024-01-01" }); // هیچ واژه‌ای نیست؛ نمونهٔ بی‌نتیجه
    expect(r.passages).toEqual([]);
    const t = fakeSearcher([art("1", "الف ب ج"), art("2", "الف ب"), art("3", "الف د"), art("4", "ه و ز")]);
    const r2 = await ok(t, { question: "الف ب ج د", asOf: "2024-01-01", minCoverage: 0.5 });
    expect(refs(r2)).toEqual(["law-a/1", "law-a/2", "law-a/3"]);
    expect(r2.passages.map((p) => p.coverage)).toEqual([0.75, 0.5, 0.5]);
    expect(r2.passages[0]?.missingTerms).toEqual(["د"]);
    expect(r2.passages[1]?.matchedTerms).toEqual(["الف", "ب"]);
    expect(r2.relaxed).toBe(true);
  });

  it("ایستادن زودهنگام: اگر AND کامل به limit برسد فقط یک فراخوانی و relaxed=false", async () => {
    const s = fakeSearcher([art("1", "ثمن مبیع"), art("2", "ثمن مبیع تحویل"), art("3", "ثمن")]);
    const r = await ok(s, { question: "ثمن مبیع", asOf: "2024-01-01", limit: 2, minCoverage: 0.5 });
    expect(s.calls).toHaveLength(1);
    expect(r.relaxed).toBe(false);
    expect(refs(r)).toEqual(["law-a/1", "law-a/2"]);
    expect(r.budgetExhausted).toBe(false);
  });

  it("سطح بعدی فقط وقتی باز می‌شود که سطح پیشین کم بیاورد (limit=2: یک نتیجهٔ کامل + سطح یک‌کمتر)", async () => {
    const s = fakeSearcher([art("1", "الف ب ج"), art("2", "الف ب"), art("3", "ب ج"), art("4", "الف ج"), art("5", "ج")]);
    const r = await ok(s, { question: "الف ب ج", asOf: "2024-01-01", limit: 2, minCoverage: 0.3 });
    expect(r.passages.map((p) => p.coverage)).toEqual([1, 2 / 3]);
    expect(s.calls.every((c) => words(c.text).length >= 2)).toBe(true); // به سطح تک‌واژه نرسید
  });

  it("بودجهٔ فراخوانی: budgetExhausted وقتی سقف جلوی گونه‌ها را بگیرد، و نه وقتی همه اجرا شد", async () => {
    const data = [art("1", "الف")];
    const s = fakeSearcher(data);
    const cut = await ok(s, { question: "الف ب ج د ه", asOf: "2024-01-01", maxQueries: 3, minCoverage: 0.2 });
    expect(s.calls).toHaveLength(3);
    expect(cut.queriesRun).toBe(3);
    expect(cut.budgetExhausted).toBe(true);
    const s2 = fakeSearcher(data);
    const full = await ok(s2, { question: "الف ب ج", asOf: "2024-01-01", maxQueries: 64, minCoverage: 0.3 });
    expect(full.budgetExhausted).toBe(false);
    expect(full.queriesRun).toBe(1 + 3 + 3);
  });

  it("سقف واژه‌ها: ذخیره‌گاه هرگز بیش از maxTerms واژه نمی‌گیرد و افتاده‌ها در plan.truncated هستند", async () => {
    const s = fakeSearcher([]);
    const r = await ok(s, { question: "الف ب ج د ه و ز ح ط ی ک ل م", asOf: "2024-01-01", maxTerms: 4 });
    expect(r.plan.tokens).toHaveLength(4);
    expect(r.plan.truncated.length).toBeGreaterThan(0);
    for (const c of s.calls) expect(words(c.text).length).toBeLessThanOrEqual(4);
  });

  it("budgetExhausted فقط وقتی سقفِ فراخوانی مانع شده؛ توقف به‌خاطر رسیدن به limit آن را روشن نمی‌کند", async () => {
    // ۵ واژه، minCoverage 0.6 ⇒ ۱۶ گونه؛ سقف ۳ ⇒ برنامه ناقص است، ولی AND کامل به limit=1 می‌رسد و سطح بعد باز نمی‌شود.
    const s = fakeSearcher([art("1", "الف ب ج د ه")]);
    const r = await ok(s, { question: "الف ب ج د ه", asOf: "2024-01-01", limit: 1, maxQueries: 3 });
    expect(s.calls).toHaveLength(1);
    expect(r.budgetExhausted).toBe(false);
    // همان برنامهٔ ناقص ولی نتیجهٔ کم ⇒ بودجه واقعاً مانع شده
    const t = fakeSearcher([art("1", "الف")]);
    expect((await ok(t, { question: "الف ب ج د ه", asOf: "2024-01-01", limit: 1, maxQueries: 3 })).budgetExhausted).toBe(true);
  });

  it("ترتیب: پوشش بیشتر بر امتیاز بیشتر پیشی می‌گیرد (سه واژهٔ یک‌بار‌آمده بالاتر از دو واژهٔ پرتکرار)", async () => {
    const s = fakeSearcher([art("1", "الف الف الف الف ب ب ب ب ب"), art("2", "الف ب ج")]);
    const r = await ok(s, { question: "الف ب ج", asOf: "2024-01-01", limit: 10, minCoverage: 0.6 });
    expect(refs(r)).toEqual(["law-a/2", "law-a/1"]);
    expect(r.passages.map((p) => [p.coverage, p.score])).toEqual([[1, 3], [2 / 3, 9]]);
  });

  it("hasMore: بیش از limit نتیجه، یا hasMore ذخیره‌گاه", async () => {
    const many = Array.from({ length: 5 }, (_, i) => art(String(i + 1), "ثمن"));
    expect((await ok(fakeSearcher(many), { question: "ثمن", asOf: "2024-01-01", limit: 3 })).hasMore).toBe(true);
    expect((await ok(fakeSearcher(many), { question: "ثمن", asOf: "2024-01-01", limit: 5 })).hasMore).toBe(false);
    expect((await ok(fakeSearcher(many), { question: "ثمن", asOf: "2024-01-01", limit: 3 })).passages).toHaveLength(3);
  });

  it("نمایهٔ کهنه: staleSkipped منتشر و incomplete=true؛ بدون آن false", async () => {
    const s = fakeSearcher(corpus);
    s.staleSkipped = 2;
    const r = await ok(s, { question: "ثمن", asOf: "2024-03-01" });
    expect(r).toMatchObject({ staleSkipped: 2, incomplete: true });
    s.staleSkipped = 0;
    expect(await ok(s, { question: "ثمن", asOf: "2024-03-01" })).toMatchObject({ staleSkipped: 0, incomplete: false });
  });

  it("خطای ذخیره‌گاه ⇒ STORE_ERROR با storeCode؛ پرتاب پورت ⇒ STORE_ERROR بی‌نشتِ جزئیات؛ هرگز پرتاب نمی‌کند", async () => {
    const s = fakeSearcher(corpus);
    s.failWith = { code: "NOT_MIGRATED", message: "پایگاه مهاجرت نشده" };
    const r = await retrieve(s, { question: "ثمن", asOf: "2024-03-01" });
    expect(r).toEqual({ ok: false, error: { code: "STORE_ERROR", message: "پایگاه مهاجرت نشده", storeCode: "NOT_MIGRATED" } });
    const t = fakeSearcher(corpus);
    t.throwOnCall = true;
    const r2 = await retrieve(t, { question: "ثمن", asOf: "2024-03-01" });
    expect(r2.ok).toBe(false);
    expect(JSON.stringify(r2)).not.toContain("SENSITIVE_MARKER_91c2");
    expect(r2).toMatchObject({ ok: false, error: { code: "STORE_ERROR" } });
  });

  it("asOf نامعتبر را ذخیره‌گاه رد می‌کند و به‌صورت خطا برمی‌گردد؛ پرسش خالی EMPTY_QUERY و بدون فراخوانی", async () => {
    const s = fakeSearcher(corpus);
    const r = await retrieve(s, { question: "آیا؟", asOf: "2024-03-01" });
    expect(r).toMatchObject({ ok: false, error: { code: "EMPTY_QUERY" } });
    expect(s.calls).toHaveLength(0);
    const r2 = await retrieve(s, { question: "ثمن" });
    expect(r2).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(s.calls).toHaveLength(0);
  });

  it("اعتبار زمانی: فقط نسخهٔ معتبر در asOf (مرز نیم‌باز)", async () => {
    const s = () => fakeSearcher([art("1", "ثمن قدیم", { validFrom: "2001-01-01", validTo: "2010-01-01" }), art("1", "ثمن جدید", { validFrom: "2010-01-01" })]);
    expect((await ok(s(), { question: "ثمن", asOf: "2009-12-31" })).passages.map((p) => p.text)).toEqual(["ثمن قدیم"]);
    expect((await ok(s(), { question: "ثمن", asOf: "2010-01-01" })).passages.map((p) => p.text)).toEqual(["ثمن جدید"]);
    expect((await ok(s(), { question: "ثمن", asOf: "2000-12-31" })).passages).toEqual([]);
  });

  it("امتیاز و پوشش از متن + تبصره/بندها محاسبه می‌شود (همان تعریف store)", async () => {
    const r = await ok(fakeSearcher(corpus), { question: "تحویل مبیع فروشنده", asOf: "2024-03-01", minCoverage: 1 });
    const p = r.passages.find((x) => x.ref.article === "1");
    expect(p?.matchedTerms).toEqual(["تحویل", "مبیع", "فروشنده"]);
    expect(p?.score).toBe(3);
    const q = (await ok(fakeSearcher(corpus), { question: "مبیع سالم", asOf: "2024-03-01", minCoverage: 1 })).passages[0];
    expect(q?.ref.article).toBe("4"); // «مبیع سالم» فقط در تبصرهٔ ماده ۴ است
    expect(q?.coverage).toBe(1);
  });
});

// ───────── تست تفاضلی: retrieve ≡ اوراکل مستقلِ «همهٔ مواد با دست‌کم minTerms واژهٔ مطابق» ─────────
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)), pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T };
}

describe("retrieval · تفاضلی با اوراکل مستقل (۱۲۰ بذر)", () => {
  const vocab = ["ثمن", "مبیع", "تحویل", "فروشنده", "خریدار", "كتاب", "مکلف", "پرداخت", "مهلت", "عقد", "سالم", "محل", "۱۰", "قرارداد", "زیان"];
  const fillers = ["و", "در", "است", "به"];
  it("برای هر بذر: مجموعه و ترتیب درست، فراخوانی‌ها در سقف، فیلترها بی‌تغییر", () => {
    const problems: string[] = [];
    let full = 0;
    let cut = 0;
    const run = async () => {
      for (let seed = 1; seed <= 120; seed++) {
        const r = rng(seed);
        const articles: FakeArticle[] = [];
        const n = r.int(3, 30);
        for (let i = 0; i < n; i++) {
          const from = r.int(0, 3) === 0 ? "2010-01-01" : "2001-01-01";
          const to = from === "2001-01-01" && r.int(0, 3) === 0 ? "2010-01-01" : null;
          articles.push({
            documentId: r.pick(["law-a", "law-b"]),
            article: String(i + 1),
            validFrom: from,
            validTo: to,
            text: Array.from({ length: r.int(1, 9) }, () => (r.int(0, 4) === 0 ? r.pick(fillers) : r.pick(vocab))).join(" "),
            verified: r.int(0, 3) !== 0,
          });
        }
        const qWords = Array.from({ length: r.int(1, 9) }, () => (r.int(0, 3) === 0 ? r.pick(fillers) : r.pick(vocab).replace("كتاب", "کتاب")));
        const req = { question: qWords.join(" ") + (r.int(0, 1) ? " ؟" : ""), asOf: r.pick(["2005-05-05", "2010-01-01", "2024-01-01"]), verifiedOnly: r.int(0, 3) !== 0, limit: 100, minCoverage: r.pick([0.4, 0.6, 1]), maxQueries: 64 };
        const s = fakeSearcher(articles);
        const res = await retrieve(s, req);
        const tag = `seed=${seed} ${JSON.stringify(req)}`;
        if (!res.ok) {
          if (res.error.code !== "EMPTY_QUERY") problems.push(`${tag}: ${res.error.code}`);
          continue;
        }
        const v = res.value;
        const terms = v.plan.tokens;
        // اوراکل: مواد معتبر/مجاز با دست‌کم minTerms واژهٔ مطابق
        const minTerms = Math.min(terms.length, Math.max(1, Math.ceil(terms.length * req.minCoverage - 1e-9)));
        const expected = articles
          .filter((a) => a.validFrom <= req.asOf && (a.validTo === null || req.asOf < a.validTo) && (!req.verifiedOnly || a.verified))
          .map((a) => {
            const w = words(a.text);
            const matched = terms.filter((t) => w.includes(t));
            return { a, matched: matched.length, score: terms.reduce((sum, t) => sum + w.filter((x) => x === t).length, 0) };
          })
          .filter((x) => x.matched >= minTerms)
          .sort((x, y) => y.matched - x.matched || y.score - x.score || (x.a.documentId < y.a.documentId ? -1 : x.a.documentId > y.a.documentId ? 1 : 0) || Number(x.a.article) - Number(y.a.article));
        const got = v.passages.map((p) => passageKey(p.ref));
        const want = expected.map((x) => passageKey({ documentId: x.a.documentId, article: x.a.article, validFrom: x.a.validFrom }));
        // سقف بودجه فقط وقتی دست می‌زند که شمار گونه‌ها از maxQueries بیشتر باشد؛ و همیشه صادقانه گزارش می‌شود.
        const budgetCut = !planRelaxation(terms, { minCoverage: req.minCoverage, maxQueries: req.maxQueries }).complete;
        if (v.budgetExhausted !== budgetCut) problems.push(`${tag}: budgetExhausted=${v.budgetExhausted} ولی انتظار ${budgetCut}`);
        if (!budgetCut) {
          if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`${tag}: مجموعه/ترتیب\n got=${got.join(",")}\nwant=${want.join(",")}`);
          full++;
        } else {
          // با بودجهٔ ناقص: هیچ نتیجهٔ نادرست (زیرمجموعهٔ اوراکل)، فقط ممکن است کم‌تر باشد
          for (const g of got) if (!want.includes(g)) problems.push(`${tag}: نتیجهٔ بیرون از اوراکل ${g}`);
          cut++;
        }
        for (const c of s.calls) {
          if (c.asOf !== req.asOf || c.verifiedOnly !== req.verifiedOnly) problems.push(`${tag}: فیلتر تغییر کرد`);
          if (words(c.text).length > DEFAULTS.maxTerms) problems.push(`${tag}: بیش از maxTerms`);
          if (!words(c.text).every((t) => terms.includes(t))) problems.push(`${tag}: واژهٔ بیرون از برنامه`);
        }
        for (let i = 1; i < v.passages.length; i++) if (comparePassages(v.passages[i - 1] as never, v.passages[i] as never) > 0) problems.push(`${tag}: ترتیب`);
        for (const p of v.passages) {
          if (p.coverage !== p.matchedTerms.length / terms.length) problems.push(`${tag}: coverage`);
          if (p.matchedTerms.length + p.missingTerms.length !== terms.length) problems.push(`${tag}: افراز واژه‌ها`);
          if (req.verifiedOnly && !p.verified) problems.push(`${tag}: تأییدنشده با verifiedOnly`);
          for (const t of terms) if (searchKey(t) !== t) problems.push(`${tag}: واژهٔ نرمال‌نشده`);
        }
      }
    };
    return run().then(() => {
      expect(problems.slice(0, 5)).toEqual([]);
      // هر دو شاخه واقعاً دیده شده‌اند (آزمون تهی نیست)
      expect(full).toBeGreaterThan(40);
      expect(cut).toBeGreaterThan(3);
    });
  });
});

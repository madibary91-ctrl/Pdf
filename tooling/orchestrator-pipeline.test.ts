/**
 * قرارداد میان‌ماژولی «ai-orchestrator ← retrieval + citation-verifier + ai-gateway» روی PostgreSQL **واقعی** (ADR-0016).
 * این‌جا (tooling/) است چون ماژول ارکستراتور به `legal-kb-schema`/`legal-kb-store` اعلام وابستگی ندارد و فقط از طریق پورت‌ها
 * (Searcher = خودِ KbStore، CitationChecker با نمایهٔ ساخته‌شده از store) به آن‌ها وصل می‌شود.
 *
 * ادعا: هر آنچه ارکستراتور به‌عنوان «متن پاسخ» برمی‌گرداند، راستی‌آزمای **مستقل** هم می‌پذیرد — حتی وقتی مدل ارجاع جعلی،
 * نقل‌قول ساختگی، بند تأییدنشده، نشانهٔ مخدوش یا ارجاع آزادِ نامعتبر بیاورد.
 */
import { randomBytes } from "node:crypto";
import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGateway, type ModelProvider, type ProviderCall } from "@/modules/ai-gateway";
import { createCitationChecker, createOrchestrator, ERROR_CODES, scanMarkers, type Answer, type AnswerPolicy, type Orchestrator } from "@/modules/ai-orchestrator";
import { checkText, MIN_QUOTE_CHARS, verifyCitations } from "@/modules/citation-verifier";
import { buildCorpusIndex, loadCorpus } from "@/modules/legal-kb-schema";
import { auditSchemaName, createKbStore, searchSchemaName, type KbStore } from "@/modules/legal-kb-store";

config({ quiet: true });
const URL_ = process.env["KB_TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
const dbDescribe = typeof URL_ === "string" && URL_ !== "" ? describe : describe.skip;

const prov = (verified: boolean) => ({
  sourceName: "منبع ساختگی",
  sourceUrl: null,
  sourceKind: verified ? "official" : "secondary",
  retrievedOn: "2025-01-10",
  review: verified ? { status: "legally-verified", reviewedBy: "بازبین فرضی", reviewedOn: "2025-02-01" } : { status: "pending-legal-review", reviewedBy: null, reviewedOn: null },
});
const version = (validFrom: string, validTo: string | null, text: string, verified: boolean) => ({ validFrom, validTo, text, subparts: [], provenance: prov(verified) });
const T1_OLD = "فروشنده مکلف است مبیع را در محل عقد تحویل دهد.";
const T1_NEW = "فروشنده مکلف است مبیع را در مهلت مقرر تحویل دهد.";
const T2 = "خریدار مکلف است ثمن را در مهلت مقرر بپردازد.";
const CORPUS = {
  documents: [
    {
      id: "law-a",
      kind: "statute",
      title: "قانون ساختگی الف",
      shortTitle: null,
      enactedOn: null,
      provenance: prov(false),
      articles: [
        { label: "1", versions: [version("2001-01-01", "2010-01-01", T1_OLD, true), version("2010-01-01", null, T1_NEW, false)] },
        { label: "2", versions: [version("2001-01-01", null, T2, true)] },
        { label: "3", versions: [version("2001-01-01", null, "تحویل مبیع و پرداخت ثمن همزمان انجام می‌شود.", false)] },
      ],
    },
    {
      id: "law-b",
      kind: "statute",
      title: "قانون ساختگی ب",
      shortTitle: null,
      enactedOn: null,
      provenance: prov(false),
      articles: [{ label: "1", versions: [version("2001-01-01", null, "ضمانت اجرای ساختگی برای تخلف است.", true)] }],
    },
  ],
  relations: [],
  rulings: [],
};

const Q_SELLER = "فروشنده مکلف به تحویل مبیع در محل عقد";
const Q_BUYER = "خریدار مکلف ثمن مهلت";
const POLICIES: AnswerPolicy[] = [
  { onRejectedCitation: "withhold", requireQuotes: true },
  { onRejectedCitation: "withhold", requireQuotes: false },
  { onRejectedCitation: "redact", requireQuotes: true },
  { onRejectedCitation: "redact", requireQuotes: false },
];

dbDescribe("pipeline · ai-orchestrator ← retrieval + citation-verifier + ai-gateway (PostgreSQL واقعی)", () => {
  let pool: Pool;
  let store: KbStore;
  let schema: string;
  let index: ReturnType<typeof buildCorpusIndex>;
  let indexCalls = 0;
  let indexFails = false;
  const provider: ModelProvider & { calls: ProviderCall[]; next: { text: string; finishReason: "stop" | "length" | "content_filter" | "other" } } = {
    calls: [],
    next: { text: "", finishReason: "stop" },
    async complete(call) {
      provider.calls.push(call);
      return { text: provider.next.text, finishReason: provider.next.finishReason, usage: { inputTokens: 100, outputTokens: 50 } };
    },
  };
  const orchestrators = new Map<string, Orchestrator>();
  const orchestratorFor = (p: AnswerPolicy): Orchestrator => orchestrators.get(`${p.onRejectedCitation}/${p.requireQuotes}`) as Orchestrator;

  beforeAll(async () => {
    schema = `legal_kb_test_${randomBytes(5).toString("hex")}`;
    pool = new Pool({ connectionString: URL_, max: 4 });
    const made = createKbStore(drizzle(pool), { schema });
    if (!made.ok) throw new Error(made.error.message);
    store = made.value;
    for (const step of [() => store.migrate(), () => store.insertCorpus(CORPUS), () => store.migrateSearch(), () => store.reindexSearch()]) {
      const r = await step();
      if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    }
    const read = await store.readCorpus();
    if (!read.ok) throw new Error(read.error.message);
    const loaded = loadCorpus(JSON.parse(JSON.stringify(read.value)));
    if (!loaded.ok) throw new Error("corpus از store بازاعتبارسنجی نشد");
    index = buildCorpusIndex(loaded.value);

    const gw = createGateway({
      providers: { main: provider },
      models: { "legal-chat": { provider: "main", providerModel: "m", maxInputChars: 60_000, maxOutputTokens: 4096, price: { currency: "IRR", inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, version: "test-prices-1" } } },
      clock: { nowMs: () => Date.now() },
    });
    if (!gw.ok) throw new Error(gw.error.code);
    const checker = createCitationChecker({
      current: () => {
        indexCalls++;
        if (indexFails) throw new Error("index unavailable");
        return index;
      },
    });
    for (const policy of POLICIES) {
      const o = createOrchestrator({ searcher: store, gateway: gw.value, checker, policy });
      if (!o.ok) throw new Error(o.error.code);
      orchestrators.set(`${policy.onRejectedCitation}/${policy.requireQuotes}`, o.value);
    }
  });

  afterAll(async () => {
    if (!schema.startsWith("legal_kb_test_")) throw new Error("امتناع از حذف شِمایی که آزمونی نیست.");
    const db = drizzle(pool);
    for (const s of [schema, auditSchemaName(schema), searchSchemaName(schema)]) await db.execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(s)} CASCADE`);
    await pool.end();
  });

  const ask = async (policy: AnswerPolicy, modelText: string, asOf: string, question: string, extra: Record<string, unknown> = {}) => {
    provider.next = { text: modelText, finishReason: "stop" };
    return orchestratorFor(policy).ask({ question, asOf, model: "legal-chat", maxOutputTokens: 800, retrieval: { maxQueries: 1 }, ...extra });
  };
  const STRICT = POLICIES[0] as AnswerPolicy;
  const REDACT_LAX = POLICIES[3] as AnswerPolicy;
  const answerOf = (r: Awaited<ReturnType<typeof ask>>): Answer => {
    if (!r.ok) throw new Error(`${r.error.code}`);
    return r.value;
  };
  /** راستی‌آزمای مستقل (همان ماژول، بدون واسطهٔ ارکستراتور). */
  const independentlyValid = (a: Answer, asOf: string): boolean => {
    const claims = a.citations.flatMap((c) => (c.quotes.length === 0 ? [{ ref: { documentId: c.documentId, article: c.article, subpart: null } }] : c.quotes.map((q) => ({ ref: { documentId: c.documentId, article: c.article, subpart: null }, quote: q }))));
    return verifyCitations(index, claims, asOf).allAccepted && (a.text === null || checkText(index, a.text, asOf).ok);
  };

  it("مسیر خوب (۲۰۰۵): نسخهٔ قدیمی به مدل می‌رسد، نقل‌قول درست پذیرفته و متن نهایی از راستی‌آزمای مستقل می‌گذرد", async () => {
    provider.calls.length = 0;
    const a = answerOf(await ask(STRICT, JSON.stringify({ answer: "فروشنده باید مبیع را تحویل دهد [S1].", citations: [{ source: "S1", quote: "مبیع را در محل عقد" }] }), "2005-05-05", Q_SELLER));
    expect(a).toMatchObject({ status: "answered", text: "فروشنده باید مبیع را تحویل دهد [S1]." });
    expect(a.citations).toMatchObject([{ id: "S1", documentId: "law-a", article: "1", quotes: ["مبیع را در محل عقد"] }]);
    const prompt = provider.calls[0]?.messages[1]?.content ?? "";
    expect(prompt).toContain(T1_OLD);
    expect(prompt).not.toContain(T1_NEW);
    expect(independentlyValid(a, "2005-05-05")).toBe(true);
    expect(a.accounting).toMatchObject({ source: "completion", spend: [{ currency: "IRR", micros: 200 }] });
  });

  it("نقل‌قول از نسخهٔ دیگر (۲۰۱۰ در تاریخ ۲۰۰۵) ⇒ quote-mismatch ⇒ withheld", async () => {
    const a = answerOf(await ask(STRICT, JSON.stringify({ answer: "فروشنده [S1].", citations: [{ source: "S1", quote: "مبیع را در مهلت مقرر تحویل دهد" }] }), "2005-05-05", Q_SELLER));
    expect(a).toMatchObject({ status: "withheld", text: null, withheldReason: "no-valid-citation" });
    expect(a.rejections.map((r) => r.code)).toEqual(["quote-mismatch"]);
  });

  it("۲۰۲۴: بند ماده ۱ تأییدنشده است ⇒ بازیابی نمی‌کند ⇒ no-sources و مدل فراخوانی نمی‌شود", async () => {
    provider.calls.length = 0;
    const a = answerOf(await ask(STRICT, "{}", "2024-01-01", Q_SELLER));
    expect(a).toMatchObject({ status: "no-sources", text: null, generation: null, accounting: null });
    expect(provider.calls).toHaveLength(0);
  });

  it("نقل‌قول ماده ۲ در ۲۰۲۴ پذیرفته می‌شود؛ بند تأییدنشدهٔ ماده ۳ هرگز در زمینه نیست", async () => {
    provider.calls.length = 0;
    const a = answerOf(await ask(STRICT, JSON.stringify({ answer: "خریدار باید بپردازد [S1].", citations: [{ source: "S1", quote: "ثمن را در مهلت مقرر بپردازد" }] }), "2024-01-01", Q_BUYER));
    expect(a.status).toBe("answered");
    expect(a.citations[0]).toMatchObject({ documentId: "law-a", article: "2" });
    expect(provider.calls[0]?.messages[1]?.content).not.toContain("همزمان انجام می‌شود");
    expect(independentlyValid(a, "2024-01-01")).toBe(true);
  });

  it("ارجاع آزاد در متن: معتبر می‌ماند، تأییدنشده/ناموجود/بی‌نام حذف می‌شود (واقعی)", async () => {
    const text = "الف ماده ۲ قانون ساختگی الف [S1] ب ماده ۱ قانون ساختگی الف ج ماده ۷ قانون ساختگی الف د ماده ۱ قانون ناموجود ه ماده ۱۰";
    const a = answerOf(await ask(REDACT_LAX, JSON.stringify({ answer: text, citations: [] }), "2024-01-01", Q_BUYER));
    expect(a.status).toBe("answered-redacted");
    expect(a.text).toContain("ماده ۲ قانون ساختگی الف [S1]");
    expect(a.text).not.toContain("ماده ۱ قانون ساختگی الف");
    expect(a.text).not.toContain("ماده ۷");
    expect(a.text).not.toContain("قانون ناموجود");
    expect(a.text).not.toContain("ماده ۱۰");
    expect(a.rejections.filter((r) => r.kind === "mention").map((r) => r.code).sort()).toEqual(["no-document", "unknown-article", "unknown-document", "unverified-source"].sort());
    expect(independentlyValid(a, "2024-01-01")).toBe(true);
  });

  it("documentId درخواست، سند پیش‌فرض نگهبان می‌شود («ماده ۲» بی‌نام قانون)", async () => {
    const withDoc = answerOf(await ask(REDACT_LAX, JSON.stringify({ answer: "طبق ماده ۲ [S1]" }), "2024-01-01", Q_BUYER, { documentId: "law-a" }));
    expect(withDoc).toMatchObject({ status: "answered", text: "طبق ماده ۲ [S1]" });
    const without = answerOf(await ask(REDACT_LAX, JSON.stringify({ answer: "طبق ماده ۲ [S1]" }), "2024-01-01", Q_BUYER));
    expect(without.status).toBe("answered-redacted");
  });

  it("نمایهٔ راستی‌آزمایی به‌ازای هر درخواست گرفته می‌شود؛ ناموجود بودنش پیش از هزینه شکست می‌خورد", async () => {
    const before = indexCalls;
    await ask(STRICT, JSON.stringify({ answer: "x [S1]", citations: [{ source: "S1", quote: "ثمن را در مهلت مقرر" }] }), "2024-01-01", Q_BUYER);
    await ask(STRICT, JSON.stringify({ answer: "x [S1]", citations: [{ source: "S1", quote: "ثمن را در مهلت مقرر" }] }), "2024-01-01", Q_BUYER);
    expect(indexCalls - before).toBe(2);
    provider.calls.length = 0;
    indexFails = true;
    try {
      const r = await ask(STRICT, "{}", "2024-01-01", Q_BUYER);
      expect(r).toMatchObject({ ok: false, error: { code: "VERIFIER_UNAVAILABLE", retryable: true } });
      expect(provider.calls).toHaveLength(0);
    } finally {
      indexFails = false;
    }
  });

  it("سیاست‌ها روی پایگاه واقعی: شناسهٔ جعلی کنار ارجاع معتبر", async () => {
    const out = JSON.stringify({ answer: "الف [S1] ب [S9]", citations: [{ source: "S1", quote: "ثمن را در مهلت مقرر" }, { source: "S9", quote: "ثمن را در مهلت مقرر" }] });
    expect(answerOf(await ask(POLICIES[0] as AnswerPolicy, out, "2024-01-01", Q_BUYER))).toMatchObject({ status: "withheld", withheldReason: "citation-rejected", text: null });
    const red = answerOf(await ask(POLICIES[2] as AnswerPolicy, out, "2024-01-01", Q_BUYER));
    expect(red).toMatchObject({ status: "answered-redacted", citations: [{ id: "S1" }] });
    expect(red.text).toContain("[ارجاع نامعتبر حذف شد]");
  });

  it("آداپتور واقعی مستقیم: سیاست سخت (بند تأییدنشده پذیرفته نمی‌شود) و نگهبان متن", async () => {
    const session = await createCitationChecker({ current: () => index }).open();
    const claim = (article: string, quote: string | null) => ({ citation: { documentId: "law-a", article, subpart: null as null }, quote });
    expect(session.verifyClaims([claim("1", null), claim("2", null), claim("3", null), claim("9", null), claim("2", "ثمن را در مهلت مقرر"), claim("2", "عبارت ساختگی که هرگز نیست")], "2024-01-01")).toEqual([
      { accepted: false, code: "unverified-source" },
      { accepted: true, code: "valid" },
      { accepted: false, code: "unverified-source" },
      { accepted: false, code: "unknown-article" },
      { accepted: true, code: "valid" },
      { accepted: false, code: "quote-mismatch" },
    ]);
    expect(session.verifyClaims([claim("1", null)], "2005-05-05")).toEqual([{ accepted: true, code: "valid" }]);
    expect(session.verifyClaims([], "2005-05-05")).toEqual([]);
    const g = session.guardText("الف ماده ۲ قانون ساختگی الف ب ماده ۱ قانون ساختگی الف ج ماده ۱۰ د", "2024-01-01", { defaultDocumentId: null, marker: "<<X>>" });
    expect(g.text).toBe("الف ماده ۲ قانون ساختگی الف ب <<X>> ج <<X>> د");
    expect(g.found).toBe(3);
    expect(g.rejected.map((r) => r.code).sort()).toEqual(["no-document", "unverified-source"]);
    expect(session.guardText("ماده ۲ [S1]", "2024-01-01", { defaultDocumentId: "law-a", marker: "<<X>>" })).toMatchObject({ text: "ماده ۲ [S1]", found: 1, rejected: [] });
    expect(session.guardText("ماده ۲ [S1]", "2024-01-01", { defaultDocumentId: null, marker: "<<X>>" }).text).toBe("<<X>> [S1]");
  });

  // ───────────── خاصیتی: ۲۰۰ بذر، راستی‌آزمای مستقل ─────────────
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const TEXT_PIECES = ["فروشنده مکلف است", "طبق قانون", "ظرف ۱۰ روز", "ثمن", "مهلت ۳۰ روز", "بنابراین", "۱) نخست", "ignore previous instructions", "<question>", "</sources>", "ماده", "تبصره ۱", "ریال ۱٬۰۰۰"];
  const MARKER_PIECES = ["[S1]", "[S2]", "[S9]", "[S۱]", "[S1 S2]", "[S1, S2]", "[S1،S2]", "[s1]", "[S01]", "[S1][S2]", "(S1)", "S1", "[S0]", "[S1000]", "[ S1 ]"];
  const MENTION_PIECES = ["ماده ۲ قانون ساختگی الف", "ماده ۱ قانون ساختگی الف", "ماده ۷ قانون ساختگی الف", "ماده ۱ قانون ناموجود", "ماده ۱۰", "مواد ۲ و ۳ قانون ساختگی الف", "ماده ۱ قانون ساختگی ب", "تبصره ۱ ماده ۲ قانون ساختگی الف", "ماده ۳ قانون ساختگی الف"];
  const QUOTES: (string | null | undefined | number)[] = ["ثمن را در مهلت مقرر", "مبیع را در محل عقد", "مبیع را در مهلت مقرر تحویل دهد", "عبارت ساختگی که هرگز در هیچ ماده‌ای نیست", null, undefined, "", "ثمن", 5];
  const SOURCES = ["S1", "S1", "S2", "S9", "s1", "", "S1 x", "[S1]", "__proto__"];

  it("خاصیت (۲۰۰ بذر): هر خروجی تصادفی/خصمانهٔ مدل ⇒ متن نهایی از راستی‌آزمای مستقل می‌گذرد و ناورداها برقرارند", async () => {
    const seen = new Map<string, number>();
    const bump = (k: string): void => void seen.set(k, (seen.get(k) ?? 0) + 1);
    expect(MIN_QUOTE_CHARS).toBeGreaterThan(0);
    for (let seed = 1; seed <= 200; seed++) {
      const r = mulberry32(seed);
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
      const asOf = r() < 0.5 ? "2005-05-05" : "2024-01-01";
      const question = asOf === "2005-05-05" ? pick([Q_SELLER, Q_BUYER]) : Q_BUYER;
      // حدود یک‌سوم بذرها «تقریباً پاک»اند (تا مسیر پذیرش هم واقعاً دیده شود)؛ بقیه کاملاً خصمانه.
      const mostlyClean = r() < 0.35;
      const goodQuote = question === Q_SELLER ? "مبیع را در محل عقد" : "ثمن را در مهلت مقرر";
      const CLEAN_PIECES = ["فروشنده مکلف است", "طبق این ماده", "ظرف ۱۰ روز", "بنابراین", "[S1]", "ماده ۲ قانون ساختگی الف"];
      const pieces = mostlyClean
        ? [...Array.from({ length: 1 + Math.floor(r() * 4) }, () => pick(CLEAN_PIECES)), "[S1]"]
        : Array.from({ length: 1 + Math.floor(r() * 8) }, () => pick([...TEXT_PIECES, ...MARKER_PIECES, ...MARKER_PIECES, ...MENTION_PIECES]));
      const citations = mostlyClean
        ? [{ source: "S1", quote: r() < 0.85 ? goodQuote : pick(QUOTES) }]
        : Array.from({ length: Math.floor(r() * 5) }, () => ({ source: pick(SOURCES), quote: pick(QUOTES) }));
      const body: Record<string, unknown> = { answer: pieces.join(" "), citations };
      if (!mostlyClean && r() < 0.1) body["insufficient"] = true;
      if (r() < 0.1) body["extra"] = 1;
      let modelText = JSON.stringify(body);
      const wrap = r();
      if (wrap < 0.1) modelText = "```json\n" + modelText + "\n```";
      else if (wrap < 0.15) modelText = pick(["", "نه JSON", "[1]", "{\"answer\":", modelText + " توضیح اضافه"]);
      const finishReason = r() < 0.9 ? "stop" : pick(["length", "content_filter", "other"] as const);
      const policy = pick(POLICIES);

      provider.calls.length = 0;
      provider.next = { text: modelText, finishReason };
      const res = await orchestratorFor(policy).ask({ question, asOf, model: "legal-chat", maxOutputTokens: 800, retrieval: { maxQueries: 1 } });
      const tag = `seed=${seed}`;

      if (!res.ok) {
        bump(`error:${res.error.code}`);
        expect(ERROR_CODES, tag).toContain(res.error.code);
        expect(["MODEL_OUTPUT_INVALID", "VERIFICATION_FAILED"].includes(res.error.code) ? res.error.accounting : "n/a", tag).not.toBeNull();
        expect(JSON.stringify(res.error), tag).not.toContain("ignore previous");
        continue;
      }
      const a = res.value;
      bump(`status:${a.status}`);
      if (a.status === "no-sources") expect(provider.calls, tag).toHaveLength(0);
      if (a.status === "withheld" || a.status === "model-abstained" || a.status === "no-sources") {
        expect(a.text, tag).toBeNull();
        expect(a.citations, tag).toEqual([]);
        continue;
      }
      // answered | answered-redacted
      const text = a.text as string;
      expect(a.citations.length, tag).toBeGreaterThanOrEqual(1);
      const sentCtx = provider.calls[0]?.messages[1]?.content ?? "";
      // (الف) هر شناسهٔ درون متن ∈ citations؛ نشانهٔ مخدوش نیست
      const ids = new Set(a.citations.map((c) => c.id));
      for (const m of scanMarkers(text)) {
        expect(m.ids, `${tag} malformed marker left: ${m.raw}`).not.toBeNull();
        for (const id of m.ids ?? []) expect(ids.has(id), `${tag} ${id}`).toBe(true);
      }
      // (ب،ج) راستی‌آزمای مستقل: هر ارجاع معتبر و متن نهایی از نگهبان می‌گذرد
      expect(independentlyValid(a, asOf), tag).toBe(true);
      // (د) ارجاع‌ها فقط به بندهای واقعاً فرستاده‌شده به مدل
      for (const c of a.citations) expect(sentCtx, `${tag} ${c.id}`).toContain(c.label);
      // (ه) بند تأییدنشده هرگز: ماده ۳ و نسخهٔ ۲۰۱۰ ماده ۱ در هیچ ارجاعی نیست
      for (const c of a.citations) expect(`${c.documentId}#${c.article}`, tag).not.toBe("law-a#3");
      if (asOf === "2024-01-01") for (const c of a.citations) expect(`${c.documentId}#${c.article}`, tag).not.toBe("law-a#1");
      // متن خصمانهٔ مدل جایی نشت نمی‌کند که نباید
      expect(JSON.stringify(a.rejections), tag).not.toMatch(/ignore previous|ماده ۱ قانون ناموجود/);
      if (policy.onRejectedCitation === "withhold") expect(a.rejections.length === 0 || a.status !== "answered-redacted", tag).toBe(true);
    }
    // ادعای پوشش: آزمون تهی نیست (هر مسیر مهم دیده شده)
    for (const must of ["status:answered", "status:answered-redacted", "status:withheld", "status:model-abstained", "error:MODEL_OUTPUT_INVALID"]) {
      expect(seen.get(must) ?? 0, `${must} — ${JSON.stringify([...seen])}`).toBeGreaterThan(0);
    }
  }, 120_000);
});

/**
 * ترمیم کنترل‌شده (ADR-0017) روی PostgreSQL **واقعی** با `retrieve` + `citation-verifier` + `createGateway` واقعی.
 * ادعای اصلی: ترمیم هیچ مسیرِ کوتاهی به خروجی نیست — هر آنچه نمایش داده می‌شود (چه تلاش نخست چه دوم) از راستی‌آزمای **مستقل**
 * هم می‌گذرد، حتی وقتی هر دو تلاش مدل خصمانه باشند؛ و هرگز بیش از دو تماس.
 */
import { randomBytes } from "node:crypto";
import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGateway, type ModelProvider, type ProviderCall } from "@/modules/ai-gateway";
import { createCitationChecker, createOrchestrator, idsOf, scanMarkers, type Answer, type AnswerPolicy, type Orchestrator } from "@/modules/ai-orchestrator";
import { checkText, verifyCitations } from "@/modules/citation-verifier";
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
  ],
  relations: [],
  rulings: [],
};

const Q_SELLER = "فروشنده مکلف به تحویل مبیع در محل عقد";
const Q_BUYER = "خریدار مکلف ثمن مهلت";
const POLICIES: AnswerPolicy[] = [
  { onRejectedCitation: "withhold", requireQuotes: true, repair: { maxFirstAttemptSpendMicros: 10_000, currency: "IRR" } },
  { onRejectedCitation: "withhold", requireQuotes: false, repair: { maxFirstAttemptSpendMicros: 10_000, currency: "IRR" } },
  { onRejectedCitation: "redact", requireQuotes: true, repair: { maxFirstAttemptSpendMicros: 10_000, currency: "IRR" } },
  { onRejectedCitation: "redact", requireQuotes: false, repair: { maxFirstAttemptSpendMicros: 10_000, currency: "IRR" } },
];

type Reply = { text: string; finishReason: "stop" | "length" };

dbDescribe("pipeline · ترمیم کنترل‌شده (PostgreSQL واقعی)", () => {
  let pool: Pool;
  let store: KbStore;
  let schema: string;
  let index: ReturnType<typeof buildCorpusIndex>;
  const queue: Reply[] = [];
  const provider: ModelProvider & { calls: ProviderCall[] } = {
    calls: [],
    async complete(call) {
      provider.calls.push(call);
      const next = queue.shift();
      if (next === undefined) throw new Error("script exhausted");
      return { text: next.text, finishReason: next.finishReason, usage: { inputTokens: 100, outputTokens: 50 } };
    },
  };
  const orchestrators = new Map<string, Orchestrator>();
  const key = (p: AnswerPolicy): string => `${p.onRejectedCitation}/${p.requireQuotes}`;

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
    const checker = createCitationChecker({ current: () => index });
    for (const policy of POLICIES) {
      const o = createOrchestrator({ searcher: store, gateway: gw.value, checker, policy });
      if (!o.ok) throw new Error(o.error.code);
      orchestrators.set(key(policy), o.value);
    }
  });

  afterAll(async () => {
    if (!schema.startsWith("legal_kb_test_")) throw new Error("امتناع از حذف شِمایی که آزمونی نیست.");
    const db = drizzle(pool);
    for (const s of [schema, auditSchemaName(schema), searchSchemaName(schema)]) await db.execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(s)} CASCADE`);
    await pool.end();
  });

  const ask = (policy: AnswerPolicy, replies: Reply[], asOf: string, question: string) => {
    queue.length = 0;
    queue.push(...replies);
    provider.calls.length = 0;
    return (orchestrators.get(key(policy)) as Orchestrator).ask({ question, asOf, model: "legal-chat", maxOutputTokens: 800, retrieval: { maxQueries: 1 } });
  };
  const stop = (obj: unknown): Reply => ({ text: typeof obj === "string" ? obj : JSON.stringify(obj), finishReason: "stop" });
  const answerOf = (r: Awaited<ReturnType<typeof ask>>): Answer => {
    if (!r.ok) throw new Error(`${r.error.code}`);
    return r.value;
  };
  const independentlyValid = (a: Answer, asOf: string): boolean => {
    const claims = a.citations.flatMap((c) => (c.quotes.length === 0 ? [{ ref: { documentId: c.documentId, article: c.article, subpart: null } }] : c.quotes.map((q) => ({ ref: { documentId: c.documentId, article: c.article, subpart: null }, quote: q }))));
    return verifyCitations(index, claims, asOf).allAccepted && (a.text === null || checkText(index, a.text, asOf).ok);
  };
  const STRICT = POLICIES[0] as AnswerPolicy;

  it("نقل‌قول از نسخهٔ دیگر ردّ، تلاش دوم با نقل‌قولِ درستِ همان تاریخ پذیرفته؛ پرامپت دوم همان زمینهٔ تاریخ‌دار + بازخورد", async () => {
    const wrong = stop({ answer: "فروشنده باید تحویل دهد [S1].", citations: [{ source: "S1", quote: "مبیع را در مهلت مقرر تحویل دهد" }] });
    const right = stop({ answer: "فروشنده باید مبیع را تحویل دهد [S1].", citations: [{ source: "S1", quote: "مبیع را در محل عقد" }] });
    const a = answerOf(await ask(STRICT, [wrong, right], "2005-05-05", Q_SELLER));
    expect(a).toMatchObject({ status: "answered", text: "فروشنده باید مبیع را تحویل دهد [S1]." });
    expect(a.repair).toEqual({ outcome: "adopted", trigger: "citation-rejected", attempts: 2, promptVersion: "qa-grounded-repair/1" });
    expect(provider.calls).toHaveLength(2);
    expect(independentlyValid(a, "2005-05-05")).toBe(true);
    const second = provider.calls[1]?.messages[1]?.content ?? "";
    expect(second).toContain(T1_OLD);
    expect(second).not.toContain(T1_NEW);
    expect(second).toContain("<feedback>");
    expect(second).not.toContain("مبیع را در مهلت مقرر تحویل دهد.</");
    expect(a.accounting).toMatchObject({ source: "completion", providerCalls: 2, spend: [{ currency: "IRR", micros: 400 }] });
  });

  it("هر دو تلاش ردشده ⇒ فقط دو تماس؛ هیچ متنی نمایش داده نمی‌شود؛ بدون نشت متن ردشده", async () => {
    const wrong = stop({ answer: "WRONG_ANSWER_73 [S1].", citations: [{ source: "S1", quote: "WRONG_QUOTE_74" }] });
    const a = answerOf(await ask(STRICT, [wrong, wrong, wrong], "2005-05-05", Q_SELLER));
    expect(a).toMatchObject({ status: "withheld", text: null, repair: { outcome: "not-improved", attempts: 2 } });
    expect(provider.calls).toHaveLength(2);
    expect(JSON.stringify(a)).not.toContain("WRONG_");
    expect(JSON.stringify(provider.calls[1]?.messages)).not.toContain("WRONG_");
  });

  it("امتناع مدل هرگز ترمیم نمی‌شود؛ بدون منبع (۲۰۲۴ برای ماده ۱) مدل اصلاً فراخوانی نمی‌شود", async () => {
    const abstain = answerOf(await ask(STRICT, [stop({ answer: "کافی نیست", insufficient: true })], "2005-05-05", Q_SELLER));
    expect(abstain).toMatchObject({ status: "model-abstained", repair: { outcome: "not-needed", attempts: 1 } });
    expect(provider.calls).toHaveLength(1);
    const none = answerOf(await ask(STRICT, [], "2024-01-01", Q_SELLER));
    expect(none).toMatchObject({ status: "no-sources", repair: { outcome: "not-needed", attempts: 0 } });
    expect(provider.calls).toHaveLength(0);
  });

  it("سقف هزینه روی هزینهٔ واقعیِ دروازه: سقف کمتر از ۲۰۰ ⇒ بی‌ترمیم", async () => {
    const gw = createGateway({
      providers: { main: provider },
      models: { "legal-chat": { provider: "main", providerModel: "m", maxInputChars: 60_000, maxOutputTokens: 4096, price: { currency: "IRR", inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, version: "p" } } },
      clock: { nowMs: () => Date.now() },
    });
    if (!gw.ok) throw new Error(gw.error.code);
    const o = createOrchestrator({ searcher: store, gateway: gw.value, checker: createCitationChecker({ current: () => index }), policy: { onRejectedCitation: "withhold", requireQuotes: true, repair: { maxFirstAttemptSpendMicros: 199, currency: "IRR" } } });
    if (!o.ok) throw new Error(o.error.code);
    queue.length = 0;
    queue.push(stop({ answer: "x [S1]", citations: [{ source: "S1", quote: "ساختگی" }] }), stop("unused"));
    provider.calls.length = 0;
    const r = await o.value.ask({ question: Q_SELLER, asOf: "2005-05-05", model: "legal-chat", maxOutputTokens: 800, retrieval: { maxQueries: 1 } });
    expect(answerOf(r).repair).toMatchObject({ outcome: "skipped-cost-cap", attempts: 1 });
    expect(provider.calls).toHaveLength(1);
  });

  it("خاصیت (۲۰۰ بذر × دو تلاشِ تصادفی/خصمانه): هرچه نمایش داده شود از راستی‌آزمای مستقل می‌گذرد، ≤ ۲ تماس، بی‌ارجاع جعلی", async () => {
    let seed = 20_270_117;
    const rnd = (n: number): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return Math.floor((seed / 4294967296) * n);
    };
    const pick = <T>(xs: readonly T[]): T => xs[rnd(xs.length)] as T;
    const SCENES = [
      { asOf: "2005-05-05", q: Q_SELLER, goodQuote: "مبیع را در محل عقد", otherVersionQuote: "مبیع را در مهلت مقرر" },
      { asOf: "2024-01-01", q: Q_BUYER, goodQuote: "ثمن را در مهلت مقرر", otherVersionQuote: "همزمان انجام می‌شود" },
    ] as const;
    const gen = (scene: (typeof SCENES)[number]): Reply => {
      if (rnd(8) === 0) return { text: pick(["نه JSON", "[1]", "{}", "```json\n{}\n```x"]), finishReason: "stop" };
      if (rnd(10) === 0) return { text: JSON.stringify({ answer: "x [S1]", citations: [] }), finishReason: "length" };
      if (rnd(9) === 0) return stop({ answer: "کافی نیست", insufficient: true });
      const text = pick([
        "پاسخ [S1].",
        "پاسخ [S9].",
        "پاسخ [S۱] و [S1].",
        "بدون نشانه.",
        "طبق ماده ۱ قانون ساختگی الف [S1].",
        "طبق ماده ۳ قانون ساختگی الف [S1].",
        "طبق ماده ۲ قانون ساختگی الف [S1, S9].",
        "ماده ۱۰ [S1] [S2]",
      ]);
      const quote = pick([scene.goodQuote, scene.otherVersionQuote, "عبارت ساختگی هرگز نبوده", null]);
      const cites = pick([[{ source: "S1", quote }], [{ source: "S1", quote }, { source: "S9", quote: scene.goodQuote }], [], [{ source: "S1", quote: scene.goodQuote }]]);
      return stop({ answer: text, insufficient: false, citations: cites });
    };
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const scene = pick(SCENES);
      const policy = pick(POLICIES);
      const r = await ask(policy, [gen(scene), gen(scene)], scene.asOf, scene.q);
      expect(provider.calls.length, `seed ${i}`).toBeLessThanOrEqual(2);
      if (!r.ok) {
        expect(["MODEL_OUTPUT_INVALID"], `seed ${i}: ${r.error.code}`).toContain(r.error.code);
        expect(r.error.accounting, `seed ${i}`).not.toBeNull();
        seen.add("error");
        continue;
      }
      const a = r.value;
      seen.add(a.repair?.outcome ?? "?");
      expect(a.repair?.attempts, `seed ${i}`).toBe(provider.calls.length);
      expect(independentlyValid(a, scene.asOf), `seed ${i}`).toBe(true);
      if (a.text !== null) {
        expect(a.citations.length, `seed ${i}`).toBeGreaterThan(0);
        const ids = new Set(a.citations.map((c) => c.id));
        for (const id of idsOf(scanMarkers(a.text))) expect(ids.has(id), `seed ${i}: ${id}`).toBe(true);
      } else {
        expect(a.citations, `seed ${i}`).toEqual([]);
      }
      // بند تأییدنشدهٔ ماده ۳ و نسخهٔ تأییدنشدهٔ ماده ۱ (۲۰۱۰) هرگز ارجاع نمی‌شوند.
      for (const c of a.citations) {
        expect(c.article === "3", `seed ${i}`).toBe(false);
        if (scene.asOf === "2024-01-01") expect(c.article === "1", `seed ${i}`).toBe(false);
      }
    }
    // ادعای پوشش: هر مسیر مهم واقعاً دیده شده (ترمیم موفق، ردّ دوباره/شکست، بی‌نیاز، خطا).
    expect(seen.has("adopted")).toBe(true);
    expect(seen.has("not-needed")).toBe(true);
    expect(seen.has("not-improved") || seen.has("failed")).toBe(true);
    expect(seen.has("not-repairable") || seen.has("error")).toBe(true);
  });
});

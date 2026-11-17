/**
 * قرارداد میان‌ماژولی «retrieval → citation-verifier» روی PostgreSQL واقعی (پل میان store و راستی‌آزمایی؛ ADR-0013).
 * این‌جا (tooling/) است چون هیچ‌یک از دو ماژول به دیگری وابسته نیست و فقط لایهٔ بالاتر (ارکستراتور) آن‌ها را به هم می‌بندد.
 * ادعا: هر آنچه بازیابی می‌دهد، راستی‌آزمایی هم **در همان تاریخ** می‌پذیرد؛ و هر چه نباید (تأییدنشده، تاریخ دیگر، شناسهٔ جعلی،
 * نقل‌قول ساختگی) هم‌چنان رد می‌شود — حتی اگر بازیابی/مدل آن را بیاورد.
 */
import { randomBytes } from "node:crypto";
import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyCitations, MIN_QUOTE_CHARS, type CitationClaim } from "@/modules/citation-verifier";
import { buildCorpusIndex, loadCorpus } from "@/modules/legal-kb-schema";
import { auditSchemaName, createKbStore, searchSchemaName, type KbStore } from "@/modules/legal-kb-store";
import { buildContext, lookupSource, retrieve, type Passage } from "@/modules/retrieval";

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
        { label: "1", versions: [version("2001-01-01", "2010-01-01", "فروشنده مکلف است مبیع را در محل عقد تحویل دهد.", true), version("2010-01-01", null, "فروشنده مکلف است مبیع را در مهلت مقرر تحویل دهد.", false)] },
        { label: "2", versions: [version("2001-01-01", null, "خریدار مکلف است ثمن را در مهلت مقرر بپردازد.", true)] },
        { label: "3", versions: [version("2001-01-01", null, "تحویل مبیع و پرداخت ثمن همزمان انجام می‌شود.", false)] },
      ],
    },
  ],
  relations: [],
  rulings: [],
};

dbDescribe("pipeline · retrieval → citation-verifier (PostgreSQL واقعی)", () => {
  let pool: Pool;
  let store: KbStore;
  let schema: string;
  let index: ReturnType<typeof buildCorpusIndex>;

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
    // پل: Corpus از store ← نمایهٔ راستی‌آزمایی (بدون هیچ دسترسی به متن بیرون از پایگاه)
    const read = await store.readCorpus();
    if (!read.ok) throw new Error(read.error.message);
    const loaded = loadCorpus(JSON.parse(JSON.stringify(read.value)));
    if (!loaded.ok) throw new Error("corpus از store بازاعتبارسنجی نشد");
    index = buildCorpusIndex(loaded.value);
  });

  afterAll(async () => {
    if (!schema.startsWith("legal_kb_test_")) throw new Error("امتناع از حذف شِمایی که آزمونی نیست.");
    const db = drizzle(pool);
    for (const s of [schema, auditSchemaName(schema), searchSchemaName(schema)]) await db.execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(s)} CASCADE`);
    await pool.end();
  });

  const run = async (question: string, asOf: string, extra: Record<string, unknown> = {}): Promise<readonly Passage[]> => {
    const r = await retrieve(store, { question, asOf, ...extra });
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    return r.value.passages;
  };
  const claimOf = (p: Passage, quote?: string): CitationClaim => ({ ref: p.citation, ...(quote === undefined ? {} : { quote }) });

  it("هر بندِ بازیابی‌شدهٔ پیش‌فرض (فقط‌تأییدشده) در همان تاریخ valid است", async () => {
    let checked = 0;
    for (const asOf of ["2001-01-01", "2005-05-05", "2009-12-31", "2010-01-01", "2024-01-01"]) {
      for (const q of ["فروشنده مکلف به تحویل مبیع", "آیا خریدار ثمن را می‌پردازد؟", "مهلت مقرر", "تحویل"]) {
        const passages = await run(q, asOf);
        const report = verifyCitations(index, passages.map((p) => claimOf(p)), asOf);
        expect(report.allAccepted, `${q} @ ${asOf}`).toBe(true);
        for (const v of report.verdicts) expect(v.code).toBe("valid");
        checked += passages.length;
      }
    }
    expect(checked).toBeGreaterThan(8); // آزمون تهی نیست
  });

  it("نقل‌قول بریده‌شده از متن بند پذیرفته می‌شود؛ ساختگی/جابه‌جاشده رد (quote-mismatch)", async () => {
    const [p] = await run("خریدار ثمن", "2024-01-01", { minCoverage: 1 });
    expect(p?.ref.article).toBe("2");
    if (p === undefined) return;
    const real = p.text.slice(0, Math.max(MIN_QUOTE_CHARS + 2, 20));
    expect(verifyCitations(index, [claimOf(p, real)], "2024-01-01").allAccepted).toBe(true);
    const forged = verifyCitations(index, [claimOf(p, "خریدار مکلف است ثمن را هرگز نپردازد")], "2024-01-01");
    expect(forged.allAccepted).toBe(false);
    expect(forged.verdicts[0]?.code).toBe("quote-mismatch");
  });

  it("بند تأییدنشده: بازیابی با verifiedOnly:false می‌آورد، ولی راستی‌آزمایی (پیش‌فرض) رد می‌کند؛ فقط با پرچم صریح مجاز است", async () => {
    const passages = await run("تحویل مبیع پرداخت ثمن", "2024-01-01", { verifiedOnly: false, minCoverage: 1 });
    const pending = passages.find((p) => !p.verified);
    expect(pending?.ref.article).toBe("3");
    if (pending === undefined) return;
    const strict = verifyCitations(index, [claimOf(pending)], "2024-01-01");
    expect(strict.verdicts[0]).toMatchObject({ code: "unverified-source", accepted: false });
    expect(verifyCitations(index, [claimOf(pending)], "2024-01-01", { allowUnverified: true }).allAccepted).toBe(true);
    // و زمینهٔ مدل هم پیش‌فرض آن را نمی‌آورد (دفاع دوم)
    const ctx = buildContext(passages);
    expect(ctx.ok && ctx.value.sources.every((s) => s.verified)).toBe(true);
  });

  it("انضباط تاریخ: بند ۲۰۰۹ را در ۲۰۱۰ نمی‌شود استناد کرد (نسخهٔ بعدی تأییدنشده است)", async () => {
    const [p] = await run("فروشنده مبیع تحویل", "2009-12-31", { minCoverage: 1 });
    expect(p?.ref.validFrom).toBe("2001-01-01");
    if (p === undefined) return;
    expect(verifyCitations(index, [claimOf(p)], "2009-12-31").allAccepted).toBe(true);
    const later = verifyCitations(index, [claimOf(p)], "2010-01-01");
    expect(later.allAccepted).toBe(false); // همان ماده در این روز نسخهٔ تأییدنشدهٔ جدید دارد
  });

  it("شناسهٔ منبعِ جعلیِ مدل ⇒ lookupSource تهی ⇒ هیچ ادعایی ساخته نمی‌شود؛ ارجاع ساختگی هم رد می‌شود", async () => {
    const passages = await run("فروشنده مبیع", "2005-05-05");
    const ctx = buildContext(passages);
    if (!ctx.ok) throw new Error(ctx.error.message);
    expect(lookupSource(ctx.value, "S1")).not.toBeNull();
    expect(lookupSource(ctx.value, "S77")).toBeNull();
    const fake = verifyCitations(index, [{ ref: { documentId: "law-a", article: "999", subpart: null } }, { ref: { documentId: "law-zzz", article: "1", subpart: null } }], "2005-05-05");
    expect(fake.verdicts.map((v) => v.code)).toEqual(["unknown-article", "unknown-document"]);
  });
});

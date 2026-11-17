/**
 * کمک‌تست پایگاه واقعی برای `retrieval` (فقط تست؛ از index صادر نمی‌شود). فقط از رابط عمومی `legal-kb-store` استفاده می‌کند.
 * سیاست مثل store: هر فایل شِمای یک‌بارمصرف `legal_kb_test_<تصادفی>` می‌سازد و پاک می‌کند؛ به `public` دست نمی‌زند.
 */
import { randomBytes } from "node:crypto";
import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { describe } from "vitest";
import { auditSchemaName, createKbStore, searchSchemaName, type KbStore } from "@/modules/legal-kb-store";

config({ quiet: true });

export const TEST_DB_URL: string | undefined = process.env["KB_TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
export const HAS_DB = typeof TEST_DB_URL === "string" && TEST_DB_URL !== "";
/** `describe` که بدون پایگاه رد می‌شود (در CI نبودن پایگاه را دروازهٔ صفر-رد قرمز می‌کند). */
export const dbDescribe = HAS_DB ? describe : describe.skip;

export type RetrievalTestKb = Readonly<{
  store: KbStore;
  schema: string;
  raw(text: string, params?: readonly unknown[]): Promise<Record<string, unknown>[]>;
  drop(): Promise<void>;
}>;

export async function openRetrievalKb(options: Readonly<{ migrateSearch?: boolean }> = {}): Promise<RetrievalTestKb> {
  if (!HAS_DB) throw new Error("پایگاه آزمون تنظیم نشده است (KB_TEST_DATABASE_URL یا DATABASE_URL).");
  const schema = `legal_kb_test_${randomBytes(5).toString("hex")}`;
  const pool = new Pool({ connectionString: TEST_DB_URL, max: 4 });
  const db = drizzle(pool);
  const made = createKbStore(db, { schema });
  if (!made.ok) throw new Error(made.error.message);
  const store = made.value;
  const m = await store.migrate();
  if (!m.ok) throw new Error(`migrate failed: ${m.error.code}`);
  if (options.migrateSearch !== false) {
    const s = await store.migrateSearch();
    if (!s.ok) throw new Error(`migrateSearch failed: ${s.error.code}`);
  }
  return {
    store,
    schema,
    raw: async (text, params = []) => (await pool.query(text.split("{{schema}}").join(`"${schema}"`), [...params])).rows,
    drop: async () => {
      if (!schema.startsWith("legal_kb_test_")) throw new Error("امتناع از حذف شِمایی که آزمونی نیست.");
      await db.execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(schema)} CASCADE`);
      await db.execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(auditSchemaName(schema))} CASCADE`);
      await db.execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(searchSchemaName(schema))} CASCADE`);
      await pool.end();
    },
  };
}

// ── سازندهٔ Corpus ساختگی (JSON خام ورودی insertCorpus) ──
type J = Record<string, unknown>;
const prov = (verified: boolean): J => ({
  sourceName: "منبع ساختگی",
  sourceUrl: null,
  sourceKind: verified ? "official" : "secondary",
  retrievedOn: "2025-01-10",
  review: verified ? { status: "legally-verified", reviewedBy: "بازبین فرضی", reviewedOn: "2025-02-01" } : { status: "pending-legal-review", reviewedBy: null, reviewedOn: null },
});

export type SeedVersion = Readonly<{ validFrom: string; validTo: string | null; text: string; verified: boolean; subparts?: readonly Readonly<{ kind: "note" | "clause"; label: string; text: string }>[] }>;
export type SeedArticle = Readonly<{ document: string; label: string; versions: readonly SeedVersion[] }>;

export function seedCorpus(articles: readonly SeedArticle[]): J {
  const docs = [...new Set(articles.map((a) => a.document))].sort();
  return {
    documents: docs.map((id) => ({
      id,
      kind: "statute",
      title: `قانون ساختگی ${id}`,
      shortTitle: null,
      enactedOn: null,
      provenance: prov(false),
      articles: articles
        .filter((a) => a.document === id)
        .map((a) => ({ label: a.label, versions: a.versions.map((v) => ({ validFrom: v.validFrom, validTo: v.validTo, text: v.text, subparts: v.subparts ?? [], provenance: prov(v.verified) })) })),
    })),
    relations: [],
    rulings: [],
  };
}

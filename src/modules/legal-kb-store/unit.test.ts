/** تست‌های بدون پایگاه: نام شِما، نگاشت خطا، تخت‌سازی Corpus، مهاجرت‌ها و منطق دفتر. */
import { describe, expect, it } from "vitest";
import { FICTIONAL_SAMPLE_CORPUS, loadCorpus, type Corpus } from "@/modules/legal-kb-schema";
import { CorruptRowError, mapDbError, StoreAbort, toStoreError } from "./errors";
import { flattenCorpus } from "./insert";
import { reconcile } from "./migrate";
import { MIGRATIONS, migrationChecksum, renderStatement, type Migration } from "./migrations";
import { DEFAULT_SCHEMA, parseSchemaName } from "./naming";
import { HAS_DB } from "./test-db";

const sample = (): Corpus => {
  const r = loadCorpus(JSON.parse(JSON.stringify(FICTIONAL_SAMPLE_CORPUS)));
  if (!r.ok) throw new Error("sample invalid");
  return r.value;
};

describe("نگهبان CI: تست‌های پایگاه نباید بی‌صدا رد شوند", () => {
  it("در CI باید پایگاه آزمون تنظیم شده باشد", () => {
    if (process.env["CI"] === "true" || process.env["CI"] === "1") {
      expect(HAS_DB, "KB_TEST_DATABASE_URL یا DATABASE_URL را در CI تنظیم کنید؛ تست‌های پایگاه نباید رد شوند.").toBe(true);
    } else {
      expect(true).toBe(true);
    }
  });
});

describe("نام شِما (تنها شناسهٔ واردشده در SQL)", () => {
  it("پیش‌فرض معتبر است", () => {
    expect(parseSchemaName(DEFAULT_SCHEMA)).toEqual({ ok: true, value: "legal_kb" });
  });
  it("نام‌های معتبر", () => {
    for (const n of ["a", "legal_kb", "kb_test_1", "x".repeat(40)]) expect(parseSchemaName(n).ok, n).toBe(true);
  });
  it("فهرست‌سفید: همهٔ شکل‌های خطرناک/ناپسند رد می‌شوند", () => {
    const bad: unknown[] = [
      "",
      " ",
      "Legal",
      "legal-kb",
      "legal kb",
      "1kb",
      "_kb",
      "x".repeat(41),
      "public",
      "information_schema",
      "pg_catalog",
      "pg_temp",
      'a"b',
      "a;b",
      "a--b",
      "a.b",
      "kb\n",
      "kب",
      null,
      undefined,
      42,
      {},
      ["legal_kb"],
    ];
    for (const n of bad) expect(parseSchemaName(n).ok, String(n)).toBe(false);
  });
  it("فازی: هر نام پذیرفته‌شده فقط [a-z0-9_] دارد (نقل‌قول و جداکننده هرگز نمی‌گذرد)", () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const alphabet = 'abcXYZ019_-"\';. \n\\$%ب';
    let accepted = 0;
    for (let i = 0; i < 20000; i++) {
      const len = 1 + Math.floor(rnd() * 8);
      let s = "";
      for (let k = 0; k < len; k++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      const r = parseSchemaName(s);
      if (r.ok) {
        accepted++;
        expect(r.value).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    }
    expect(accepted).toBeGreaterThan(50); // تست واقعاً هر دو شاخه را دیده است
  });
});

describe("نگاشت خطای پایگاه", () => {
  const pg = (code: string, constraint?: string) => Object.assign(new Error("secret query text with password=hunter2"), { code, constraint });
  const wrapped = (inner: unknown) => Object.assign(new Error("Failed query: SELECT ... params: secret"), { cause: inner });

  it("کدهای شناخته‌شده به کد دامنه نگاشت می‌شوند (حتی وقتی drizzle در cause پیچیده)", () => {
    expect(mapDbError(wrapped(pg("23505", "document_pk")))).toMatchObject({ code: "ALREADY_EXISTS", pgCode: "23505", constraint: "document_pk" });
    expect(mapDbError(wrapped(pg("23P01", "article_version_no_overlap")))).toMatchObject({ code: "CONSTRAINT_VIOLATION", constraint: "article_version_no_overlap" });
    expect(mapDbError(wrapped(pg("23514")))).toMatchObject({ code: "CONSTRAINT_VIOLATION" });
    expect(mapDbError(wrapped(pg("23503")))).toMatchObject({ code: "CONSTRAINT_VIOLATION" });
    expect(mapDbError(wrapped(pg("22021")))).toMatchObject({ code: "CONSTRAINT_VIOLATION" });
    expect(mapDbError(wrapped(pg("22P05")))).toMatchObject({ code: "CONSTRAINT_VIOLATION" });
    expect(mapDbError(pg("42P01"))).toMatchObject({ code: "NOT_MIGRATED" });
    expect(mapDbError(pg("3F000"))).toMatchObject({ code: "NOT_MIGRATED" });
    expect(mapDbError(pg("57014"))).toMatchObject({ code: "DB_ERROR", pgCode: "57014" });
  });
  it("خطای ناشناخته: DB_ERROR؛ پیام هرگز متن خطای اصلی را نمی‌آورد", () => {
    for (const e of [new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2"), "boom", null, undefined, 42, { code: "not-a-pg-code" }]) {
      const m = mapDbError(e);
      expect(m.code).toBe("DB_ERROR");
      expect(JSON.stringify(m)).not.toMatch(/hunter2|10\.0\.0\.5|ECONNREFUSED|boom/);
    }
    expect(JSON.stringify(mapDbError(wrapped(pg("23505"))))).not.toMatch(/secret|hunter2|Failed query/);
  });
  it("زنجیرهٔ cause دایره‌ای پایان می‌پذیرد", () => {
    const a: { cause?: unknown } = {};
    const b: { cause?: unknown } = { cause: a };
    a.cause = b;
    expect(mapDbError(a).code).toBe("DB_ERROR");
  });
  it("StoreAbort و CorruptRowError به همان خطا/CORRUPT_DATA تبدیل می‌شوند", () => {
    const err = { code: "ALREADY_EXISTS", message: "m" } as const;
    expect(toStoreError(new StoreAbort(err))).toBe(err);
    expect(toStoreError(new CorruptRowError("ستون x")).code).toBe("CORRUPT_DATA");
  });
});

describe("flattenCorpus (تخت‌سازی Corpus معتبر)", () => {
  const flat = flattenCorpus(sample());

  it("شمارها با نمونهٔ ساختگی می‌خواند", () => {
    expect(flat.documents).toHaveLength(3);
    expect(flat.articles).toHaveLength(5);
    expect(flat.versions).toHaveLength(7);
    expect(flat.subparts).toHaveLength(4);
    expect(flat.relations).toHaveLength(3);
    expect(flat.rulings).toHaveLength(1);
    expect(flat.cites).toHaveLength(1);
  });
  it("ترتیب سندها/رابطه‌ها با idx حفظ می‌شود و تبصره‌ها با ordinal", () => {
    expect(flat.documents.map((d) => d["idx"])).toEqual([0, 1, 2]);
    expect(flat.documents.map((d) => d["id"])).toEqual(["sample-law", "sample-single-act", "sample-regulation"]);
    expect(flat.relations.map((r) => r["idx"])).toEqual([0, 1, 2]);
    const art2 = flat.subparts.filter((s) => s["article_label"] === "2");
    expect(art2.map((s) => [s["ordinal"], s["kind"], s["label"]])).toEqual([
      [0, "note", "1"],
      [1, "clause", "الف"],
      [2, "clause", "ب"],
    ]);
  });
  it("شمارهٔ ماده: «واحده» = ۰، «مکرر» = ۱", () => {
    const find = (label: string) => flat.articles.find((a) => a["label"] === label && a["document_id"] !== "sample-regulation");
    expect(flat.articles.find((a) => a["label"] === "واحده")).toMatchObject({ article_number: 0, article_repeat: 0 });
    expect(find("2 مکرر")).toMatchObject({ article_number: 2, article_repeat: 1 });
    expect(find("1")).toMatchObject({ article_number: 1, article_repeat: 0 });
  });
  it("تهی‌ها تهی می‌مانند (نه رشتهٔ خالی/undefined) و بازبینی پیش‌فرض تأییدنشده است", () => {
    const doc = flat.documents[1] as Record<string, unknown>;
    expect(doc["short_title"]).toBeNull();
    expect(doc["review_status"]).toBe("pending-legal-review");
    expect(doc["reviewed_by"]).toBeNull();
    const verified = flat.versions.find((v) => v["review_status"] === "legally-verified") as Record<string, unknown>;
    expect(verified["reviewed_by"]).toBe("بازبین فرضی");
    expect(Object.values(doc).every((v) => v !== undefined)).toBe(true);
  });
  it("JSON.stringify رفت‌وبرگشت‌پذیر است (هیچ مقدار ناسازگار با JSON نیست)", () => {
    for (const rows of Object.values(flat)) expect(JSON.parse(JSON.stringify(rows))).toEqual(rows);
  });
  it("Corpus خالی ← جدول‌های خالی", () => {
    const empty = loadCorpus({ documents: [], relations: [], rulings: [] });
    expect(empty.ok).toBe(true);
    if (empty.ok) for (const rows of Object.values(flattenCorpus(empty.value))) expect(rows).toEqual([]);
  });
});

describe("مهاجرت‌ها: قفل checksum و اجرای قالب", () => {
  it("مهاجرتِ اعمال‌شده ویرایش‌ناپذیر است: checksum قفل شده (تغییر = مهاجرت تازه، نه ویرایش)", () => {
    // اگر این تست قرمز شد، مهاجرت ۰۰۰۱ را ویرایش کرده‌اید. برگردانید و مهاجرت ۰۰۰۲ بسازید. این مقدار را عوض نکنید.
    expect(migrationChecksum(MIGRATIONS[0] as Migration)).toBe("cab699756d994f0c0c93f85a6947eed9f12e5cbec8151cf1f8cfd83454bbb22f");
  });
  it("checksum به نام، ترتیب و حتی یک نویسه حساس است", () => {
    const m: Migration = { name: "0001_x", statements: ["SELECT 1", "SELECT 2"] };
    const base = migrationChecksum(m);
    expect(migrationChecksum({ ...m, name: "0002_x" })).not.toBe(base);
    expect(migrationChecksum({ ...m, statements: ["SELECT 2", "SELECT 1"] })).not.toBe(base);
    expect(migrationChecksum({ ...m, statements: ["SELECT 1", "SELECT 2 "] })).not.toBe(base);
    expect(migrationChecksum({ ...m, statements: ["SELECT 1SELECT 2"] })).not.toBe(base);
    expect(migrationChecksum({ ...m })).toBe(base);
  });
  it("renderStatement فقط {{schema}} را با نام نقل‌قول‌شده جایگزین می‌کند", () => {
    expect(renderStatement("CREATE TABLE {{schema}}.a (x {{schema}}.d)", "kb")).toBe('CREATE TABLE "kb".a (x "kb".d)');
    expect(renderStatement("SELECT '{{other}}'", "kb")).toBe("SELECT '{{other}}'");
  });
  it("هر دستورِ مهاجرت ۰۰۰۱ فقط به شِمای خودش ارجاع می‌دهد (نه public یا ارجاع بدون شِما به جدول ما)", () => {
    const text = (MIGRATIONS[0] as Migration).statements.join("\n");
    expect(text).not.toMatch(/\bpublic\./i);
    expect(text).not.toMatch(/\bDROP\b/i); // مهاجرت اولیه هرگز چیزی حذف نمی‌کند
    for (const m of text.matchAll(/CREATE (?:UNIQUE )?(?:TABLE|INDEX|DOMAIN)(?: IF NOT EXISTS)? (?:\w+ ON )?(\S+)/g)) {
      expect(m[1], m[0]).toMatch(/^(\{\{schema\}\}\.|\w+_(uq|ix)$)/);
    }
  });
  it("قیدهای کلیدی در مهاجرت هستند (نبود هم‌پوشانی، نیم‌باز، بازبینی)", () => {
    const text = (MIGRATIONS[0] as Migration).statements.join("\n");
    expect(text).toContain("EXCLUDE USING gist");
    expect(text).toContain("daterange(valid_from, valid_to, '[)')");
    expect(text).toContain("article_version_review_consistent_ck");
    expect(text).toContain("article_label_matches_ck");
  });
});

describe("reconcile: دفتر در برابر کد", () => {
  const mk = (n: string): Migration => ({ name: n, statements: [`SELECT '${n}'`] });
  const A = mk("0001_a");
  const B = mk("0002_b");
  const C = mk("0003_c");
  const row = (m: Migration, checksum = migrationChecksum(m)) => ({ name: m.name, checksum });
  const codeOf = (fn: () => unknown): string | null => {
    try {
      fn();
      return null;
    } catch (e) {
      return e instanceof StoreAbort ? e.error.code : "other";
    }
  };

  it("دفتر خالی: همه معلق", () => {
    expect(reconcile([], [A, B])).toEqual({ applied: [], pending: ["0001_a", "0002_b"] });
  });
  it("پیشوند اعمال‌شده: باقی معلق", () => {
    expect(reconcile([row(A)], [A, B, C])).toEqual({ applied: ["0001_a"], pending: ["0002_b", "0003_c"] });
  });
  it("همه اعمال‌شده", () => {
    expect(reconcile([row(A), row(B)], [A, B])).toEqual({ applied: ["0001_a", "0002_b"], pending: [] });
  });
  it("حفره: ۰۰۰۲ اعمال شده ولی ۰۰۰۱ نه → MIGRATION_TAMPERED", () => {
    expect(codeOf(() => reconcile([row(B)], [A, B]))).toBe("MIGRATION_TAMPERED");
    expect(codeOf(() => reconcile([row(A), row(C)], [A, B, C]))).toBe("MIGRATION_TAMPERED");
  });
  it("checksum ناهمخوان → MIGRATION_TAMPERED", () => {
    expect(codeOf(() => reconcile([row(A, "bad")], [A, B]))).toBe("MIGRATION_TAMPERED");
    expect(codeOf(() => reconcile([row(A), row(B, "")], [A, B]))).toBe("MIGRATION_TAMPERED");
  });
  it("مهاجرت ناشناخته (پایگاه از آینده) → MIGRATION_UNKNOWN، حتی اگر بقیه درست باشند", () => {
    expect(codeOf(() => reconcile([row(A), row(C)], [A, B]))).toBe("MIGRATION_UNKNOWN");
    expect(codeOf(() => reconcile([row(mk("9999_x"))], [A]))).toBe("MIGRATION_UNKNOWN");
  });
});

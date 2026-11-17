/**
 * متن جست‌وجو (خالص، بدون پایگاه) — بخش ۴ب‑۳: اعتبارسنجی ورودی، نرمال‌سازی هم‌ارز، اثر انگشت، شکل مهاجرت و نام شِما.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { versionContentHash } from "./content-hash";
import { MIGRATIONS, migrationChecksum } from "./migrations";
import { DEFAULT_SCHEMA, parseSchemaName, searchSchemaName } from "./naming";
import { SEARCH_MIGRATIONS, renderSearchStatement } from "./search-migrations";
import { SEARCH_LIMITS, buildIndexRow, parseSearchInput, referenceMatches, searchKeyFingerprint } from "./search-text";

const OK = { text: "ثمن معامله", asOf: "2024-03-01" } as const;
const tokensOf = (text: string): readonly string[] => {
  const r = parseSearchInput({ text, asOf: "2024-03-01" });
  if (!r.ok) throw new Error(r.error.message);
  return r.value.tokens;
};
const errOf = (input: unknown): string | null => {
  const r = parseSearchInput(input);
  return r.ok ? null : `${r.error.code}`;
};
const msgOf = (input: unknown): string => {
  const r = parseSearchInput(input);
  return r.ok ? "" : r.error.message;
};

describe("parseSearchInput · پیش‌فرض‌ها", () => {
  it("پیش‌فرض ایمن: فقط تأییدشده، سقف ۲۰، بدون فیلتر سند", () => {
    const r = parseSearchInput(OK);
    expect(r).toEqual({ ok: true, value: { tokens: ["ثمن", "معامله"], asOf: "2024-03-01", verifiedOnly: true, documentId: null, limit: 20 } });
  });
  it("مقدارهای صریح پذیرفته می‌شوند", () => {
    const r = parseSearchInput({ ...OK, verifiedOnly: false, documentId: "law-a", limit: 100 });
    expect(r).toEqual({ ok: true, value: { tokens: ["ثمن", "معامله"], asOf: "2024-03-01", verifiedOnly: false, documentId: "law-a", limit: 100 } });
    expect(parseSearchInput({ ...OK, limit: 1 }).ok).toBe(true);
  });
});

describe("parseSearchInput · رد ورودی بد (INVALID_INPUT، بی‌حدس)", () => {
  it("شکل ورودی", () => {
    for (const bad of [undefined, null, 5, "ثمن", [], [OK]]) expect(errOf(bad), String(bad)).toBe("INVALID_INPUT");
  });
  it("کلید ناشناخته — غلط املاییِ `verifiedonly` پیش‌فرضِ ایمن را بی‌صدا دور نمی‌زند", () => {
    expect(errOf({ ...OK, verifiedonly: false })).toBe("INVALID_INPUT");
    expect(msgOf({ ...OK, verifiedonly: false })).toContain("verifiedonly");
    expect(errOf({ ...OK, query: "x" })).toBe("INVALID_INPUT");
    expect(errOf({ ...OK, __proto__x: 1 })).toBe("INVALID_INPUT");
  });
  it("text", () => {
    expect(errOf({ asOf: "2024-03-01" })).toBe("INVALID_INPUT");
    expect(errOf({ text: 5, asOf: "2024-03-01" })).toBe("INVALID_INPUT");
    expect(errOf({ text: "x".repeat(SEARCH_LIMITS.maxQueryChars + 1), asOf: "2024-03-01" })).toBe("INVALID_INPUT");
    expect(errOf({ text: "x".repeat(SEARCH_LIMITS.maxTokenChars), asOf: "2024-03-01" })).toBeNull();
  });
  it("پرسشِ بی‌واژه (فقط نشانه/فاصله/نیم‌فاصله)", () => {
    for (const t of ["", "   ", "؟!؛،", "«»()-_", "\u200C\u200C", "\u0640\u0640"]) expect(errOf({ text: t, asOf: "2024-03-01" }), JSON.stringify(t)).toBe("INVALID_INPUT");
  });
  it("asOf الزامی و معتبر؛ هیچ پیش‌فرضِ پنهانی (ساعت سیستم) نیست", () => {
    expect(msgOf({ text: "ثمن" })).toContain("الزامی");
    for (const d of [5, null, "", "2024-3-1", "1403-01-01x", "2024-02-30", "2023-02-29", "2024-13-01", "1700-01-01", "2300-01-01", "۲۰۲۴-۰۳-۰۱"]) {
      expect(errOf({ text: "ثمن", asOf: d }), String(d)).toBe("INVALID_INPUT");
    }
    expect(errOf({ text: "ثمن", asOf: "2024-02-29" })).toBeNull();
  });
  it("verifiedOnly باید بولین باشد (نه رشتهٔ «false»)", () => {
    for (const v of ["false", 0, 1, null, "true"]) expect(errOf({ ...OK, verifiedOnly: v }), String(v)).toBe("INVALID_INPUT");
  });
  it("documentId", () => {
    for (const d of ["", "A", "a b", "a_b", "-a", "a-", "a--b", "x".repeat(65), 5, null, "قانون"]) expect(errOf({ ...OK, documentId: d }), String(d)).toBe("INVALID_INPUT");
    expect(errOf({ ...OK, documentId: "x".repeat(64) })).toBeNull();
  });
  it("limit: عدد صحیح ۱ تا ۱۰۰", () => {
    for (const l of [0, -1, 101, 1.5, NaN, Infinity, "5", null]) expect(errOf({ ...OK, limit: l }), String(l)).toBe("INVALID_INPUT");
  });
  it("بیش از ۱۲ واژهٔ متمایز بی‌صدا برش نمی‌خورد؛ دقیقاً ۱۲ و تکراری‌ها مجازند", () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
    expect(errOf({ text: words(13), asOf: "2024-03-01" })).toBe("INVALID_INPUT");
    expect(errOf({ text: words(12), asOf: "2024-03-01" })).toBeNull();
    expect(errOf({ text: `${words(12)} w0 w1 w11`, asOf: "2024-03-01" })).toBeNull();
  });
  it("واژهٔ بیش از ۶۴ نویسه رد می‌شود (هرگز نمایه نمی‌شود، پس هرگز پیدا نمی‌شود)", () => {
    expect(errOf({ text: `ثمن ${"ا".repeat(SEARCH_LIMITS.maxTokenChars + 1)}`, asOf: "2024-03-01" })).toBe("INVALID_INPUT");
  });
});

describe("نرمال‌سازی: نوشته‌های هم‌ارز یک پرسش‌اند", () => {
  it("رقم فارسی/عربی/لاتین و «مادهٔ» با همزه و «ماده‌ی»", () => {
    const a = tokensOf("ماده ۱۰");
    expect(a).toEqual(["ماده", "10"]);
    expect(tokensOf("ماده 10")).toEqual(a);
    expect(tokensOf("ماده ١٠")).toEqual(a);
    expect(tokensOf("مادهٔ 10")).toEqual(["ماده", "10"]); // همزهٔ «ۀ» به «ه»
  });
  it("ی/ک عربی، اعراب، کشیده، شکل‌های ارائه، حروف لاتین", () => {
    expect(tokensOf("كتاب")).toEqual(tokensOf("کتاب"));
    expect(tokensOf("عَلِيّ")).toEqual(tokensOf("علی"));
    expect(tokensOf("کــتــاب")).toEqual(tokensOf("کتاب"));
    expect(tokensOf("ﻛﺘﺎﺏ")).toEqual(tokensOf("کتاب"));
    expect(tokensOf("ABC")).toEqual(["abc"]);
  });
  it("نیم‌فاصله و جداکننده‌ها واژه را می‌شکنند؛ تکرار حذف و ترتیب حفظ می‌شود", () => {
    expect(tokensOf("می‌خواهم")).toEqual(["می", "خواهم"]);
    expect(tokensOf("ثمن، ثمن؛ معامله؟ ثمن")).toEqual(["ثمن", "معامله"]);
    expect(tokensOf("معامله ثمن")).toEqual(["معامله", "ثمن"]);
  });
  it("پرسشِ خصمانه فقط واژه می‌شود (نشانه‌های SQL و tsquery بی‌اثرند)", () => {
    expect(tokensOf("'; DROP SCHEMA public CASCADE; --")).toEqual(["drop", "schema", "public", "cascade"]);
    expect(tokensOf("a & b | !c :* \\ % _ ( ) <-> '")).toEqual(["a", "b", "c"]);
    expect(tokensOf("ثمن\u0000معامله")).toBeTruthy();
  });
});

describe("buildIndexRow", () => {
  const content = { text: "ثمن را بپردازد. ثمن", subparts: [{ kind: "note" as const, label: "الف", text: "تبصره درباره مبیع" }] };
  it("واژه‌های متن و تبصره/بندها (نه برچسب‌ها)، با تکرار", () => {
    const row = buildIndexRow(content);
    expect(row.tokens).toEqual(["ثمن", "را", "بپردازد", "ثمن", "تبصره", "درباره", "مبیع"]);
    expect(row.tokens).not.toContain("الف");
  });
  it("هش همان `versionContentHash` و اثر انگشت همان قاعدهٔ فعلی", () => {
    const row = buildIndexRow(content);
    expect(row.contentHash).toBe(versionContentHash(content));
    expect(row.keyFingerprint).toBe(searchKeyFingerprint());
  });
  it("قطعی است؛ و تغییر یک نویسه در تبصره هش را عوض می‌کند", () => {
    expect(buildIndexRow(content)).toEqual(buildIndexRow(JSON.parse(JSON.stringify(content))));
    const other = { ...content, subparts: [{ ...(content.subparts[0] as object), text: "تبصره درباره مبیع!" } as (typeof content.subparts)[0]] };
    expect(buildIndexRow(other).contentHash).not.toBe(buildIndexRow(content).contentHash);
  });
  it("واژهٔ بلندتر از سقف نمایه نمی‌شود؛ متنِ بی‌واژه نمایهٔ تهی می‌دهد", () => {
    const long = "ا".repeat(SEARCH_LIMITS.maxTokenChars + 1);
    expect(buildIndexRow({ text: `ثمن ${long}`, subparts: [] }).tokens).toEqual(["ثمن"]);
    expect(buildIndexRow({ text: "؟!؛", subparts: [] }).tokens).toEqual([]);
  });
  it("مرز دقیق واژه: ۶۴ نویسه نمایه می‌شود و ۶۵ نه (همان مرزی که پرسش می‌پذیرد)", () => {
    const at = "ا".repeat(SEARCH_LIMITS.maxTokenChars);
    expect(buildIndexRow({ text: `ثمن ${at}`, subparts: [] }).tokens).toEqual(["ثمن", at]);
    expect(buildIndexRow({ text: `ثمن ${at}ا`, subparts: [] }).tokens).toEqual(["ثمن"]);
    expect(parseSearchInput({ text: at, asOf: "2024-03-01" }).ok).toBe(true);
  });
  it("هم‌ارز بودنِ نمایه و پرسش: متنِ «ماده ۱۰ مکرر» با پرسش «10» و «ماده» پیدا می‌شود", () => {
    const row = buildIndexRow({ text: "مادهٔ ۱۰ مکرر: كتاب‌ها", subparts: [] });
    expect(referenceMatches(tokensOf("ماده 10"), row)).toBe(2);
    expect(referenceMatches(tokensOf("کتاب ها"), row)).toBe(2);
    expect(referenceMatches(tokensOf("11"), row)).toBeNull();
  });
});

describe("referenceMatches (معنای مرجعِ جست‌وجو)", () => {
  const row = (tokens: string[]) => ({ tokens });
  it("AND روی همهٔ واژه‌ها؛ امتیاز = جمع دفعات", () => {
    expect(referenceMatches(["a", "b"], row(["a", "x", "b", "a"]))).toBe(3);
    expect(referenceMatches(["a", "b"], row(["a", "a"]))).toBeNull();
    expect(referenceMatches(["a"], row([]))).toBeNull();
    expect(referenceMatches([], row(["a"]))).toBe(0);
  });
  it("تطبیق کامل واژه است، نه زیررشته/پیشوند", () => {
    expect(referenceMatches(["10"], row(["100"]))).toBeNull();
    expect(referenceMatches(["ثمن"], row(["ثمنی"]))).toBeNull();
  });
});

describe("اثر انگشتِ قاعدهٔ نرمال‌سازی", () => {
  afterEach(() => {
    vi.doUnmock("@/modules/persian-text");
    vi.resetModules();
  });
  it("۶۴ نویسهٔ هگز، پایدار، و قفل‌شده (تغییر عمدیِ searchKey ⇒ مقدار را آگاهانه به‌روز کنید؛ نمایه‌ها خودکار «کهنه» دیده می‌شوند)", () => {
    expect(searchKeyFingerprint()).toMatch(/^[0-9a-f]{64}$/);
    expect(searchKeyFingerprint()).toBe(searchKeyFingerprint());
    expect(searchKeyFingerprint()).toBe(GOLDEN_FINGERPRINT);
  });
  it("اگر رفتار searchKey عوض شود اثر انگشت عوض می‌شود (هیچ‌کس مجبور نیست نسخه را دستی بالا ببرد)", async () => {
    const before = searchKeyFingerprint();
    vi.resetModules();
    vi.doMock("@/modules/persian-text", async (importOriginal) => {
      const original = await importOriginal<typeof import("@/modules/persian-text")>();
      return { ...original, searchKey: (t: string, o?: Parameters<typeof original.searchKey>[1]) => original.searchKey(t, o).toUpperCase() };
    });
    const mocked = await import("./search-text");
    expect(mocked.searchKeyFingerprint()).toMatch(/^[0-9a-f]{64}$/);
    expect(mocked.searchKeyFingerprint()).not.toBe(before);
  });
});

describe("مهاجرت و نام شِمای جست‌وجو", () => {
  it("دفتر مستقل: فهرست مهاجرت‌های دانش و checksum ۰۰۰۱ دست‌نخورده است", () => {
    expect(MIGRATIONS.map((m) => m.name)).toEqual(["0001_init", "0002_version_audit"]);
    expect(migrationChecksum(MIGRATIONS[0] as (typeof MIGRATIONS)[0])).toBe("cab699756d994f0c0c93f85a6947eed9f12e5cbec8151cf1f8cfd83454bbb22f");
    expect(SEARCH_MIGRATIONS.map((m) => m.name)).toEqual(["0001_article_search"]);
  });
  it("checksum مهاجرت جست‌وجو قفل است (ویرایشِ مهاجرتِ اعمال‌شده ⇒ MIGRATION_TAMPERED)", () => {
    expect(migrationChecksum(SEARCH_MIGRATIONS[0] as (typeof SEARCH_MIGRATIONS)[0])).toBe(GOLDEN_SEARCH_CHECKSUM);
  });
  it("شکل جدول: GIN روی آرایه، بدون tsvector و بدون کلید خارجی (نمایه باید بتواند کهنه/یتیم شود و دیده شود)", () => {
    const text = (SEARCH_MIGRATIONS[0] as (typeof SEARCH_MIGRATIONS)[0]).statements.join("\n");
    expect(text).toContain("USING gin (tokens)");
    expect(text).toContain("tokens text[]");
    expect(text).not.toMatch(/tsvector|to_tsvector/i);
    expect(text).not.toMatch(/REFERENCES|FOREIGN KEY/i);
    expect(text).toContain("article_search_hash_ck");
    expect(text).toContain("article_search_fp_ck");
    expect(text).not.toContain("{{schema}}"); // هیچ ارجاع به شِمای دانش در DDL
  });
  it("renderSearchStatement نام را نقل‌قول می‌کند و جای‌نگهدارِ دیگر را دست نمی‌زند", () => {
    expect(renderSearchStatement("CREATE TABLE {{search_schema}}.t (x {{schema}}.d)", "kb")).toBe('CREATE TABLE "kb_search".t (x {{schema}}.d)');
  });
  it("نام شِما: `<schema>_search` و پسوند رزرو (برخورد دو store ممکن نیست)", () => {
    expect(searchSchemaName(DEFAULT_SCHEMA)).toBe("legal_kb_search");
    for (const bad of ["legal_kb_search", "x_search", "legal_kb_audit_search", "_search"]) expect(parseSchemaName(bad).ok, bad).toBe(false);
    for (const good of ["my_search_x", "searchkb", "search", "legal_kb", "kb_audit_x"]) expect(parseSchemaName(good).ok, good).toBe(true);
    const longest = parseSchemaName("a".repeat(40));
    expect(longest.ok && searchSchemaName(longest.value).length).toBeLessThanOrEqual(63);
  });
});

// مقدارهای قفل‌شده. checksum با Python مستقل راستی‌آزمایی شد (sha256 از JSON فشردهٔ [نام، دستورها])؛ اثر انگشت خودارجاع است و فقط قفل می‌کند.
const GOLDEN_FINGERPRINT = "3a5cf1584a22a9dd90f5a0fde09dd0a16c98a632b4e052a8d40ec525e469c32b";
const GOLDEN_SEARCH_CHECKSUM = "356117fca6e0cffd02b59471df9f76f192747d3ba2e573ee41124bb1ff15ae65";

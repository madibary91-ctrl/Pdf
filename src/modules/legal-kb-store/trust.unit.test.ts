/** بخش ۴ب‑۲ بدون پایگاه: هش محتوا، اعتبارسنجی ورودی کنش‌ها، اسکلت زمینه، نام شِمای ممیزی، قفل مهاجرت ۰۰۰۲. */
import { describe, expect, it } from "vitest";
import { versionContentHash, isContentHash } from "./content-hash";
import { collectExternalDocumentIds, MAX_EXTERNAL_DOCUMENTS, remapContextPaths } from "./incremental";
import { MIGRATIONS, migrationChecksum, renderStatement, type Migration } from "./migrations";
import { auditSchemaName, parseSchemaName } from "./naming";
import { StoreAbort } from "./errors";
import { parseActor, parseContent, parseExpectedHash, parseVersionRef } from "./version-input";

const abortOf = (fn: () => unknown): StoreAbort => {
  try {
    fn();
  } catch (e) {
    if (e instanceof StoreAbort) return e;
    throw e;
  }
  throw new Error("باید StoreAbort پرتاب می‌شد");
};

describe("versionContentHash", () => {
  const base = { text: "متن ساختگی", subparts: [{ kind: "note" as const, label: "1", text: "تبصره" }] };
  it("قطعی و ۶۴ رقم هگز است؛ قالب (v1) با مقدار طلایی قفل شده", () => {
    const h = versionContentHash(base);
    expect(h).toBe(versionContentHash({ ...base, subparts: [...base.subparts] }));
    expect(isContentHash(h)).toBe(true);
    // اگر قرمز شد قالب هش عوض شده؛ هش‌های ثبت‌شده در ممیزی دیگر قابل مقایسه نیستند. عوض نکنید (قالب تازه = v2).
    expect(h).toBe("4e24d07a1cecf7038d4c88edb0d1f5acb6ef415f316ec798368e5efdd73f4c95");
  });
  it("به متن، نوع/برچسب/متن تبصره و ترتیب حساس است", () => {
    const h = versionContentHash(base);
    const variants = [
      { ...base, text: "متن ساختگی " },
      { ...base, subparts: [{ kind: "clause" as const, label: "1", text: "تبصره" }] },
      { ...base, subparts: [{ kind: "note" as const, label: "2", text: "تبصره" }] },
      { ...base, subparts: [{ kind: "note" as const, label: "1", text: "تبصره." }] },
      { ...base, subparts: [] },
    ];
    for (const v of variants) expect(versionContentHash(v)).not.toBe(h);
    const two = [
      { kind: "note" as const, label: "1", text: "الف" },
      { kind: "note" as const, label: "2", text: "ب" },
    ];
    expect(versionContentHash({ text: "x", subparts: two })).not.toBe(versionContentHash({ text: "x", subparts: [...two].reverse() }));
  });
  it("مرز متن و تبصره مبهم نیست (متن «ab» ≠ متن «a» + تبصره‌ای با متن «b»)", () => {
    expect(versionContentHash({ text: "ab", subparts: [] })).not.toBe(versionContentHash({ text: "a", subparts: [{ kind: "note", label: "1", text: "b" }] }));
  });
  it("یونیکد بایت‌به‌بایت: نیم‌فاصله، ایموجی و ترکیبی در برابر پیش‌ترکیب‌شده فرق دارند", () => {
    expect(versionContentHash({ text: "می\u200cخواهم", subparts: [] })).not.toBe(versionContentHash({ text: "می خواهم", subparts: [] }));
    expect(versionContentHash({ text: "é", subparts: [] })).not.toBe(versionContentHash({ text: "e\u0301", subparts: [] }));
    expect(isContentHash(versionContentHash({ text: "😀", subparts: [] }))).toBe(true);
  });
  it("isContentHash: فقط ۶۴ رقم هگز با حروف کوچک", () => {
    for (const bad of ["", "abc", "A".repeat(64), "g".repeat(64), `${"a".repeat(64)}\n`, " " + "a".repeat(64), "a".repeat(63), "a".repeat(65), null, undefined, 5]) {
      expect(isContentHash(bad), String(bad)).toBe(false);
    }
    expect(isContentHash("a".repeat(64))).toBe(true);
  });
});

describe("parseVersionRef / parseExpectedHash", () => {
  it("شناسهٔ معتبر را متعارف می‌کند (رقم فارسی ماده)", () => {
    expect(parseVersionRef({ documentId: "sample-law", article: "۱۰ مکرر", validFrom: "2001-01-01" })).toEqual({ documentId: "sample-law", article: "10 مکرر", validFrom: "2001-01-01" });
  });
  it("ورودی نامعتبر INVALID_INPUT است", () => {
    const bad: unknown[] = [
      null,
      "x",
      [],
      {},
      { documentId: "Bad Id", article: "1", validFrom: "2001-01-01" },
      { documentId: "a", article: 1, validFrom: "2001-01-01" },
      { documentId: "a", article: "", validFrom: "2001-01-01" },
      { documentId: "a", article: "1", validFrom: "1403-01-01" },
      { documentId: "a", article: "1", validFrom: "2001-02-30" },
      { documentId: "a", article: "1", validFrom: null },
    ];
    for (const b of bad) expect(abortOf(() => parseVersionRef(b)).error.code, JSON.stringify(b)).toBe("INVALID_INPUT");
  });
  it("هش نامعتبر رد می‌شود", () => {
    expect(parseExpectedHash("a".repeat(64))).toBe("a".repeat(64));
    expect(abortOf(() => parseExpectedHash("xyz")).error.code).toBe("INVALID_INPUT");
  });
});

describe("parseActor (همان قواعد loadCorpus)", () => {
  const names = { actor: "reviewedBy", actedOn: "reviewedOn", reason: "reason" };
  const ok = (extra: Partial<{ actor: unknown; actedOn: unknown; reason: unknown; reasonRequired: boolean }> = {}) =>
    parseActor({ actor: "بازبین فرضی", actedOn: "2025-02-01", reason: undefined, reasonRequired: false, ...extra }, names);
  it("معتبر: دلیل اختیاری برای تأیید", () => {
    expect(ok()).toEqual({ actor: "بازبین فرضی", actedOn: "2025-02-01", reason: null });
    expect(ok({ reason: "خط اول\nخط دوم", reasonRequired: true }).reason).toBe("خط اول\nخط دوم");
  });
  it("دلیل لازم: خالی/فقط فاصله/نوع غلط رد می‌شود", () => {
    for (const reason of [undefined, null, "", "   \n", 5]) {
      expect(abortOf(() => ok({ reason, reasonRequired: true })).error.code, String(reason)).toBe("INVALID_INPUT");
    }
  });
  it("نام بازبین: خالی، چندخطی، کنترلی، Trojan‑Source، بیش از ۲۰۰ نویسه، نوع غلط ⇒ مسئلهٔ مسیر reviewedBy", () => {
    for (const actor of ["", "a\nb", "a\u0001b", "a\u202Eb", "ب".repeat(201), 5, null, undefined]) {
      const e = abortOf(() => ok({ actor })).error;
      expect(e.code, String(actor)).toBe("INVALID_INPUT");
      expect(e.issues?.some((i) => i.path.startsWith("reviewedBy")), JSON.stringify(e.issues)).toBe(true);
    }
  });
  it("تاریخ: جلالی به‌جای میلادی، غیرواقعی و نوع غلط ⇒ مسیر reviewedOn", () => {
    for (const actedOn of ["1403-05-05", "2025-13-01", "2025-02-30", "۲۰۲۵-۰۲-۰۱", 20250201, null]) {
      const e = abortOf(() => ok({ actedOn })).error;
      expect(e.issues?.some((i) => i.path.startsWith("reviewedOn")), String(actedOn)).toBe(true);
    }
  });
  it("دلیل: Trojan‑Source و بیش از ۲۰۰۰ نویسه رد می‌شود؛ مسیر reason", () => {
    for (const reason of ["a\u202Eb", "x".repeat(2001)]) {
      const e = abortOf(() => ok({ reason, reasonRequired: true })).error;
      expect(e.issues?.some((i) => i.path.startsWith("reason")), JSON.stringify(e.issues)).toBe(true);
    }
    expect(ok({ reason: "x".repeat(2000), reasonRequired: true }).reason).toHaveLength(2000);
  });
});

describe("parseContent", () => {
  const base = { label: "1", validFrom: "2001-01-01", validTo: null } as const;
  it("متن و تبصره‌ها را متعارف می‌کند (برچسب تبصرهٔ فارسی‌رقم)", () => {
    const c = parseContent({ text: "متن", subparts: [{ kind: "note", label: "۱", text: "ت" }] }, base);
    expect(c.subparts).toEqual([{ kind: "note", label: "1", text: "ت" }]);
  });
  it("نامعتبر: همه INVALID_INPUT با مسیرهای قابل‌فهم (text / subparts[i])", () => {
    const cases: Array<[unknown, unknown, string]> = [
      ["", [], "text"],
      [5, [], "text"],
      ["a\u202Eb", [], "text"],
      ["x".repeat(200_001), [], "text"],
      ["ok", {}, "subparts"],
      ["ok", [{ kind: "note", label: "1", text: "a" }, { kind: "note", label: "1", text: "b" }], "subparts[1]"],
      ["ok", [{ kind: "item", label: "1", text: "a" }], "subparts[0]"],
      ["ok", [{ kind: "note", label: "ABC", text: "a" }], "subparts[0]"],
      ["ok", [{ kind: "note", label: "1", text: "" }], "subparts[0]"],
    ];
    for (const [text, subparts, path] of cases) {
      const e = abortOf(() => parseContent({ text, subparts }, base)).error;
      expect(e.code).toBe("INVALID_INPUT");
      expect(e.issues?.some((i) => i.path.startsWith(path)), `${path}: ${JSON.stringify(e.issues)}`).toBe(true);
    }
  });
  it("CR و CRLF مثل ورود دادهٔ اصلی به LF نرمال می‌شود (قید پایگاه CR را رد می‌کند؛ ما فقط شکل متعارف را می‌نویسیم)", () => {
    expect(parseContent({ text: "a\r\nb\rc", subparts: [] }, base).text).toBe("a\nb\nc");
    expect(parseActor({ actor: "x", actedOn: "2025-02-01", reason: "r1\r\nr2", reasonRequired: true }, { actor: "a", actedOn: "b", reason: "c" }).reason).toBe("r1\nr2");
  });
  it("دقیقاً ۲۰۰٬۰۰۰ نویسه مجاز است", () => {
    expect(parseContent({ text: "ب".repeat(200_000), subparts: [] }, base).text).toHaveLength(200_000);
  });
});

describe("collectExternalDocumentIds", () => {
  const n = (documentId: unknown, article: string | null = null) => ({ documentId, article });
  it("شناسهٔ سندهای بیرون از ورودی را مرتب و یکتا برمی‌گرداند", () => {
    const input = {
      documents: [{ id: "new-doc" }],
      relations: [{ from: n("new-doc"), to: n("b-law", "1") }, { from: n("a-law"), to: n("b-law") }],
      rulings: [{ cites: [n("c-law"), n("new-doc"), n("a-law")] }],
    };
    expect(collectExternalDocumentIds(input)).toEqual(["a-law", "b-law", "c-law"]);
  });
  it("ورودی بدشکل null می‌دهد و هرگز پرتاب نمی‌کند", () => {
    for (const bad of [null, undefined, 5, "x", [], {}, { documents: {}, relations: [], rulings: [] }, { documents: [], relations: [], rulings: "x" }]) {
      expect(collectExternalDocumentIds(bad)).toBeNull();
    }
  });
  it("عنصرهای بدشکل نادیده گرفته می‌شوند؛ شناسهٔ غیرمتن یا بلندتر از ۶۴ هم", () => {
    const input = {
      documents: [null, 5, { id: 7 }],
      relations: [null, "x", { from: null, to: 5 }, { from: n(7), to: n("x".repeat(65)) }, { from: n("ok-doc"), to: undefined }],
      rulings: [null, { cites: "x" }, { cites: [null, 5, n(null)] }],
    };
    expect(collectExternalDocumentIds(input)).toEqual(["ok-doc"]);
  });
  it("شناسهٔ مخرب فقط یک رشته است (به‌عنوان پارامتر می‌رود)", () => {
    const evil = "x'); DROP TABLE a; --";
    expect(collectExternalDocumentIds({ documents: [], relations: [{ from: n(evil), to: n(evil) }], rulings: [] })).toEqual([evil]);
  });
  it("سقف شمار سندهای بیرونی ثابت و معقول است", () => {
    expect(MAX_EXTERNAL_DOCUMENTS).toBe(200);
  });
});

describe("remapContextPaths", () => {
  const issue = (path: string) => ({ code: "DANGLING_REF" as const, path, message: "m" });
  it("ایندکس سند و رابطه را از ترکیبی به ورودی برمی‌گرداند", () => {
    const out = remapContextPaths([issue("documents[3].articles[0].label"), issue("relations[5].to"), issue("rulings[0].cites[1]"), issue("$")], 2, 4);
    expect(out.map((i) => i.path)).toEqual(["documents[1].articles[0].label", "relations[1].to", "rulings[0].cites[1]", "$"]);
  });
  it("مسئله در بخش اسکلت پیشوند context. می‌گیرد و گم نمی‌شود", () => {
    const out = remapContextPaths([issue("documents[1].id"), issue("relations[0]")], 2, 1);
    expect(out.map((i) => i.path)).toEqual(["context.documents[1].id", "context.relations[0]"]);
  });
  it("ایندکس دقیقاً روی مرز: اولین عنصر نو ۰ می‌شود", () => {
    expect(remapContextPaths([issue("documents[2]")], 2, 0)[0]?.path).toBe("documents[0]");
    expect(remapContextPaths([issue("relations[4]")], 0, 4)[0]?.path).toBe("relations[0]");
  });
  it("کد و پیام را دست نمی‌زند", () => {
    expect(remapContextPaths([issue("documents[2]")], 2, 0)[0]).toEqual({ code: "DANGLING_REF", path: "documents[0]", message: "m" });
  });
});

describe("نام شِمای ممیزی", () => {
  it("<schema>_audit و شِمایی که خودش به _audit ختم شود رد می‌شود (برخورد دو store ممکن نیست)", () => {
    expect(auditSchemaName("legal_kb")).toBe("legal_kb_audit");
    const bad = parseSchemaName("legal_kb_audit");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("INVALID_INPUT");
    expect(parseSchemaName("x_audit").ok).toBe(false);
    expect(parseSchemaName("audit").ok).toBe(true);
    expect(parseSchemaName("my_audit_x").ok).toBe(true);
    expect(parseSchemaName("a".repeat(40)).ok).toBe(true);
    expect(auditSchemaName("a".repeat(40)).length).toBeLessThanOrEqual(63);
  });
  it("renderStatement هر دو جانگهدار را جایگزین می‌کند و بقیه را دست نمی‌زند", () => {
    expect(renderStatement("CREATE TABLE {{audit_schema}}.t (x {{schema}}.d) -- {{other}}", "kb")).toBe('CREATE TABLE "kb_audit".t (x "kb".d) -- {{other}}');
  });
});

describe("مهاجرت ۰۰۰۲ (ممیزی)", () => {
  const m2 = MIGRATIONS[1] as Migration;
  it("مهاجرت ۰۰۰۱ ویرایش‌ناپذیر است و ۰۰۰۲ به انتهای فهرست افزوده شده", () => {
    expect(MIGRATIONS.map((m) => m.name)).toEqual(["0001_init", "0002_version_audit"]);
    expect(migrationChecksum(MIGRATIONS[0] as Migration)).toBe("cab699756d994f0c0c93f85a6947eed9f12e5cbec8151cf1f8cfd83454bbb22f");
  });
  it("checksum مهاجرت ۰۰۰۲ ویرایش‌ناپذیر است (قفل شده؛ تغییر = مهاجرت ۰۰۰۳، نه ویرایش)", () => {
    // اگر قرمز شد، ۰۰۰۲ را ویرایش کرده‌اید. برگردانید و ۰۰۰۳ بسازید. این مقدار را عوض نکنید.
    expect(migrationChecksum(m2)).toBe("b827227d1d85a907b29d0a3c595cafb275160ae54c9639187d25293225ce094d");
  });
  it("فقط می‌سازد: هیچ DROP/ALTER، هیچ ارجاع به public، هر دستور CREATE است، و همه در شِمای ممیزی", () => {
    const text = m2.statements.join("\n");
    expect(text).not.toMatch(/\bDROP\b|\bALTER\b|\bTRUNCATE TABLE\b|\bpublic\./i);
    for (const s of m2.statements) expect(s.trim(), s).toMatch(/^CREATE (SCHEMA|TABLE|INDEX|FUNCTION|TRIGGER)\b/);
    for (const m of text.matchAll(/CREATE (?:TABLE|FUNCTION|SCHEMA) (\S+)/g)) expect(m[1], m[0]).toMatch(/^\{\{audit_schema\}\}/);
  });
  it("قیدهای کلیدی هستند: فقط‌افزودنی، دلیل لازم، بدون FK", () => {
    const text = m2.statements.join("\n");
    expect(text).toContain("version_audit_append_only");
    expect(text).toContain("BEFORE UPDATE OR DELETE");
    expect(text).toContain("BEFORE TRUNCATE");
    expect(text).toContain("version_audit_reason_required_ck");
    expect(text).not.toMatch(/FOREIGN KEY|REFERENCES/);
  });
});

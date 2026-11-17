/**
 * قیدهای خودِ پایگاه (دفاع در عمق): با SQL خام و **بدون** store/loadCorpus.
 * هدف: حتی اگر کسی از psql یا اسکریپت دیگری بنویسد، دادهٔ نامعتبر یا هم‌پوشان ذخیره نشود.
 * هر رد با کد SQLSTATE **و نام قید** سنجیده می‌شود (نه فقط «خطا داد»)، تا رد شدن به‌دلیل اشتباه، تست را سبز نکند.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dbDescribe, openTestKb, type TestKb } from "./test-db";

type Rejection = Readonly<{ code: string; constraint: string | undefined }>;

dbDescribe("legal-kb-store · قیدهای پایگاه (SQL خام)", () => {
  let kb: TestKb;
  beforeAll(async () => {
    kb = await openTestKb();
  });
  afterAll(async () => {
    await kb.drop();
  });
  beforeEach(async () => {
    await kb.raw(`TRUNCATE {{schema}}.ruling_cite, {{schema}}.ruling, {{schema}}.relation, {{schema}}.article_subpart, {{schema}}.article_version, {{schema}}.article, {{schema}}.document`);
  });

  const attempt = async (text: string, params: readonly unknown[] = []): Promise<Rejection | null> => {
    try {
      await kb.raw(text, params);
      return null;
    } catch (e) {
      const x = e as { code?: string; constraint?: string };
      return { code: String(x.code), constraint: x.constraint };
    }
  };
  const rejects = async (text: string, code: string, constraint?: string, params: readonly unknown[] = []) => {
    const r = await attempt(text, params);
    expect(r, `باید رد می‌شد: ${text.slice(0, 120)}`).not.toBeNull();
    expect(r?.code).toBe(code);
    if (constraint !== undefined) expect(r?.constraint).toBe(constraint);
  };
  const accepts = async (text: string, params: readonly unknown[] = []) => {
    const r = await attempt(text, params);
    expect(r, `باید پذیرفته می‌شد: ${text.slice(0, 120)}`).toBeNull();
  };

  // ───────── سازندهٔ ردیف‌های معتبر ─────────
  let seq = 0;
  /** ردیف‌سازِ عمومی: ستون‌های پیش‌فرضِ معتبر + بازنویسی دلخواه (مقدارها SQL خام‌اند). */
  const insertRow = (table: string, defaults: Record<string, string>, overrides: Record<string, string> = {}) => {
    const cols = { ...defaults, ...overrides };
    return `INSERT INTO {{schema}}.${table} (${Object.keys(cols).join(", ")}) VALUES (${Object.values(cols).join(", ")})`;
  };
  const doc = (id = "d1", overrides: Record<string, string> = {}) =>
    insertRow("document", { seq: String(++seq), id: `'${id}'`, kind: "'statute'", title: "'عنوان'", source_name: "'منبع'", source_kind: "'secondary'" }, overrides);
  const art = (d = "d1", label = "1", n = 1, r = 0) => `INSERT INTO {{schema}}.article (document_id, label, article_number, article_repeat) VALUES ('${d}', '${label}', ${n}, ${r})`;
  const ver = (from: string, to: string | null, d = "d1", label = "1", body = "متن") =>
    `INSERT INTO {{schema}}.article_version (document_id, article_label, valid_from, valid_to, body, source_name, source_kind) VALUES ('${d}', '${label}', '${from}', ${to === null ? "NULL" : `'${to}'`}, $$${body}$$, 'منبع', 'secondary')`;
  const seed = async () => {
    await kb.raw(doc("d1"));
    await kb.raw(art("d1", "1", 1, 0));
    await kb.raw(ver("2000-01-01", "2010-01-01"));
  };

  describe("بازهٔ اعتبار نسخه‌ها", () => {
    it("هم‌پوشانی با قید EXCLUDE رد می‌شود (23P01)", async () => {
      await seed();
      await rejects(ver("2005-01-01", "2006-01-01"), "23P01", "article_version_no_overlap"); // کاملاً داخل
      await rejects(ver("1999-01-01", "2000-01-02"), "23P01", "article_version_no_overlap"); // یک روز هم‌پوشانی
      await rejects(ver("2009-12-31", null), "23P01", "article_version_no_overlap"); // آخرین روز نسخهٔ قبل
      await rejects(ver("1990-01-01", null), "23P01", "article_version_no_overlap"); // بی‌پایان می‌پوشاند
    });
    it("مجاور (validTo = validFrom بعدی) و شکاف مجاز است؛ نیم‌باز", async () => {
      await seed();
      await accepts(ver("2010-01-01", "2015-01-01")); // مجاور
      await accepts(ver("2018-01-01", null)); // شکاف ۲۰۱۵..۲۰۱۸
      await accepts(ver("1990-01-01", "2000-01-01")); // مجاور از پایین
    });
    it("دو نسخهٔ بی‌پایان رد می‌شود", async () => {
      await seed();
      await accepts(ver("2010-01-01", null));
      await rejects(ver("2020-01-01", null), "23P01", "article_version_no_overlap");
    });
    it("ویرایش (UPDATE) هم نمی‌تواند هم‌پوشانی بسازد", async () => {
      await seed();
      await accepts(ver("2010-01-01", "2015-01-01"));
      await rejects(`UPDATE {{schema}}.article_version SET valid_to = '2012-01-01' WHERE valid_from = '2000-01-01'`, "23P01", "article_version_no_overlap");
      await rejects(`UPDATE {{schema}}.article_version SET valid_from = '2009-01-01' WHERE valid_from = '2010-01-01'`, "23P01", "article_version_no_overlap");
    });
    it("همان بازه برای ماده/سند دیگر آزاد است (قید به (سند، ماده) محدود است)", async () => {
      await seed();
      await kb.raw(art("d1", "2", 2, 0));
      await kb.raw(doc("d2"));
      await kb.raw(art("d2", "1", 1, 0));
      await accepts(ver("2000-01-01", "2010-01-01", "d1", "2"));
      await accepts(ver("2000-01-01", "2010-01-01", "d2", "1"));
    });
    it("validTo ≤ validFrom رد می‌شود؛ بازهٔ تهی هرگز از قید EXCLUDE فرار نمی‌کند", async () => {
      await seed();
      await rejects(ver("2020-01-01", "2020-01-01"), "23514", "article_version_interval_ck");
      const r = await attempt(ver("2021-01-01", "2020-01-01"));
      expect(r).not.toBeNull(); // یا قید بازه یا خطای ساخت daterange؛ در هر دو حال ذخیره نمی‌شود
      const n = await kb.raw(`SELECT count(*)::int AS n FROM {{schema}}.article_version`);
      expect(n[0]?.["n"]).toBe(1);
    });
    it("validFrom تکراری رد می‌شود", async () => {
      await seed();
      const r = await attempt(ver("2000-01-01", "2001-01-01"));
      expect(r).not.toBeNull();
      expect(["23505", "23P01"]).toContain(r?.code);
    });
    it("ستون تولیدشده را نمی‌توان نوشت", async () => {
      await seed();
      await rejects(`UPDATE {{schema}}.article_version SET valid_during = daterange('2000-01-01', '2001-01-01')`, "428C9");
    });
    it("بازهٔ تاریخ فنی ۱۸۰۰–۲۲۰۰؛ تاریخ جلالی به‌جای میلادی رد می‌شود", async () => {
      await seed();
      await accepts(ver("1800-01-01", "1900-01-01"));
      await rejects(ver("1799-12-31", "1799-12-31".replace("31", "31")), "23514"); // پیش از ۱۸۰۰
      await rejects(ver("1403-01-01", null), "23514", "iso_date_range_ck");
      await rejects(ver("2300-01-01", null), "23514", "iso_date_range_ck");
      await accepts(ver("2200-12-30", "2200-12-31"));
    });
  });

  describe("متن (نویسه‌های خطرناک)", () => {
    it("Trojan Source، کنترلی، BOM و CR رد می‌شوند", async () => {
      await seed();
      const bad = ["a\u202Eb", "a\u202Ab", "a\u2066b", "a\u2069b", "a\u0001b", "a\u0008b", "a\u000Bb", "a\u007Fb", "a\u0085b", "a\u009Fb", "a\uFEFFb", "a\rb"];
      for (const [i, body] of bad.entries()) {
        await rejects(ver(`${2100 + i}-01-01`, `${2100 + i}-01-02`, "d1", "1", body), "23514", "body_text_ck");
      }
    });
    it("نیم‌فاصله، LRM/RLM، خط جدید، تب، حروف فارسی و ایموجی مجاز است", async () => {
      await seed();
      await accepts(ver("2100-01-01", "2100-01-02", "d1", "1", "می\u200Cخواهم \u200Fابتدا\u200E\nخط دوم\tتب 😀 𝒳"));
    });
    it("متن خالی و بیش از ۲۰۰٬۰۰۰ نویسه رد می‌شود؛ دقیقاً ۲۰۰٬۰۰۰ مجاز", async () => {
      await seed();
      await rejects(ver("2100-01-01", "2100-01-02", "d1", "1", ""), "23514", "body_text_ck");
      await rejects(ver("2100-01-01", "2100-01-02", "d1", "1", "x".repeat(200_001)), "23514", "body_text_ck");
      await accepts(ver("2100-01-01", "2100-01-02", "d1", "1", "x".repeat(200_000)));
    });
    it("عنوان چندخطی یا بیش از حد رد می‌شود", async () => {
      await rejects(doc("d9", { title: "$$a\nb$$" }), "23514", "line_text_ck");
      await rejects(doc("d9", { title: `'${"x".repeat(301)}'` }), "23514", "document_title_len_ck");
      await rejects(doc("d9", { short_title: `'${"x".repeat(101)}'` }), "23514", "document_short_title_len_ck");
      await accepts(doc("d9", { title: `'${"x".repeat(300)}'` }));
    });
  });

  describe("سند و شناسه", () => {
    it("شناسهٔ سند: فقط حروف کوچک، عدد و خط تیره (حداکثر ۶۴)", async () => {
      for (const id of ["Upper", "under_score", "-lead", "trail-", "dou--ble", "sp ace", "x".repeat(65), "فارسی", ""]) {
        await rejects(doc(id), "23514", "document_id_ck");
      }
      for (const id of ["a", "law-1403", "x".repeat(64)]) await accepts(doc(id));
    });
    it("نوع سند ناشناخته رد می‌شود؛ شمارندهٔ seq مثبت و یکتا", async () => {
      await rejects(`INSERT INTO {{schema}}.document (seq, id, kind, title, source_name, source_kind) VALUES (1, 'k1', 'decree', 't', 's', 'secondary')`, "23514", "document_kind_ck");
      await rejects(`INSERT INTO {{schema}}.document (seq, id, kind, title, source_name, source_kind) VALUES (0, 'k2', 'statute', 't', 's', 'secondary')`, "23514", "document_seq_ck");
      await accepts(`INSERT INTO {{schema}}.document (seq, id, kind, title, source_name, source_kind) VALUES (500, 'k3', 'statute', 't', 's', 'secondary')`);
      await rejects(`INSERT INTO {{schema}}.document (seq, id, kind, title, source_name, source_kind) VALUES (500, 'k4', 'statute', 't', 's', 'secondary')`, "23505", "document_seq_uq");
      await rejects(`INSERT INTO {{schema}}.document (seq, id, kind, title, source_name, source_kind) VALUES (501, 'k3', 'statute', 't', 's', 'secondary')`, "23505", "document_pk");
    });
  });

  describe("منبع و بازبینی", () => {
    const withProv = (cols: string, vals: string) =>
      `INSERT INTO {{schema}}.document (seq, id, kind, title, source_name, source_kind, ${cols}) VALUES (${++seq}, 'p${seq}', 'statute', 't', 's', 'secondary', ${vals})`;

    it("«تأییدشده» بدون نام و تاریخ بازبین، و «تأییدنشده» با آن‌ها رد می‌شود", async () => {
      await rejects(withProv("review_status", `'legally-verified'`), "23514", "document_review_consistent_ck");
      await rejects(withProv("review_status, reviewed_by", `'legally-verified', 'علی'`), "23514", "document_review_consistent_ck");
      await rejects(withProv("review_status, reviewed_on", `'legally-verified', '2025-01-01'`), "23514", "document_review_consistent_ck");
      await rejects(withProv("reviewed_by", `'علی'`), "23514", "document_review_consistent_ck");
      await rejects(withProv("reviewed_on", `'2025-01-01'`), "23514", "document_review_consistent_ck");
      await accepts(withProv("review_status, reviewed_by, reviewed_on", `'legally-verified', 'علی', '2025-01-01'`));
      await accepts(withProv("review_status", `'pending-legal-review'`));
    });
    it("پیش‌فرض بازبینی «تأییدنشده» است", async () => {
      await kb.raw(doc("dflt"));
      const rows = await kb.raw(`SELECT review_status, reviewed_by FROM {{schema}}.document WHERE id = 'dflt'`);
      expect(rows[0]).toEqual({ review_status: "pending-legal-review", reviewed_by: null });
    });
    it("تأیید با UPDATE هم باید کامل باشد", async () => {
      await kb.raw(doc("up"));
      await rejects(`UPDATE {{schema}}.document SET review_status = 'legally-verified' WHERE id = 'up'`, "23514", "document_review_consistent_ck");
      await accepts(`UPDATE {{schema}}.document SET review_status = 'legally-verified', reviewed_by = 'علی', reviewed_on = '2025-01-01' WHERE id = 'up'`);
    });
    it("وضعیت و نوع منبع ناشناخته رد می‌شود", async () => {
      await rejects(withProv("review_status", `'approved'`), "23514"); // هم review_status_ck و هم review_consistent_ck رد می‌کنند
      await rejects(`INSERT INTO {{schema}}.document (seq, id, kind, title, source_name, source_kind) VALUES (${++seq}, 'sk', 'statute', 't', 's', 'wiki')`, "23514", "document_source_kind_ck");
    });
    it("نشانی فقط http(s) بدون فاصله و نشانه‌های خطرناک", async () => {
      for (const url of ["javascript:alert(1)", "data:text/html,x", "ftp://a.b", "//a.b", "http://", "https://a b", "https://a.b/\"x", "https://a.b/<x>", "https://a.b/\tx", `https://a.b/${"x".repeat(2100)}`]) {
        const r = await attempt(withProv("source_url", `$$${url}$$`));
        expect(r?.constraint, url.slice(0, 40)).toBe("document_source_url_ck");
      }
      for (const url of ["http://a.b", "HTTPS://A.B/path?q=1#x", "https://example.org/fictional-source"]) await accepts(withProv("source_url", `$$${url}$$`));
    });
  });

  describe("ماده", () => {
    beforeEach(async () => {
      await kb.raw(doc("d1"));
    });
    it("برچسب باید دقیقاً با (شماره، مکرر) بخواند", async () => {
      await rejects(art("d1", "02", 2, 0), "23514", "article_label_matches_ck");
      await rejects(art("d1", "2 مکرر", 2, 0), "23514", "article_label_matches_ck");
      await rejects(art("d1", "2", 2, 1), "23514", "article_label_matches_ck");
      await rejects(art("d1", "2 مکرر 1", 2, 1), "23514", "article_label_matches_ck");
      await rejects(art("d1", "۲", 2, 0), "23514", "article_label_matches_ck"); // رقم فارسی هرگز ذخیره نمی‌شود
      await rejects(art("d1", "واحده", 5, 0), "23514", "article_label_matches_ck");
      await accepts(art("d1", "2", 2, 0));
      await accepts(art("d1", "2 مکرر", 2, 1));
      await accepts(art("d1", "2 مکرر 2", 2, 2));
      await accepts(art("d1", "99999 مکرر 99", 99999, 99));
      await accepts(art("d1", "واحده", 0, 0));
    });
    it("حدود شماره و مکرر؛ «واحده» مکرر ندارد", async () => {
      await rejects(art("d1", "100000", 100000, 0), "23514", "article_number_ck");
      await rejects(art("d1", "1 مکرر 100", 1, 100), "23514", "article_repeat_ck");
      await rejects(art("d1", "واحده مکرر", 0, 1), "23514");
      await rejects(`INSERT INTO {{schema}}.article (document_id, label, article_number, article_repeat) VALUES ('d1', 'x', -1, 0)`, "23514");
    });
    it("ماده بدون سند (FK) رد می‌شود؛ حذف سندِ دارای ماده رد می‌شود", async () => {
      await rejects(art("nope", "1", 1, 0), "23503", "article_document_fk");
      await accepts(art("d1", "1", 1, 0));
      await rejects(`DELETE FROM {{schema}}.document WHERE id = 'd1'`, "23503", "article_document_fk");
    });
  });

  describe("تبصره/بند", () => {
    const sub = (kind: string, label: string, ordinal: number, from = "2000-01-01") =>
      `INSERT INTO {{schema}}.article_subpart (document_id, article_label, valid_from, ordinal, kind, label, body) VALUES ('d1', '1', '${from}', ${ordinal}, '${kind}', '${label}', 'متن')`;
    beforeEach(seed);

    it("برچسب: عدد ۱–۹۹۹ یا حروف فارسی؛ نه لاتین، نه صفر، نه ارقام عربی", async () => {
      for (const l of ["x", "0", "01", "1000", "٣", "۳", "a", "الف ب", "", "ا1", "ششششششش"]) await rejects(sub("clause", l, 0), "23514", "article_subpart_label_ck");
      for (const [i, l] of ["1", "999", "الف", "ب", "ششششش"].entries()) await accepts(sub("clause", l, i));
    });
    it("نوع و ترتیب؛ تکرار (نوع،برچسب) و تکرار ترتیب رد می‌شود", async () => {
      await rejects(sub("item", "1", 0), "23514", "article_subpart_kind_ck");
      await rejects(sub("note", "1", 100), "23514", "article_subpart_ordinal_ck");
      await accepts(sub("note", "1", 0));
      await rejects(sub("note", "1", 1), "23505", "article_subpart_pk");
      await rejects(sub("clause", "الف", 0), "23505", "article_subpart_order_uq");
      await accepts(sub("clause", "1", 1)); // «تبصرهٔ ۱» و «بند ۱» متفاوت‌اند
    });
    it("تبصره بدون نسخهٔ والد (FK مرکب) رد می‌شود", async () => {
      await rejects(sub("note", "1", 0, "2001-01-01"), "23503", "article_subpart_version_fk");
    });
    it("حذف نسخهٔ دارای تبصره رد می‌شود (حذف آبشاری وجود ندارد)", async () => {
      await accepts(sub("note", "1", 0));
      await rejects(`DELETE FROM {{schema}}.article_version`, "23503", "article_subpart_version_fk");
    });
  });

  describe("رابطه", () => {
    const rel = (type: string, f: [string, string | null], t: [string, string | null], eff: string | null = null) =>
      `INSERT INTO {{schema}}.relation (seq, type, from_document_id, from_article, to_document_id, to_article, effective_from, source_name, source_kind)
       VALUES (${++seq}, '${type}', '${f[0]}', ${f[1] === null ? "NULL" : `'${f[1]}'`}, '${t[0]}', ${t[1] === null ? "NULL" : `'${t[1]}'`}, ${eff === null ? "NULL" : `'${eff}'`}, 's', 'secondary')`;
    beforeEach(async () => {
      await seed();
      await kb.raw(art("d1", "2", 2, 0));
      await kb.raw(doc("d2"));
    });

    it("رابطهٔ خودبه‌خود رد می‌شود (سند و ماده)", async () => {
      await rejects(rel("refers-to", ["d1", null], ["d1", null]), "23514", "relation_not_self_ck");
      await rejects(rel("refers-to", ["d1", "1"], ["d1", "1"]), "23514", "relation_not_self_ck");
      await accepts(rel("refers-to", ["d1", "1"], ["d1", "2"]));
      await accepts(rel("refers-to", ["d1", null], ["d1", "1"])); // سند به ماده‌ی خودش: خودارجاع نیست
    });
    it("ارجاع معلق به سند یا ماده رد می‌شود؛ ماده تهی یعنی «کل سند»", async () => {
      await rejects(rel("amends", ["nope", null], ["d1", null]), "23503", "relation_from_document_fk");
      await rejects(rel("amends", ["d2", null], ["nope", null]), "23503", "relation_to_document_fk");
      await rejects(rel("amends", ["d2", null], ["d1", "77"]), "23503", "relation_to_article_fk");
      await rejects(rel("amends", ["d1", "77"], ["d2", null]), "23503", "relation_from_article_fk");
      await accepts(rel("amends", ["d2", null], ["d1", "1"]));
    });
    it("رابطهٔ تکراری رد می‌شود (حتی با تاریخ اثر تهی)؛ با تاریخ متفاوت مجاز", async () => {
      await accepts(rel("repeals", ["d2", null], ["d1", null]));
      await rejects(rel("repeals", ["d2", null], ["d1", null]), "23505", "relation_dedupe_uq");
      await accepts(rel("repeals", ["d2", null], ["d1", null], "2020-01-01"));
      await rejects(rel("repeals", ["d2", null], ["d1", null], "2020-01-01"), "23505", "relation_dedupe_uq");
      await accepts(rel("amends", ["d2", null], ["d1", null])); // نوع دیگر
    });
    it("نوع نامعتبر و یادداشت بلند رد می‌شود", async () => {
      await rejects(rel("hates", ["d2", null], ["d1", null]), "23514", "relation_type_ck");
      await rejects(
        `INSERT INTO {{schema}}.relation (seq, type, from_document_id, to_document_id, note, source_name, source_kind) VALUES (${++seq}, 'amends', 'd2', 'd1', '${"x".repeat(2001)}', 's', 'secondary')`,
        "23514",
        "relation_note_len_ck",
      );
    });
    it("حذف سند یا ماده‌ای که رابطه به آن ارجاع دارد رد می‌شود", async () => {
      await accepts(rel("amends", ["d2", null], ["d1", "2"]));
      await rejects(`DELETE FROM {{schema}}.article WHERE label = '2'`, "23503", "relation_to_article_fk");
      await rejects(`DELETE FROM {{schema}}.document WHERE id = 'd2'`, "23503", "relation_from_document_fk");
    });
  });

  describe("رأی", () => {
    const ruling = (id: string, kind = "judgment", overrides: Record<string, string> = {}) =>
      insertRow(
        "ruling",
        { seq: String(++seq), id: `'${id}'`, kind: `'${kind}'`, number: "'1'", issuer: "'مرجع'", issued_on: "'2020-01-01'", body: "'متن'", source_name: "'s'", source_kind: "'secondary'" },
        overrides,
      );
    const cite = (rid: string, ordinal: number, d: string, a: string | null) =>
      `INSERT INTO {{schema}}.ruling_cite (ruling_id, ordinal, document_id, article_label) VALUES ('${rid}', ${ordinal}, '${d}', ${a === null ? "NULL" : `'${a}'`})`;
    beforeEach(seed);

    it("شناسه، نوع و حدود", async () => {
      await rejects(ruling("Bad_ID"), "23514", "ruling_id_ck");
      await rejects(ruling("r1", "verdict"), "23514", "ruling_kind_ck");
      await rejects(ruling("r1", "judgment", { number: `$$${"x".repeat(101)}$$` }), "23514", "ruling_number_len_ck");
      await accepts(ruling("r1"));
      await rejects(ruling("r1"), "23505", "ruling_pk");
    });
    it("ارجاع رأی: معلق رد؛ تکراری رد؛ ترتیب ≤ ۱۹۹", async () => {
      await accepts(ruling("r1"));
      await rejects(cite("r1", 0, "nope", null), "23503", "ruling_cite_document_fk");
      await rejects(cite("r1", 0, "d1", "55"), "23503", "ruling_cite_article_fk");
      await rejects(cite("zzz", 0, "d1", null), "23503", "ruling_cite_ruling_fk");
      await accepts(cite("r1", 0, "d1", null));
      await rejects(cite("r1", 1, "d1", null), "23505", "ruling_cite_dedupe_uq");
      await accepts(cite("r1", 1, "d1", "1"));
      await rejects(cite("r1", 200, "d1", "1"), "23514", "ruling_cite_ordinal_ck");
    });
  });

  describe("شِما و نوع‌ها", () => {
    it("هیچ جدولی در public ساخته نشده و همهٔ جدول‌ها کلید اصلی دارند", async () => {
      const noPk = await kb.raw(
        `SELECT t.table_name FROM information_schema.tables t
         WHERE t.table_schema = $1 AND t.table_type = 'BASE TABLE'
           AND NOT EXISTS (SELECT 1 FROM information_schema.table_constraints c
                           WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name AND c.constraint_type = 'PRIMARY KEY')`,
        [kb.schema],
      );
      expect(noPk).toEqual([]);
    });
    it("نام همهٔ قیدها صریح و بلندتر از نام خودکار پستگرس نیست (برای نگاشت پایدار خطا)", async () => {
      const auto = await kb.raw(
        `SELECT conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
         WHERE n.nspname = $1 AND (conname ~ '_check[0-9]*$' OR conname ~ '_pkey$' OR conname ~ '_fkey$' OR conname ~ '_key$' OR conname ~ '_excl$')`,
        [kb.schema],
      );
      expect(auto).toEqual([]);
    });
  });
});

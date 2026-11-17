/**
 * ⚠️ نمونهٔ **ساختگی** — هیچ قانون، ماده یا رأی واقعی نیست و هیچ ارزش حقوقی ندارد.
 * فقط برای تست و میز آزمایش (و تست ماژول‌های بعدی مثل store/verifier) است. هرگز به‌عنوان «داده‌ٔ قانون» استفاده نشود.
 * داده‌های واقعی فقط از منبع رسمی و با تأیید حقوقدان وارد می‌شوند (AGENTS.md).
 *
 * ساختار عمداً همهٔ حالت‌های مهم را دارد: نسخه‌های پیوسته، شکاف اعتبار، ماده‌ی نسخ‌شده، «مکرر»، «واحده»،
 * تبصره/بند، رابطه (اجرا، اصلاح، نسخ) و رأی؛ و ترکیب تأییدشده/تأییدنشده.
 */

const pending = (sourceName: string) => ({
  sourceName,
  sourceUrl: null,
  sourceKind: "secondary" as const,
  retrievedOn: "2025-01-10",
  review: { status: "pending-legal-review" as const, reviewedBy: null, reviewedOn: null },
});

const verified = (sourceName: string) => ({
  sourceName,
  sourceUrl: "https://example.org/fictional-source",
  sourceKind: "official" as const,
  retrievedOn: "2025-01-10",
  review: { status: "legally-verified" as const, reviewedBy: "بازبین فرضی", reviewedOn: "2025-02-01" },
});

export const FICTIONAL_SAMPLE_CORPUS = {
  documents: [
    {
      id: "sample-law",
      kind: "statute",
      title: "قانون نمونهٔ آزمایشی (ساختگی)",
      shortTitle: "قانون نمونه",
      enactedOn: "2001-01-01",
      provenance: pending("منبع ساختگی"),
      articles: [
        {
          label: "1",
          versions: [
            { validFrom: "2001-01-01", validTo: "2010-06-01", text: "متن ساختگی ماده ۱، نسخهٔ نخست. بدون ارزش حقوقی.", subparts: [], provenance: verified("منبع ساختگی ۱") },
            {
              validFrom: "2010-06-01",
              validTo: "2015-01-01",
              text: "متن ساختگی ماده ۱، نسخهٔ دوم. بدون ارزش حقوقی.",
              subparts: [{ kind: "note", label: "1", text: "تبصرهٔ ساختگی نسخهٔ دوم." }],
              provenance: pending("منبع ساختگی ۲"),
            },
            // شکاف عمدی: ۲۰۱۵-۰۱-۰۱ تا ۲۰۱۸-۰۱-۰۱ ماده معتبر نیست.
            { validFrom: "2018-01-01", validTo: null, text: "متن ساختگی ماده ۱، نسخهٔ سوم. بدون ارزش حقوقی.", subparts: [], provenance: pending("منبع ساختگی ۳") },
          ],
        },
        {
          label: "2",
          versions: [
            {
              validFrom: "2001-01-01",
              validTo: null,
              text: "متن ساختگی ماده ۲.",
              subparts: [
                { kind: "note", label: "1", text: "تبصرهٔ ۱ ساختگی." },
                { kind: "clause", label: "الف", text: "بند الف ساختگی." },
                { kind: "clause", label: "ب", text: "بند ب ساختگی." },
              ],
              provenance: verified("منبع ساختگی ۴"),
            },
          ],
        },
        {
          label: "2 مکرر",
          versions: [{ validFrom: "2012-05-01", validTo: null, text: "متن ساختگی ماده ۲ مکرر.", subparts: [], provenance: pending("منبع ساختگی ۵") }],
        },
      ],
    },
    {
      id: "sample-single-act",
      kind: "statute",
      title: "قانون ماده‌واحده‌ای نمونه (ساختگی؛ نسخ‌شده)",
      shortTitle: null,
      enactedOn: "2005-01-01",
      provenance: pending("منبع ساختگی ۶"),
      articles: [
        {
          label: "واحده",
          versions: [{ validFrom: "2005-01-01", validTo: "2020-01-01", text: "متن ساختگی ماده واحده.", subparts: [], provenance: pending("منبع ساختگی ۶") }],
        },
      ],
    },
    {
      id: "sample-regulation",
      kind: "regulation",
      title: "آیین‌نامهٔ اجرایی نمونه (ساختگی)",
      shortTitle: null,
      enactedOn: "2003-01-01",
      provenance: pending("منبع ساختگی ۷"),
      articles: [
        { label: "1", versions: [{ validFrom: "2003-01-01", validTo: null, text: "متن ساختگی ماده ۱ آیین‌نامه.", subparts: [], provenance: pending("منبع ساختگی ۷") }] },
      ],
    },
  ],
  relations: [
    {
      type: "implements",
      from: { documentId: "sample-regulation", article: null },
      to: { documentId: "sample-law", article: null },
      effectiveFrom: "2003-01-01",
      note: null,
      provenance: pending("منبع ساختگی ۷"),
    },
    {
      type: "amends",
      from: { documentId: "sample-law", article: "2" },
      to: { documentId: "sample-law", article: "1" },
      effectiveFrom: "2010-06-01",
      note: "رابطهٔ ساختگی برای آزمون.",
      provenance: pending("منبع ساختگی ۸"),
    },
    {
      type: "repeals",
      from: { documentId: "sample-law", article: null },
      to: { documentId: "sample-single-act", article: null },
      effectiveFrom: "2020-01-01",
      note: null,
      provenance: pending("منبع ساختگی ۸"),
    },
  ],
  rulings: [
    {
      id: "sample-unity-ruling-1",
      kind: "unity-ruling",
      number: "1",
      issuer: "مرجع ساختگی",
      issuedOn: "2016-03-01",
      title: "رأی نمونهٔ ساختگی",
      text: "متن ساختگی رأی. بدون ارزش حقوقی.",
      cites: [{ documentId: "sample-law", article: "2" }],
      provenance: pending("منبع ساختگی ۹"),
    },
  ],
} as const;

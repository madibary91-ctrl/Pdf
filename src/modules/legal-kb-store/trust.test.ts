/**
 * مسیر اعتماد (پایگاه واقعی): تأیید، پس‌گرفتن، اصلاح، ممیزی فقط‌افزودنی، هم‌زمانی و ارتقای مهاجرت.
 * هر شکست باید «چیزی تغییر نکرد» باشد: پس از هر رد، وضعیت پایگاه و ممیزی با پیش از آن برابر سنجیده می‌شود.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  FICTIONAL_SAMPLE_CORPUS,
  buildCorpusIndex,
  loadCorpus,
  resolveCitation as pureResolve,
  type Corpus,
  type VersionLookup,
} from "@/modules/legal-kb-schema";
import { versionContentHash } from "./content-hash";
import { dbDescribe, openTestKb, type TestKb } from "./test-db";
import type { AuditEntry, StoreResult, VersionChange, VersionRef } from "./types";
import type { J } from "./test-corpus";

const sampleJson = (): J => JSON.parse(JSON.stringify(FICTIONAL_SAMPLE_CORPUS));
const must = <T>(r: StoreResult<T>): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error).slice(0, 600));
  return r.value;
};
const failure = <T>(r: StoreResult<T>) => {
  if (r.ok) throw new Error("باید شکست می‌خورد");
  return r.error;
};

/** نسخه‌های نمونه: ۱/۲۰۱۰ (تأییدنشده، با تبصره)، ۱/۲۰۱۸ (تأییدنشده)، ۲/۲۰۰۱ (تأییدشده، با ۳ تبصره/بند). */
const PENDING: VersionRef = { documentId: "sample-law", article: "1", validFrom: "2018-01-01" };
const PENDING_WITH_NOTE: VersionRef = { documentId: "sample-law", article: "1", validFrom: "2010-06-01" };
const VERIFIED: VersionRef = { documentId: "sample-law", article: "2", validFrom: "2001-01-01" };

const REVIEWER = { reviewedBy: "حقوقدان فرضی", reviewedOn: "2025-03-01" };
const ACTOR = { revokedBy: "حقوقدان فرضی", revokedOn: "2025-03-02", reason: "دلیل ساختگی برای آزمون" };
const FIX = { correctedBy: "ویراستار فرضی", correctedOn: "2025-03-03", reason: "اصلاح غلط تایپی (ساختگی)" };

dbDescribe("legal-kb-store · مسیر اعتماد و ممیزی (پایگاه واقعی)", () => {
  const opened: TestKb[] = [];
  /** هر تست store تازه با نمونهٔ ساختگی می‌گیرد (تست‌ها به هم وابسته نیستند). */
  const fresh = async (): Promise<TestKb> => {
    const kb = await openTestKb();
    opened.push(kb);
    must(await kb.store.insertCorpus(sampleJson()));
    return kb;
  };
  // هر تست store خودش را همان‌جا می‌بندد (شمار اتصال پستگرس محدود است و فایل‌های تست هم‌زمان اجرا می‌شوند).
  afterEach(async () => {
    for (const kb of opened.splice(0)) await kb.drop();
  });

  const current = async (kb: TestKb, ref: VersionRef) => {
    const r = must(await kb.store.resolveCitation({ documentId: ref.documentId, article: ref.article, subpart: null }, ref.validFrom));
    if (r.status !== "found") throw new Error(`not found: ${r.status}`);
    return r.version;
  };
  const hashOf = async (kb: TestKb, ref: VersionRef) => versionContentHash(await current(kb, ref));
  const auditAll = async (kb: TestKb): Promise<readonly AuditEntry[]> => must(await kb.store.listAudit(null, { limit: 1000 }));
  /** عکس کامل وضعیت: Corpus + آمار + ممیزی؛ برای «هیچ تغییری نکرد». */
  const snapshot = async (kb: TestKb) => ({ corpus: must(await kb.store.readCorpus()), stats: must(await kb.store.stats()), audit: await auditAll(kb) });

  const verify = async (kb: TestKb, ref: VersionRef, extra: Record<string, unknown> = {}) =>
    kb.store.markVerified(ref, { expectedHash: await hashOf(kb, ref), ...REVIEWER, ...extra });

  describe("markVerified", () => {
    it("تأیید: وضعیت، بازبین و تاریخ ثبت می‌شود؛ هش محتوا ثابت می‌ماند؛ ممیزی همان‌جا نوشته می‌شود", async () => {
      const kb = await fresh();
      const hash = await hashOf(kb, PENDING);
      const change = must(await verify(kb, PENDING));
      expect(change.action).toBe("verify");
      expect(change.ref).toEqual(PENDING);
      expect(change.before.review).toEqual({ status: "pending-legal-review", reviewedBy: null, reviewedOn: null });
      expect(change.after.review).toEqual({ status: "legally-verified", ...REVIEWER });
      expect(change.before.contentHash).toBe(hash);
      expect(change.after.contentHash).toBe(hash);

      const v = await current(kb, PENDING);
      expect(v.provenance.review).toEqual({ status: "legally-verified", ...REVIEWER });
      const looked = must(await kb.store.resolveCitation({ documentId: "sample-law", article: "1", subpart: null }, "2018-01-01"));
      expect(looked.status === "found" && looked.verified).toBe(true);
      expect(must(await kb.store.stats()).verifiedVersions).toBe(3);

      const audit = await auditAll(kb);
      expect(audit).toHaveLength(1);
      const e = audit[0] as AuditEntry;
      expect(e).toMatchObject({ seq: change.auditSeq, action: "verify", ref: PENDING, actor: REVIEWER.reviewedBy, actedOn: REVIEWER.reviewedOn, reason: null });
      expect(e.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(e.before).toEqual(change.before);
      expect(e.after).toEqual(change.after);
    });

    it("Corpus بعد از تأیید = Corpus پیشین با فقط همان یک بازبینی عوض‌شده (تفاضلی)", async () => {
      const kb = await fresh();
      const before = must(await kb.store.readCorpus());
      must(await verify(kb, PENDING));
      const expected: Corpus = {
        ...before,
        documents: before.documents.map((d) =>
          d.id !== "sample-law"
            ? d
            : {
                ...d,
                articles: d.articles.map((a) =>
                  a.label !== "1"
                    ? a
                    : {
                        ...a,
                        versions: a.versions.map((v) =>
                          v.validFrom !== "2018-01-01" ? v : { ...v, provenance: { ...v.provenance, review: { status: "legally-verified" as const, ...REVIEWER } } },
                        ),
                      },
                ),
              },
        ),
      };
      expect(must(await kb.store.readCorpus())).toEqual(expected);
    });

    it("هش کهنه (متن در این فاصله عوض شده): CONFLICT و هیچ‌چیز تغییر نمی‌کند", async () => {
      const kb = await fresh();
      const stale = await hashOf(kb, PENDING);
      must(await kb.store.correctVersion(PENDING, { expectedHash: stale, text: "متن اصلاح‌شدهٔ ساختگی", subparts: [], ...FIX }));
      const before = await snapshot(kb);
      const e = failure(await kb.store.markVerified(PENDING, { expectedHash: stale, ...REVIEWER }));
      expect(e.code).toBe("CONFLICT");
      expect(await snapshot(kb)).toEqual(before);
    });

    it("تأییدشده را دوباره تأیید نمی‌کند (بازنویسی بازبین بی‌صدا ممنوع)", async () => {
      const kb = await fresh();
      const before = await snapshot(kb);
      const e = failure(await verify(kb, VERIFIED, { reviewedBy: "شخص دیگر" }));
      expect(e.code).toBe("CONFLICT");
      expect(await snapshot(kb)).toEqual(before);
      expect((await current(kb, VERIFIED)).provenance.review.reviewedBy).toBe("بازبین فرضی");
    });

    it("نسخهٔ ناموجود: NOT_FOUND (سند، ماده یا تاریخ)", async () => {
      const kb = await fresh();
      const h = "a".repeat(64);
      for (const ref of [
        { ...PENDING, validFrom: "2018-01-02" },
        { ...PENDING, article: "77" },
        { ...PENDING, documentId: "no-such-law" },
      ]) {
        expect(failure(await kb.store.markVerified(ref, { expectedHash: h, ...REVIEWER })).code, JSON.stringify(ref)).toBe("NOT_FOUND");
      }
      expect(await auditAll(kb)).toEqual([]);
    });

    it("ورودی نامعتبر: INVALID_INPUT با مسئله‌های مسیردار و بدون هیچ تغییر", async () => {
      const kb = await fresh();
      const before = await snapshot(kb);
      const good = { expectedHash: await hashOf(kb, PENDING), ...REVIEWER };
      const bads: Array<[string, unknown, unknown]> = [
        ["بازبین خالی", PENDING, { ...good, reviewedBy: "" }],
        ["بازبین کنترلی", PENDING, { ...good, reviewedBy: "a\u0007b" }],
        ["بازبین Trojan", PENDING, { ...good, reviewedBy: "a\u202Eb" }],
        ["بازبین بلند", PENDING, { ...good, reviewedBy: "ب".repeat(201) }],
        ["تاریخ جلالی", PENDING, { ...good, reviewedOn: "1404-01-01" }],
        ["هش کوتاه", PENDING, { ...good, expectedHash: "abc" }],
        ["ورودی null", PENDING, null],
        ["ref null", null, good],
        ["ref بدشکل", { documentId: "x" }, good],
        ["تاریخ ref نامعتبر", { ...PENDING, validFrom: "2018-02-30" }, good],
      ];
      for (const [name, ref, input] of bads) {
        const e = failure(await kb.store.markVerified(ref as VersionRef, input as never));
        expect(e.code, name).toBe("INVALID_INPUT");
      }
      expect(await snapshot(kb)).toEqual(before);
    });

    it("۸ تأیید هم‌زمان همان نسخه: دقیقاً یکی موفق، بقیه CONFLICT، یک ممیزی", async () => {
      const kb = await fresh();
      const hash = await hashOf(kb, PENDING);
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => kb.store.markVerified(PENDING, { expectedHash: hash, reviewedBy: `بازبین ${i}`, reviewedOn: "2025-03-01" })));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      for (const r of results) if (!r.ok) expect(r.error.code).toBe("CONFLICT");
      const audit = await auditAll(kb);
      expect(audit).toHaveLength(1);
      expect((await current(kb, PENDING)).provenance.review.reviewedBy).toBe(audit[0]?.actor);
    });

    it("قطعی (نه زمان‌بندی‌محور): تأیید پشت قفل ردیف می‌ماند و پس از تغییر متن، هش تازه را می‌بیند ⇒ CONFLICT", async () => {
      const kb = await fresh();
      const stale = await hashOf(kb, PENDING);
      const where = `document_id = 'sample-law' AND article_label = '1' AND valid_from = '2018-01-01'`;
      const holder = await kb.pool.connect();
      let verification: Promise<StoreResult<VersionChange>> | undefined;
      try {
        await holder.query("BEGIN");
        await holder.query(`SELECT 1 FROM "${kb.schema}".article_version WHERE ${where} FOR UPDATE`);
        verification = kb.store.markVerified(PENDING, { expectedHash: stale, ...REVIEWER });
        const state = await Promise.race([verification.then(() => "finished"), new Promise((resolve) => setTimeout(() => resolve("blocked"), 400))]);
        expect(state).toBe("blocked"); // پشت قفل ردیف منتظر است، نه اینکه متن کهنه را بخواند
        await holder.query(`UPDATE "${kb.schema}".article_version SET body = 'متنِ تغییر‌یافته در همین فاصله' WHERE ${where}`);
        await holder.query("COMMIT");
      } catch (e) {
        await holder.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        holder.release();
      }
      expect(failure(await (verification as Promise<StoreResult<VersionChange>>)).code).toBe("CONFLICT");
      expect(await auditAll(kb)).toEqual([]);
      expect((await current(kb, PENDING)).provenance.review.status).toBe("pending-legal-review");
    });

    it("مسابقهٔ تأیید و اصلاح (۱۲ دور): هرگز «تأییدشده» روی متنی نمی‌نشیند که بازبین ندیده است", async () => {
      for (let round = 0; round < 12; round++) {
        const kb = await fresh();
        const seen = await hashOf(kb, PENDING);
        const [v, c] = await Promise.all([
          kb.store.markVerified(PENDING, { expectedHash: seen, ...REVIEWER }),
          kb.store.correctVersion(PENDING, { expectedHash: seen, text: `متن اصلاحی دور ${round}`, subparts: [], ...FIX }),
        ]);
        expect(c.ok, `اصلاح باید همیشه موفق شود (دور ${round})`).toBe(true);
        const now = await current(kb, PENDING);
        const audit = await auditAll(kb);
        if (v.ok) {
          // تأیید پیش از اصلاح نشست؛ اصلاح بعدی آن را پاک کرده است.
          expect(now.provenance.review.status).toBe("pending-legal-review");
          expect(audit.map((x) => x.action)).toEqual(["verify", "correct"]);
        } else {
          expect(v.error.code).toBe("CONFLICT");
          expect(audit.map((x) => x.action)).toEqual(["correct"]);
        }
        // پایا: اگر تأییدشده است، آخرین تأیید دقیقاً روی همین محتواست.
        if (now.provenance.review.status === "legally-verified") {
          const lastVerify = [...audit].reverse().find((x) => x.action === "verify");
          expect(lastVerify?.after.contentHash).toBe(versionContentHash(now));
        }
      }
    });
  });

  describe("revokeVerification", () => {
    it("پس‌گرفتن: بازبین و تاریخ پاک، دلیل در ممیزی، وضعیت قبل در before می‌ماند", async () => {
      const kb = await fresh();
      const change = must(await kb.store.revokeVerification(VERIFIED, { expectedHash: await hashOf(kb, VERIFIED), ...ACTOR }));
      expect(change.before.review).toEqual({ status: "legally-verified", reviewedBy: "بازبین فرضی", reviewedOn: expect.any(String) });
      expect(change.after.review).toEqual({ status: "pending-legal-review", reviewedBy: null, reviewedOn: null });
      expect((await current(kb, VERIFIED)).provenance.review.status).toBe("pending-legal-review");
      expect(must(await kb.store.stats()).verifiedVersions).toBe(1);
      const [e] = await auditAll(kb);
      expect(e).toMatchObject({ action: "revoke", actor: ACTOR.revokedBy, actedOn: ACTOR.revokedOn, reason: ACTOR.reason });
    });

    it("دلیل لازم است؛ خالی، فقط‌فاصله یا غایب رد می‌شود", async () => {
      const kb = await fresh();
      const before = await snapshot(kb);
      const base = { expectedHash: await hashOf(kb, VERIFIED), revokedBy: "x", revokedOn: "2025-03-02" };
      for (const reason of [undefined, "", "  \n ", 7]) {
        expect(failure(await kb.store.revokeVerification(VERIFIED, { ...base, reason } as never)).code, String(reason)).toBe("INVALID_INPUT");
      }
      expect(await snapshot(kb)).toEqual(before);
    });

    it("تأییدنشده یا هش کهنه: CONFLICT", async () => {
      const kb = await fresh();
      const before = await snapshot(kb);
      expect(failure(await kb.store.revokeVerification(PENDING, { expectedHash: await hashOf(kb, PENDING), ...ACTOR })).code).toBe("CONFLICT");
      expect(failure(await kb.store.revokeVerification(VERIFIED, { expectedHash: "0".repeat(64), ...ACTOR })).code).toBe("CONFLICT");
      expect(failure(await kb.store.revokeVerification({ ...VERIFIED, validFrom: "2002-02-02" }, { expectedHash: "0".repeat(64), ...ACTOR })).code).toBe("NOT_FOUND");
      expect(await snapshot(kb)).toEqual(before);
    });

    it("زنجیرهٔ تأیید ← پس‌گرفتن ← تأیید: seq صعودی و before هر مرحله = after مرحلهٔ پیش (ممیزی پیوسته)", async () => {
      const kb = await fresh();
      must(await verify(kb, PENDING));
      must(await kb.store.revokeVerification(PENDING, { expectedHash: await hashOf(kb, PENDING), ...ACTOR }));
      must(await verify(kb, PENDING, { reviewedBy: "بازبین دوم", reviewedOn: "2025-04-01" }));
      const audit = await auditAll(kb);
      expect(audit.map((e) => e.action)).toEqual(["verify", "revoke", "verify"]);
      expect(audit.map((e) => e.seq)).toEqual([...audit.map((e) => e.seq)].sort((a, b) => a - b));
      expect(new Set(audit.map((e) => e.seq)).size).toBe(3);
      for (let i = 1; i < audit.length; i++) expect(audit[i]?.before).toEqual(audit[i - 1]?.after);
      expect((await current(kb, PENDING)).provenance.review.reviewedBy).toBe("بازبین دوم");
    });
  });

  describe("correctVersion", () => {
    it("اصلاح غلط تایپی: متن عوض، تأیید پاک، بازه دست‌نخورده، متن پیشین در ممیزی (قابل بازیابی)", async () => {
      const kb = await fresh();
      const old = await current(kb, VERIFIED);
      const change = must(
        await kb.store.correctVersion(VERIFIED, { expectedHash: versionContentHash(old), text: "متن ساختگی ماده ۲ (اصلاح‌شده).", subparts: old.subparts, ...FIX }),
      );
      expect(change.before.review.status).toBe("legally-verified");
      expect(change.after.review).toEqual({ status: "pending-legal-review", reviewedBy: null, reviewedOn: null });
      const now = await current(kb, VERIFIED);
      expect(now.text).toBe("متن ساختگی ماده ۲ (اصلاح‌شده).");
      expect(now.validFrom).toBe(old.validFrom);
      expect(now.validTo).toBe(old.validTo);
      expect(now.subparts).toEqual(old.subparts);
      expect(now.provenance.sourceName).toBe(old.provenance.sourceName);
      expect(must(await kb.store.stats()).verifiedVersions).toBe(1);
      const [e] = await auditAll(kb);
      expect(e?.before.text).toBe(old.text); // بازیابی متن پیشین
      expect(e?.before.contentHash).toBe(versionContentHash(old));
      expect(e?.after.contentHash).toBe(versionContentHash(now));
      expect(e).toMatchObject({ action: "correct", actor: FIX.correctedBy, reason: FIX.reason });
    });

    it("جایگزینی تبصره/بندها: کم، زیاد، برچسب فارسی‌رقم، ترتیب حفظ؛ تبصرهٔ حذف‌شده unknown-subpart", async () => {
      const kb = await fresh();
      const old = await current(kb, VERIFIED);
      expect(old.subparts).toHaveLength(3);
      must(
        await kb.store.correctVersion(VERIFIED, {
          expectedHash: versionContentHash(old),
          text: old.text,
          subparts: [
            { kind: "clause", label: "ب", text: "بند ب اصلاح‌شده" },
            { kind: "note", label: "۱", text: "تبصرهٔ ۱ اصلاح‌شده" },
            { kind: "note", label: "2", text: "تبصرهٔ تازه" },
          ],
          ...FIX,
        }),
      );
      const now = await current(kb, VERIFIED);
      expect(now.subparts).toEqual([
        { kind: "clause", label: "ب", text: "بند ب اصلاح‌شده" },
        { kind: "note", label: "1", text: "تبصرهٔ ۱ اصلاح‌شده" },
        { kind: "note", label: "2", text: "تبصرهٔ تازه" },
      ]);
      const gone = must(await kb.store.resolveCitation({ documentId: "sample-law", article: "2", subpart: { kind: "clause", label: "الف" } }, "2020-01-01"));
      expect(gone.status).toBe("unknown-subpart");
      const [e] = await auditAll(kb);
      expect(e?.before.subparts).toEqual(old.subparts);
    });

    it("برداشتن همهٔ تبصره‌ها", async () => {
      const kb = await fresh();
      const old = await current(kb, VERIFIED);
      must(await kb.store.correctVersion(VERIFIED, { expectedHash: versionContentHash(old), text: old.text, subparts: [], ...FIX }));
      expect((await current(kb, VERIFIED)).subparts).toEqual([]);
      expect(must(await kb.store.stats()).subparts).toBe(1); // فقط تبصرهٔ نسخهٔ ۲۰۱۰ می‌ماند
    });

    it("نسخهٔ تأییدنشده هم اصلاح می‌شود و تأییدنشده می‌ماند؛ CRLF متعارف می‌شود", async () => {
      const kb = await fresh();
      const old = await current(kb, PENDING_WITH_NOTE);
      const change = must(await kb.store.correctVersion(PENDING_WITH_NOTE, { expectedHash: versionContentHash(old), text: "خط یک\r\nخط دو", subparts: old.subparts, ...FIX }));
      expect(change.after.text).toBe("خط یک\nخط دو");
      expect(change.after.review.status).toBe("pending-legal-review");
    });

    it("یونیکد: نیم‌فاصله، ایموجی و متن ۲۰۰٬۰۰۰ نویسه بایت‌به‌بایت ذخیره می‌شود", async () => {
      const kb = await fresh();
      for (const text of ["می\u200cخواهم 😀 e\u0301 \u200f", "ب".repeat(200_000)]) {
        const old = await current(kb, PENDING);
        must(await kb.store.correctVersion(PENDING, { expectedHash: versionContentHash(old), text, subparts: [], ...FIX }));
        expect((await current(kb, PENDING)).text).toBe(text);
      }
    });

    it("محتوای نامعتبر: INVALID_INPUT با مسیر مسئله و بدون هیچ تغییر (حتی ممیزی)", async () => {
      const kb = await fresh();
      const old = await current(kb, VERIFIED);
      const before = await snapshot(kb);
      const base = { expectedHash: versionContentHash(old), text: "x", subparts: [], ...FIX };
      const bads: Array<[string, Record<string, unknown>, string]> = [
        ["متن خالی", { text: "" }, "text"],
        ["متن غیرمتن", { text: 5 }, "text"],
        ["متن بیش از حد", { text: "x".repeat(200_001) }, "text"],
        ["Trojan Source", { text: "a\u202Eb" }, "text"],
        ["نویسهٔ کنترلی", { text: "a\u0000b" }, "text"],
        ["تبصرهٔ تکراری", { subparts: [{ kind: "note", label: "1", text: "a" }, { kind: "note", label: "1", text: "b" }] }, "subparts[1]"],
        ["نوع تبصرهٔ ناشناخته", { subparts: [{ kind: "item", label: "1", text: "a" }] }, "subparts[0]"],
        ["برچسب نامعتبر", { subparts: [{ kind: "note", label: "x1", text: "a" }] }, "subparts[0]"],
        ["subparts غیرآرایه", { subparts: "x" }, "subparts"],
        ["کلید ناشناخته در تبصره", { subparts: [{ kind: "note", label: "1", text: "a", extra: 1 }] }, "subparts[0]"],
      ];
      for (const [name, patch, path] of bads) {
        const e = failure(await kb.store.correctVersion(VERIFIED, { ...base, ...patch } as never));
        expect(e.code, name).toBe("INVALID_INPUT");
        expect(e.issues?.some((i) => i.path.startsWith(path)), `${name}: ${JSON.stringify(e.issues)}`).toBe(true);
      }
      expect(await snapshot(kb)).toEqual(before);
    });

    it("اصلاح بی‌تغییر (همان محتوا) رد می‌شود تا ممیزی آلوده نشود", async () => {
      const kb = await fresh();
      const old = await current(kb, VERIFIED);
      const before = await snapshot(kb);
      const e = failure(await kb.store.correctVersion(VERIFIED, { expectedHash: versionContentHash(old), text: old.text, subparts: old.subparts, ...FIX }));
      expect(e.code).toBe("INVALID_INPUT");
      expect(await snapshot(kb)).toEqual(before);
    });

    it("دلیل لازم؛ هش کهنه CONFLICT؛ نسخهٔ ناموجود NOT_FOUND", async () => {
      const kb = await fresh();
      const old = await current(kb, PENDING);
      const before = await snapshot(kb);
      const base = { expectedHash: versionContentHash(old), text: "متن تازه", subparts: [], ...FIX };
      expect(failure(await kb.store.correctVersion(PENDING, { ...base, reason: "" })).code).toBe("INVALID_INPUT");
      expect(failure(await kb.store.correctVersion(PENDING, { ...base, expectedHash: "f".repeat(64) })).code).toBe("CONFLICT");
      expect(failure(await kb.store.correctVersion({ ...PENDING, validFrom: "2019-01-01" }, base)).code).toBe("NOT_FOUND");
      expect(await snapshot(kb)).toEqual(before);
    });

    it("اصلاحِ پشت‌سرهم: هر بار باید هش تازه را بدهید (اصلاح دوباره با هش کهنه CONFLICT)", async () => {
      const kb = await fresh();
      const h0 = await hashOf(kb, PENDING);
      must(await kb.store.correctVersion(PENDING, { expectedHash: h0, text: "یک", subparts: [], ...FIX }));
      expect(failure(await kb.store.correctVersion(PENDING, { expectedHash: h0, text: "دو", subparts: [], ...FIX })).code).toBe("CONFLICT");
      must(await kb.store.correctVersion(PENDING, { expectedHash: await hashOf(kb, PENDING), text: "دو", subparts: [], ...FIX }));
      const audit = await auditAll(kb);
      expect(audit.map((e) => e.after.text)).toEqual(["یک", "دو"]);
      expect(audit[1]?.before).toEqual(audit[0]?.after);
    });

    it("پس از اصلاح و تأیید دوباره: موتور پایگاه با موتور خالص روی همان Corpus یکسان است (تفاضلی)", async () => {
      const kb = await fresh();
      const old = await current(kb, PENDING_WITH_NOTE);
      must(
        await kb.store.correctVersion(PENDING_WITH_NOTE, {
          expectedHash: versionContentHash(old),
          text: "متن اصلاحی",
          subparts: [{ kind: "note", label: "3", text: "تبصرهٔ ۳" }],
          ...FIX,
        }),
      );
      must(await verify(kb, PENDING_WITH_NOTE));
      const corpus = must(await kb.store.readCorpus());
      expect(loadCorpus(corpus).ok).toBe(true);
      const index = buildCorpusIndex(corpus);
      const days = ["2001-01-01", "2010-05-31", "2010-06-01", "2014-12-31", "2015-01-01", "2017-12-31", "2018-01-01", "2030-01-01"];
      let compared = 0;
      for (const d of corpus.documents) {
        for (const a of d.articles) {
          for (const day of days) {
            for (const subpart of [null, { kind: "note" as const, label: "3" }, { kind: "note" as const, label: "1" }]) {
              const ref = { documentId: d.id, article: a.label, subpart };
              const pure = pureResolve(index, ref, day);
              expect(pure.ok).toBe(true);
              const db = must(await kb.store.resolveCitation(ref, day));
              expect(db, `${d.id}/${a.label}@${day}`).toEqual((pure as { ok: true; value: VersionLookup }).value);
              compared++;
            }
          }
        }
      }
      expect(compared).toBeGreaterThan(100);
    });
  });

  describe("ممیزی فقط‌افزودنی (خود پایگاه)", () => {
    const auditTable = (kb: TestKb) => `"${kb.schema}_audit".version_audit`;
    const attempt = async (kb: TestKb, sqlText: string, params: readonly unknown[] = []) => {
      try {
        await kb.raw(sqlText, params);
        return null;
      } catch (e) {
        const x = e as { code?: string; constraint?: string; message?: string };
        return { code: x.code, constraint: x.constraint, message: x.message ?? "" };
      }
    };

    it("UPDATE، DELETE و TRUNCATE رد می‌شود (تریگر، کد 23000) و رکورد دست‌نخورده می‌ماند", async () => {
      const kb = await fresh();
      must(await verify(kb, PENDING));
      const before = await auditAll(kb);
      for (const stmt of [`UPDATE ${auditTable(kb)} SET actor = 'x'`, `DELETE FROM ${auditTable(kb)}`, `TRUNCATE ${auditTable(kb)}`]) {
        const r = await attempt(kb, stmt);
        expect(r?.code, stmt).toBe("23000");
        expect(r?.message, stmt).toContain("append-only");
      }
      expect(await auditAll(kb)).toEqual(before);
    });

    it("قیدهای جدول: کنش ناشناخته، دلیل لازم برای revoke/correct، دلیل بلند، snapshot غیرشیء، بازبین بلند", async () => {
      const kb = await fresh();
      const ins = (action: string, reason: string | null, snap = "{}", actor = "a") =>
        attempt(
          kb,
          `INSERT INTO ${auditTable(kb)} (action, document_id, article_label, valid_from, actor, acted_on, reason, before_snapshot, after_snapshot)
           VALUES ($1, 'sample-law', '1', '2018-01-01', $2, '2025-01-01', $3, $4::jsonb, '{}'::jsonb)`,
          [action, actor, reason, snap],
        );
      expect((await ins("delete", null))?.constraint).toBe("version_audit_action_ck");
      expect((await ins("revoke", null))?.constraint).toBe("version_audit_reason_required_ck");
      expect((await ins("correct", null))?.constraint).toBe("version_audit_reason_required_ck");
      expect((await ins("verify", "x".repeat(2001)))?.constraint).toBe("version_audit_reason_len_ck");
      expect((await ins("verify", null, "[]"))?.constraint).toBe("version_audit_snapshots_ck");
      expect((await ins("verify", null, "{}", "ب".repeat(201)))?.constraint).toMatch(/version_audit_actor_len_ck|line_text_ck/);
      expect(await ins("verify", null)).toBeNull();
    });

    it("ممیزی از ردیف نسخه بیشتر عمر می‌کند (کلید خارجی ندارد): حذفِ دستیِ نسخه، ممیزی را نمی‌برد", async () => {
      const kb = await fresh();
      must(await verify(kb, PENDING));
      await kb.raw(`DELETE FROM {{schema}}.article_version WHERE document_id = 'sample-law' AND article_label = '1' AND valid_from = '2018-01-01'`);
      const audit = await auditAll(kb);
      expect(audit).toHaveLength(1);
      expect(audit[0]?.ref).toEqual(PENDING);
      // و کنش تازه روی نسخهٔ حذف‌شده NOT_FOUND است، نه خطای خام.
      expect(failure(await kb.store.markVerified(PENDING, { expectedHash: "a".repeat(64), ...REVIEWER })).code).toBe("NOT_FOUND");
    });

    it("اتمی بودن: اگر نوشتن ممیزی شکست بخورد، تغییر نسخه هم برمی‌گردد (تغییرِ بی‌ممیزی ممکن نیست)", async () => {
      const kb = await fresh();
      const before = await snapshot(kb);
      await kb.raw(`CREATE FUNCTION {{schema}}.boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom' USING ERRCODE = '23514'; END $$`);
      await kb.raw(`CREATE TRIGGER boom BEFORE INSERT ON ${auditTable(kb)} FOR EACH ROW EXECUTE FUNCTION {{schema}}.boom()`);
      const old = await current(kb, VERIFIED);
      const results = [
        await verify(kb, PENDING),
        await kb.store.revokeVerification(VERIFIED, { expectedHash: versionContentHash(old), ...ACTOR }),
        await kb.store.correctVersion(VERIFIED, { expectedHash: versionContentHash(old), text: "x", subparts: [], ...FIX }),
      ];
      for (const r of results) expect(failure(r).code).toBe("CONSTRAINT_VIOLATION");
      await kb.raw(`DROP TRIGGER boom ON ${auditTable(kb)}`);
      expect(await snapshot(kb)).toEqual(before);
      must(await verify(kb, PENDING)); // و پس از رفع، دوباره کار می‌کند
    });

    it("دفاع در عمق: اگر پایگاه چیزی غیر از محتوای اعتبارسنجی‌شده نگه دارد (تریگر دست‌کاری‌کننده)، تراکنش برمی‌گردد", async () => {
      const kb = await fresh();
      const old = await current(kb, VERIFIED);
      const before = await snapshot(kb);
      await kb.raw(`CREATE FUNCTION {{schema}}.tamper() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.body := NEW.body || 'x'; RETURN NEW; END $$`);
      await kb.raw(`CREATE TRIGGER tamper BEFORE UPDATE OF body ON {{schema}}.article_version FOR EACH ROW EXECUTE FUNCTION {{schema}}.tamper()`);
      const e = failure(await kb.store.correctVersion(VERIFIED, { expectedHash: versionContentHash(old), text: "متن تازه", subparts: [], ...FIX }));
      expect(e.code).toBe("DB_ERROR");
      await kb.raw(`DROP TRIGGER tamper ON {{schema}}.article_version`);
      expect(await snapshot(kb)).toEqual(before);
    });

    it("رکورد ممیزیِ خراب (snapshot بدشکل): listAudit حدس نمی‌زند، CORRUPT_DATA", async () => {
      const kb = await fresh();
      await kb.raw(
        `INSERT INTO ${auditTable(kb)} (action, document_id, article_label, valid_from, actor, acted_on, before_snapshot, after_snapshot)
         VALUES ('verify', 'sample-law', '1', '2018-01-01', 'a', '2025-01-01', '{}'::jsonb, '{}'::jsonb)`,
      );
      expect(failure(await kb.store.listAudit(null)).code).toBe("CORRUPT_DATA");
    });
  });

  describe("listAudit", () => {
    it("فیلتر بر اساس نسخه، ترتیب صعودی با seq، و limit", async () => {
      const kb = await fresh();
      must(await verify(kb, PENDING));
      must(await verify(kb, PENDING_WITH_NOTE));
      must(await kb.store.revokeVerification(PENDING, { expectedHash: await hashOf(kb, PENDING), ...ACTOR }));
      expect((await auditAll(kb)).map((e) => e.action)).toEqual(["verify", "verify", "revoke"]);
      const forPending = must(await kb.store.listAudit(PENDING));
      expect(forPending.map((e) => e.action)).toEqual(["verify", "revoke"]);
      expect(must(await kb.store.listAudit(VERIFIED))).toEqual([]);
      expect(must(await kb.store.listAudit(null, { limit: 2 })).map((e) => e.action)).toEqual(["verify", "verify"]);
      expect(must(await kb.store.listAudit(null, { limit: 1 }))).toHaveLength(1);
    });
    it("limit و ref نامعتبر: INVALID_INPUT", async () => {
      const kb = await fresh();
      for (const limit of [0, -1, 1001, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(failure(await kb.store.listAudit(null, { limit })).code, String(limit)).toBe("INVALID_INPUT");
      }
      expect(failure(await kb.store.listAudit({ documentId: "x" } as never)).code).toBe("INVALID_INPUT");
      expect(must(await kb.store.listAudit(null, { limit: 1000 }))).toEqual([]);
    });
    it("نتیجهٔ بازگشتی مستقل از پایگاه است (دستکاری آن، ممیزی را عوض نمی‌کند)", async () => {
      const kb = await fresh();
      must(await verify(kb, PENDING));
      const a = (await auditAll(kb))[0] as AuditEntry;
      (a as { actor: string }).actor = "دست‌کاری";
      expect((await auditAll(kb))[0]?.actor).toBe(REVIEWER.reviewedBy);
    });
  });

  describe("ارتقای مهاجرت و جداسازی", () => {
    it("شِمای ممیزی فقط یک جدول دارد و شِمای دانش همان ۸ جدول مانده است؛ public دست‌نخورده", async () => {
      const kb = await fresh();
      const tables = async (schema: string) => (await kb.raw(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1`, [schema])).map((r) => r["table_name"]);
      expect(await tables(`${kb.schema}_audit`)).toEqual(["version_audit"]);
      expect(await tables(kb.schema)).toHaveLength(8);
      expect(await tables("public")).not.toContain("version_audit");
    });

    it("پایگاه در وضعیت ۰۰۰۱: همهٔ کنش‌ها NOT_MIGRATED؛ migrate() فقط ۰۰۰۲ را اعمال می‌کند و داده سالم می‌ماند", async () => {
      const kb = await fresh();
      const corpusBefore = must(await kb.store.readCorpus());
      // شبیه‌سازی «پایگاهِ قدیمی»: ممیزی و ردیف دفترش برداشته می‌شود.
      await kb.raw(`DROP SCHEMA "${kb.schema}_audit" CASCADE`);
      await kb.raw(`DELETE FROM {{schema}}.migration_ledger WHERE name = '0002_version_audit'`);
      expect(must(await kb.store.migrationStatus())).toEqual({ applied: ["0001_init"], pending: ["0002_version_audit"] });
      const h = "a".repeat(64);
      const results: Array<StoreResult<unknown>> = [
        await kb.store.markVerified(PENDING, { expectedHash: h, ...REVIEWER }),
        await kb.store.revokeVerification(VERIFIED, { expectedHash: h, ...ACTOR }),
        await kb.store.correctVersion(PENDING, { expectedHash: h, text: "x", subparts: [], ...FIX }),
        await kb.store.listAudit(null),
        await kb.store.insertIncremental({ documents: [], relations: [], rulings: [] }),
      ];
      for (const r of results) expect(failure(r).code).toBe("NOT_MIGRATED");
      expect(must(await kb.store.migrate())).toEqual({ applied: ["0002_version_audit"], alreadyApplied: ["0001_init"] });
      expect(must(await kb.store.readCorpus())).toEqual(corpusBefore);
      must(await verify(kb, PENDING));
    });

    it("دو store با شِمای جدا: ممیزی یکدیگر را نمی‌بینند", async () => {
      const a = await fresh();
      const b = await fresh();
      must(await verify(a, PENDING));
      expect(await auditAll(a)).toHaveLength(1);
      expect(await auditAll(b)).toHaveLength(0);
    });

    it("ممیزی هنگام مهاجرتِ هم‌زمان ۶ فرایند سالم است (۰۰۰۲ دقیقاً یک بار)", async () => {
      const kb = await openTestKb({ migrate: false });
      opened.push(kb);
      const rs = await Promise.all(Array.from({ length: 6 }, () => kb.store.migrate()));
      for (const r of rs) expect(r.ok).toBe(true);
      const ledger = await kb.raw(`SELECT name FROM {{schema}}.migration_ledger ORDER BY name`);
      expect(ledger.map((r) => r["name"])).toEqual(["0001_init", "0002_version_audit"]);
    });
  });

  it("تأیید ← اصلاح ← تأیید دوباره روی نسخهٔ واحد: نتیجه یک VersionChange کامل با شکل ثابت دارد", async () => {
    const kb = await fresh();
    const c: VersionChange = must(await verify(kb, PENDING));
    expect(Object.keys(c).sort()).toEqual(["action", "after", "auditSeq", "before", "ref"]);
    expect(Object.keys(c.after).sort()).toEqual(["contentHash", "review", "subparts", "text"]);
  });
});

/**
 * مسیر اعتماد (بخش ۴ب‑۲): تأیید حقوقدان، پس‌گرفتن تأیید، اصلاح متن، و خواندن ممیزی (داخلی).
 *
 * اصل‌ها (ADR-0005):
 *  - **هر تغییر یک رکورد ممیزی فقط‌افزودنی دارد، در همان تراکنش.** یا هر دو ثبت می‌شوند یا هیچ‌کدام؛ تغییرِ بی‌ممیزی ممکن نیست.
 *  - **compare-and-set با هش محتوا:** کنشگر هشِ متنی را می‌دهد که دیده؛ اگر متن در این فاصله عوض شده باشد ⇒ `CONFLICT`.
 *    (بدون این، «تأیید» می‌توانست روی متنی بنشیند که حقوقدان هرگز ندیده است.)
 *  - **اصلاح متن، تأیید را پاک می‌کند:** متنِ اصلاح‌شده همیشه به «در انتظار بازبینی» برمی‌گردد (حتی اگر پیش‌تر تأییدشده بود)؛
 *    تأییدِ قبلی در ممیزی می‌ماند. اصلاحِ بی‌تغییر (همان متن) رد می‌شود تا ممیزی آلوده نشود.
 *  - **قفل ردیف** (`SELECT … FOR UPDATE`) روی همان نسخه: کنش‌های هم‌زمان روی یک نسخه پشت هم اجرا می‌شوند و دومی، پس از انتظار،
 *    نسخهٔ تازه (و هش تازه) را می‌بیند. قفل مشورتیِ سراسریِ درج عمداً نیست: این کنش‌ها `seq` سراسری نمی‌گیرند، پس تأییدِ دو نسخهٔ
 *    مختلف نباید پشت هم صف بکشد. (آزمون جهشی ثابت کرد بدون قفل ردیف، «۸ تأیید هم‌زمان» و «مسابقهٔ تأیید/اصلاح» می‌شکنند.)
 *  - ورودی‌ها از همان قواعد `loadCorpus` می‌گذرند (`version-input.ts`)؛ «پس از اعمال» دوباره از پایگاه خوانده و ممیزی می‌شود
 *    (ثبتِ آنچه واقعاً ذخیره شد، نه آنچه قصدش بود).
 */
import { sql } from "drizzle-orm";
import type { IsoDate, Subpart } from "@/modules/legal-kb-schema";
import { versionContentHash } from "./content-hash";
import { CorruptRowError, StoreAbort, toStoreError } from "./errors";
import { assertCurrent } from "./migrate";
import { auditRef, tableRef } from "./naming";
import { DATE_OUT, isoDate, provenanceSelect, readVersionRow, str, strOrNull } from "./rows";
import { subpartsOf } from "./temporal";
import { parseActor, parseContent, parseExpectedHash, parseVersionRef } from "./version-input";
import type {
  AuditAction,
  AuditEntry,
  AuditQueryOptions,
  CorrectInput,
  KbDatabase,
  KbExecutor,
  RevokeInput,
  StoreResult,
  VerifyInput,
  VersionChange,
  VersionRef,
  VersionSnapshot,
} from "./types";

const REPEATABLE_READ_ONLY = { isolationLevel: "repeatable read", accessMode: "read only" } as const;

type Loaded = Readonly<{ snapshot: VersionSnapshot }>;

function snapshotOf(version: Readonly<{ text: string; subparts: readonly Subpart[]; provenance: { review: VersionSnapshot["review"] } }>): VersionSnapshot {
  return {
    text: version.text,
    subparts: version.subparts,
    review: version.provenance.review,
    contentHash: versionContentHash(version),
  };
}

/** نسخه را (در صورت `lock`، با قفل ردیف) می‌خواند؛ نبودن ⇒ `NOT_FOUND`. */
async function loadVersion(tx: KbExecutor, schema: string, ref: VersionRef, lock: boolean): Promise<Loaded> {
  const rows = (
    await tx.execute(
      sql`SELECT ${DATE_OUT("valid_from", "valid_from")}, ${DATE_OUT("valid_to", "valid_to")}, body, ${provenanceSelect("")}
          FROM ${tableRef(schema, "article_version")}
          WHERE document_id = ${ref.documentId} AND article_label = ${ref.article} AND valid_from = ${ref.validFrom}::date
          ${lock ? sql`FOR UPDATE` : sql``}`,
    )
  ).rows;
  const row = rows[0];
  if (row === undefined) {
    throw new StoreAbort({ code: "NOT_FOUND", message: "نسخه‌ای با این شناسه (سند، ماده، شروع اعتبار) در پایگاه نیست." });
  }
  const version = readVersionRow(row, await subpartsOf(tx, schema, ref.documentId, ref.article, ref.validFrom));
  return { snapshot: snapshotOf(version) };
}

function requireHash(current: VersionSnapshot, expected: string): void {
  if (current.contentHash !== expected) {
    throw new StoreAbort({
      code: "CONFLICT",
      message: "متن (یا تبصره/بندهای) این نسخه با آنچه بازبین دیده تفاوت دارد (هش محتوا نمی‌خواند)؛ نسخه را دوباره بخوانید و بازبینی کنید. چیزی تغییر نکرد.",
    });
  }
}

type AuditWrite = Readonly<{ action: AuditAction; ref: VersionRef; actor: string; actedOn: IsoDate; reason: string | null; before: VersionSnapshot; after: VersionSnapshot }>;

async function writeAudit(tx: KbExecutor, schema: string, w: AuditWrite): Promise<number> {
  const res = await tx.execute(
    sql`INSERT INTO ${auditRef(schema)} (action, document_id, article_label, valid_from, actor, acted_on, reason, before_snapshot, after_snapshot)
        VALUES (${w.action}, ${w.ref.documentId}, ${w.ref.article}, ${w.ref.validFrom}::date, ${w.actor}, ${w.actedOn}::date, ${w.reason},
                ${JSON.stringify(w.before)}::jsonb, ${JSON.stringify(w.after)}::jsonb)
        RETURNING seq::text AS seq`,
  );
  return parseSeq(res.rows[0]?.["seq"]);
}

function parseSeq(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw new CorruptRowError("ستون seq");
  return n;
}

/** تراکنشِ نوشتن: سپر مهاجرت، سپس خودِ کنش (که ردیف را قفل می‌کند). هر خطا (StoreAbort/pg) ⇒ `StoreResult` شکست و برگشت کامل. */
async function mutate(db: KbDatabase, schema: string, run: (tx: KbExecutor) => Promise<VersionChange>): Promise<StoreResult<VersionChange>> {
  try {
    const change = await db.transaction(async (tx) => {
      await assertCurrent(tx, schema);
      return run(tx);
    });
    return { ok: true, value: change };
  } catch (e) {
    return { ok: false, error: toStoreError(e) };
  }
}

/** پیش‌شرط‌های ورودی؛ پرتاب = شکست بی‌دسترسی به پایگاه. */
function guard<T>(fn: () => T): StoreResult<T> {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    return { ok: false, error: toStoreError(e) };
  }
}

export async function markVerified(db: KbDatabase, schema: string, ref: VersionRef, input: VerifyInput): Promise<StoreResult<VersionChange>> {
  const parsed = guard(() => {
    const r = parseVersionRef(ref);
    const i = (typeof input === "object" && input !== null ? input : {}) as Partial<Record<keyof VerifyInput, unknown>>;
    const actor = parseActor({ actor: i.reviewedBy, actedOn: i.reviewedOn, reason: undefined, reasonRequired: false }, { actor: "reviewedBy", actedOn: "reviewedOn", reason: "reason" });
    return { r, hash: parseExpectedHash(i.expectedHash), actor };
  });
  if (!parsed.ok) return parsed;
  const { r, hash, actor } = parsed.value;

  return mutate(db, schema, async (tx) => {
    const before = (await loadVersion(tx, schema, r, true)).snapshot;
    requireHash(before, hash);
    if (before.review.status === "legally-verified") {
      throw new StoreAbort({ code: "CONFLICT", message: "این نسخه از قبل تأییدشده است؛ ابتدا تأیید را پس بگیرید (revokeVerification) اگر لازم است." });
    }
    await tx.execute(
      sql`UPDATE ${tableRef(schema, "article_version")}
          SET review_status = 'legally-verified', reviewed_by = ${actor.actor}, reviewed_on = ${actor.actedOn}::date
          WHERE document_id = ${r.documentId} AND article_label = ${r.article} AND valid_from = ${r.validFrom}::date`,
    );
    const after = (await loadVersion(tx, schema, r, false)).snapshot;
    const auditSeq = await writeAudit(tx, schema, { action: "verify", ref: r, actor: actor.actor, actedOn: actor.actedOn, reason: null, before, after });
    return { action: "verify", ref: r, auditSeq, before, after };
  });
}

export async function revokeVerification(db: KbDatabase, schema: string, ref: VersionRef, input: RevokeInput): Promise<StoreResult<VersionChange>> {
  const parsed = guard(() => {
    const r = parseVersionRef(ref);
    const i = (typeof input === "object" && input !== null ? input : {}) as Partial<Record<keyof RevokeInput, unknown>>;
    const actor = parseActor({ actor: i.revokedBy, actedOn: i.revokedOn, reason: i.reason, reasonRequired: true }, { actor: "revokedBy", actedOn: "revokedOn", reason: "reason" });
    return { r, hash: parseExpectedHash(i.expectedHash), actor };
  });
  if (!parsed.ok) return parsed;
  const { r, hash, actor } = parsed.value;

  return mutate(db, schema, async (tx) => {
    const before = (await loadVersion(tx, schema, r, true)).snapshot;
    requireHash(before, hash);
    if (before.review.status !== "legally-verified") {
      throw new StoreAbort({ code: "CONFLICT", message: "این نسخه تأییدشده نیست؛ چیزی برای پس‌گرفتن نیست." });
    }
    await tx.execute(
      sql`UPDATE ${tableRef(schema, "article_version")}
          SET review_status = 'pending-legal-review', reviewed_by = NULL, reviewed_on = NULL
          WHERE document_id = ${r.documentId} AND article_label = ${r.article} AND valid_from = ${r.validFrom}::date`,
    );
    const after = (await loadVersion(tx, schema, r, false)).snapshot;
    const auditSeq = await writeAudit(tx, schema, { action: "revoke", ref: r, actor: actor.actor, actedOn: actor.actedOn, reason: actor.reason, before, after });
    return { action: "revoke", ref: r, auditSeq, before, after };
  });
}

export async function correctVersion(db: KbDatabase, schema: string, ref: VersionRef, input: CorrectInput): Promise<StoreResult<VersionChange>> {
  const parsedHead = guard(() => {
    const r = parseVersionRef(ref);
    const i = (typeof input === "object" && input !== null ? input : {}) as Partial<Record<keyof CorrectInput, unknown>>;
    const actor = parseActor({ actor: i.correctedBy, actedOn: i.correctedOn, reason: i.reason, reasonRequired: true }, { actor: "correctedBy", actedOn: "correctedOn", reason: "reason" });
    // محتوا پیش از گرفتن قفل و بدون پایگاه اعتبارسنجی می‌شود (به بازهٔ نسخه وابسته نیست).
    const content = parseContent({ text: i.text, subparts: i.subparts }, { label: r.article, validFrom: r.validFrom, validTo: null });
    return { r, hash: parseExpectedHash(i.expectedHash), actor, content };
  });
  if (!parsedHead.ok) return parsedHead;
  const { r, hash, actor, content } = parsedHead.value;

  return mutate(db, schema, async (tx) => {
    const current = await loadVersion(tx, schema, r, true);
    requireHash(current.snapshot, hash);
    if (versionContentHash(content) === current.snapshot.contentHash) {
      throw new StoreAbort({ code: "INVALID_INPUT", message: "متن و تبصره/بندهای اصلاحی با نسخهٔ فعلی یکی است؛ چیزی برای اصلاح نیست (ممیزی آلوده نمی‌شود)." });
    }
    await tx.execute(
      sql`UPDATE ${tableRef(schema, "article_version")}
          SET body = ${content.text}, review_status = 'pending-legal-review', reviewed_by = NULL, reviewed_on = NULL
          WHERE document_id = ${r.documentId} AND article_label = ${r.article} AND valid_from = ${r.validFrom}::date`,
    );
    await tx.execute(
      sql`DELETE FROM ${tableRef(schema, "article_subpart")}
          WHERE document_id = ${r.documentId} AND article_label = ${r.article} AND valid_from = ${r.validFrom}::date`,
    );
    if (content.subparts.length > 0) {
      const rows = content.subparts.map((s, ordinal) => ({ ordinal, kind: s.kind, label: s.label, body: s.text }));
      const res = await tx.execute(
        sql`WITH ins AS (
              INSERT INTO ${tableRef(schema, "article_subpart")} (document_id, article_label, valid_from, ordinal, kind, label, body)
              SELECT ${r.documentId}, ${r.article}, ${r.validFrom}::date, t.ordinal, t.kind, t.label, t.body
              FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS t(ordinal integer, kind text, label text, body text)
              RETURNING 1) SELECT count(*)::integer AS n FROM ins`,
      );
      if (res.rows[0]?.["n"] !== rows.length) throw new StoreAbort({ code: "DB_ERROR", message: "شمار تبصره/بند درج‌شده با انتظار نمی‌خواند." });
    }
    const after = (await loadVersion(tx, schema, r, false)).snapshot;
    // دفاع در عمق: آنچه پایگاه نگه داشته باید دقیقاً همان محتوای اعتبارسنجی‌شده باشد.
    if (after.contentHash !== versionContentHash(content)) throw new StoreAbort({ code: "DB_ERROR", message: "محتوای ذخیره‌شده با محتوای اصلاحی نمی‌خواند؛ تراکنش برگشت." });
    const auditSeq = await writeAudit(tx, schema, { action: "correct", ref: r, actor: actor.actor, actedOn: actor.actedOn, reason: actor.reason, before: current.snapshot, after });
    return { action: "correct", ref: r, auditSeq, before: current.snapshot, after };
  });
}

// ───────── خواندن ممیزی ─────────

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 100;

function parseSnapshot(raw: unknown): VersionSnapshot {
  if (typeof raw !== "object" || raw === null) throw new CorruptRowError("snapshot ممیزی");
  const o = raw as Record<string, unknown>;
  const review = o["review"] as Record<string, unknown> | null;
  if (typeof o["text"] !== "string" || !Array.isArray(o["subparts"]) || typeof review !== "object" || review === null || typeof o["contentHash"] !== "string") {
    throw new CorruptRowError("شکل snapshot ممیزی");
  }
  const status = review["status"];
  if (status !== "pending-legal-review" && status !== "legally-verified") throw new CorruptRowError("وضعیت در snapshot ممیزی");
  const reviewedBy = review["reviewedBy"];
  const reviewedOn = review["reviewedOn"];
  if ((reviewedBy !== null && typeof reviewedBy !== "string") || (reviewedOn !== null && typeof reviewedOn !== "string")) throw new CorruptRowError("بازبین در snapshot ممیزی");
  const subparts = (o["subparts"] as unknown[]).map((s): Subpart => {
    const sp = s as Record<string, unknown> | null;
    const kind = sp?.["kind"];
    if (typeof sp !== "object" || sp === null || (kind !== "note" && kind !== "clause") || typeof sp["label"] !== "string" || typeof sp["text"] !== "string") {
      throw new CorruptRowError("تبصره/بند در snapshot ممیزی");
    }
    return { kind, label: sp["label"], text: sp["text"] };
  });
  return { text: o["text"], subparts, review: { status, reviewedBy, reviewedOn }, contentHash: o["contentHash"] };
}

/** `ref` تهی ⇒ همهٔ نسخه‌ها؛ ترتیب صعودی با `seq`. `limit` پیش‌فرض ۱۰۰ و حداکثر ۱۰۰۰ است. */
export async function listAudit(db: KbDatabase, schema: string, ref: VersionRef | null, options: AuditQueryOptions = {}): Promise<StoreResult<readonly AuditEntry[]>> {
  const parsed = guard(() => {
    const r = ref === null ? null : parseVersionRef(ref);
    const limit = options.limit ?? DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new StoreAbort({ code: "INVALID_INPUT", message: `limit باید عدد صحیح بین ۱ تا ${MAX_LIMIT} باشد.` });
    }
    return { r, limit };
  });
  if (!parsed.ok) return parsed;
  const { r, limit } = parsed.value;
  try {
    const entries = await db.transaction(async (tx) => {
      await assertCurrent(tx, schema);
      const where = r === null ? sql`` : sql`WHERE document_id = ${r.documentId} AND article_label = ${r.article} AND valid_from = ${r.validFrom}::date`;
      const rows = (
        await tx.execute(
          sql`SELECT seq::text AS seq, to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at, action, document_id, article_label,
                     ${DATE_OUT("valid_from", "valid_from")}, actor, ${DATE_OUT("acted_on", "acted_on")}, reason, before_snapshot, after_snapshot
              FROM ${auditRef(schema)} ${where} ORDER BY seq ASC LIMIT ${limit}`,
        )
      ).rows;
      return rows.map((row): AuditEntry => {
        const action = str(row, "action");
        if (action !== "verify" && action !== "revoke" && action !== "correct") throw new CorruptRowError("action ممیزی");
        return {
          seq: parseSeq(row["seq"]),
          at: str(row, "at"),
          action,
          ref: { documentId: str(row, "document_id"), article: str(row, "article_label"), validFrom: isoDate(row, "valid_from") },
          actor: str(row, "actor"),
          actedOn: isoDate(row, "acted_on"),
          reason: strOrNull(row, "reason"),
          before: parseSnapshot(row["before_snapshot"]),
          after: parseSnapshot(row["after_snapshot"]),
        };
      });
    }, REPEATABLE_READ_ONLY);
    return { ok: true, value: entries };
  } catch (e) {
    return { ok: false, error: toStoreError(e) };
  }
}

/**
 * اعتبارسنجی ورودی کنش‌های مسیر اعتماد (داخلی).
 *
 * اصل: قاعدهٔ دوم نداریم. نام بازبین، تاریخ، دلیل، متن و تبصره‌ها را از **همان `loadCorpus`** می‌گذرانیم (در یک Corpus ساختگیِ
 * یک‌سندی)؛ پس سقف طول، نویسهٔ کنترلی/Trojan‑Source، قالب تاریخ و برچسب تبصره دقیقاً همان قواعد ورود دادهٔ اصلی است و
 * با تغییر قواعد `legal-kb-schema` خودکار هم‌گام می‌ماند. مسیر مسائل به نام‌های ورودی کنش بازنویسی می‌شود.
 */
import {
  canonicalArticleLabel,
  isValidDocumentId,
  loadCorpus,
  parseIsoDate,
  type CorpusIssue,
  type IsoDate,
  type Subpart,
} from "@/modules/legal-kb-schema";
import { StoreAbort } from "./errors";
import { isContentHash } from "./content-hash";
import type { VersionRef } from "./types";

const invalid = (message: string, issues?: readonly CorpusIssue[]): StoreAbort =>
  new StoreAbort({ code: "INVALID_INPUT", message, ...(issues ? { issues } : {}) });

export function parseVersionRef(ref: unknown): VersionRef {
  if (typeof ref !== "object" || ref === null) throw invalid("شناسهٔ نسخه نامعتبر است (باید شیء {documentId, article, validFrom} باشد).");
  const r = ref as { documentId?: unknown; article?: unknown; validFrom?: unknown };
  if (typeof r.documentId !== "string" || !isValidDocumentId(r.documentId)) throw invalid("documentId نامعتبر است.");
  if (typeof r.article !== "string") throw invalid("article باید متن باشد.");
  const label = canonicalArticleLabel(r.article);
  if (!label.ok) throw invalid(label.error.message);
  const date = parseIsoDate(r.validFrom);
  if (!date.ok) throw invalid(date.error.message);
  return { documentId: r.documentId, article: label.value, validFrom: date.value };
}

export function parseExpectedHash(value: unknown): string {
  if (!isContentHash(value)) throw invalid("expectedHash باید هش SHA-256 (۶۴ رقم هگز با حروف کوچک) از versionContentHash باشد.");
  return value;
}

const PREFIX_REVIEW = /^documents\[0\]\.articles\[0\]\.versions\[0\]\.provenance\.review/;
const PREFIX_VERSION = /^documents\[0\]\.articles\[0\]\.versions\[0\]/;

/** مسیرهای Corpus ساختگی را به نام‌های ورودی کنش برمی‌گرداند. */
function remap(issues: readonly CorpusIssue[], names: Readonly<{ review: string; version: string; note: string }>): CorpusIssue[] {
  return issues.map((i) => ({
    ...i,
    path: i.path
      .replace(PREFIX_REVIEW, names.review)
      .replace(PREFIX_VERSION, names.version)
      .replace(/^relations\[0\]\.note/, names.note),
  }));
}

const STUB_PROVENANCE = { sourceName: "stub", sourceUrl: null, sourceKind: "secondary", retrievedOn: null } as const;
const PENDING = { status: "pending-legal-review", reviewedBy: null, reviewedOn: null } as const;

type Stub = Readonly<{ review?: unknown; text?: unknown; subparts?: unknown; note?: unknown; label: string; validFrom: IsoDate; validTo: IsoDate | null }>;

/** Corpus یک‌سندی/یک‌مادّه‌ای که فقط برای گذراندن مقدارها از اعتبارسنج اصلی ساخته می‌شود (هرگز ذخیره نمی‌شود). */
function stubCorpus(s: Stub): unknown {
  return {
    documents: [
      {
        id: "stub-document",
        kind: "statute",
        title: "stub",
        shortTitle: null,
        enactedOn: null,
        provenance: { ...STUB_PROVENANCE, review: PENDING },
        articles: [
          {
            label: s.label,
            versions: [
              {
                validFrom: s.validFrom,
                validTo: s.validTo,
                text: "text" in s ? s.text : "stub",
                subparts: "subparts" in s ? s.subparts : [],
                provenance: { ...STUB_PROVENANCE, review: s.review ?? PENDING },
              },
            ],
          },
        ],
      },
    ],
    relations:
      "note" in s
        ? [
            {
              type: "refers-to",
              from: { documentId: "stub-document", article: null },
              to: { documentId: "stub-document", article: s.label },
              effectiveFrom: null,
              note: s.note,
              provenance: { ...STUB_PROVENANCE, review: PENDING },
            },
          ]
        : [],
    rulings: [],
  };
}

export type ActorFields = Readonly<{ actor: string; actedOn: IsoDate; reason: string | null }>;

/**
 * بازبین/کنشگر + تاریخ (+ دلیل) را اعتبارسنجی می‌کند. `reason` برای `verify` اختیاری و برای `revoke`/`correct` لازم است.
 * (بازبین و تاریخ از مسیر `review` و دلیل از مسیر `note` می‌گذرد؛ هر دو از قواعد همان ماژول.)
 */
export function parseActor(
  input: Readonly<{ actor: unknown; actedOn: unknown; reason: unknown; reasonRequired: boolean }>,
  names: Readonly<{ actor: string; actedOn: string; reason: string }>,
): ActorFields {
  if (input.reasonRequired && (typeof input.reason !== "string" || input.reason.trim() === "")) {
    throw invalid(`${names.reason} الزامی است و نباید خالی باشد.`);
  }
  const reason = input.reason === undefined || input.reason === null ? null : input.reason;
  const loaded = loadCorpus(
    stubCorpus({
      label: "1",
      validFrom: "2000-01-01",
      validTo: null,
      review: { status: "legally-verified", reviewedBy: input.actor, reviewedOn: input.actedOn },
      ...(reason === null ? {} : { note: reason }),
    }),
  );
  if (!loaded.ok) {
    const actorMissing = input.actor === null || input.actor === undefined;
    const all = remap(loaded.error, { review: "$", version: "$", note: names.reason }).map((i) => ({
      ...i,
      path: i.path.replace(/^\$\.reviewedBy/, names.actor).replace(/^\$\.reviewedOn/, names.actedOn),
    }));
    // «ناسازگاریِ بازبینی» نتیجهٔ ثانویهٔ نبودن نام/تاریخ است و برای کنشگر معنایی ندارد: اگر مسئلهٔ اصلی هست حذفش می‌کنیم، وگرنه به فیلد گمشده نسبت می‌دهیم.
    const primary = all.filter((i) => i.code !== "REVIEW_INCONSISTENT");
    const issues = primary.length > 0 ? primary : all.map((i) => ({ ...i, path: actorMissing ? names.actor : names.actedOn, message: `${names.actor} و ${names.actedOn} هر دو لازم‌اند.` }));
    throw invalid(`ورودی نامعتبر است (${issues.length} مسئله)؛ چیزی تغییر نکرد.`, issues);
  }
  const review = loaded.value.documents[0]?.articles[0]?.versions[0]?.provenance.review;
  if (!review || review.reviewedBy === null || review.reviewedOn === null) throw invalid("بازبین یا تاریخ نامعتبر است.");
  const note = loaded.value.relations[0]?.note ?? null;
  return { actor: review.reviewedBy, actedOn: review.reviewedOn, reason: note };
}

/** متن و تبصره/بندهای تازه را با قواعد `loadCorpus` می‌سنجد و شکل متعارف (برچسب‌های نرمال‌شده) را برمی‌گرداند. */
export function parseContent(
  input: Readonly<{ text: unknown; subparts: unknown }>,
  base: Readonly<{ label: string; validFrom: IsoDate; validTo: IsoDate | null }>,
): Readonly<{ text: string; subparts: readonly Subpart[] }> {
  const loaded = loadCorpus(stubCorpus({ ...base, text: input.text, subparts: input.subparts }));
  if (!loaded.ok) {
    const issues = remap(loaded.error, { review: "review", version: "$", note: "reason" }).map((i) => ({ ...i, path: i.path.replace(/^\$\./, "") }));
    throw invalid(`متن یا تبصره/بندهای اصلاحی نامعتبر است (${issues.length} مسئله)؛ چیزی تغییر نکرد.`, issues);
  }
  const v = loaded.value.documents[0]?.articles[0]?.versions[0];
  if (!v) throw invalid("نسخهٔ اصلاحی نامعتبر است.");
  return { text: v.text, subparts: v.subparts };
}

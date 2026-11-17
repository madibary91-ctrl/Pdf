/**
 * خواندن ردیف‌ها (داخلی). ردیفِ ناهمخوان با مدل = `CorruptRowError` (→ CORRUPT_DATA)، نه حدس و نه مقدار پیش‌فرض.
 * تاریخ‌ها همیشه با `to_char` به رشتهٔ ISO درمی‌آیند (نه `Date` جاوااسکریپت): منطقهٔ زمانی هرگز وارد نمی‌شود.
 */
import { sql, type SQL } from "drizzle-orm";
import { isValidIsoDate, type ArticleVersion, type IsoDate, type Provenance, type ReviewStatus, type SourceKind, type Subpart, type SubpartKind } from "@/modules/legal-kb-schema";
import { CorruptRowError } from "./errors";

export type Row = Readonly<Record<string, unknown>>;

export function str(r: Row, k: string): string {
  const v = r[k];
  if (typeof v !== "string") throw new CorruptRowError(`ستون ${k}`);
  return v;
}

export function strOrNull(r: Row, k: string): string | null {
  const v = r[k];
  if (v === null) return null;
  if (typeof v !== "string") throw new CorruptRowError(`ستون ${k}`);
  return v;
}

export function int(r: Row, k: string): number {
  const v = r[k];
  if (typeof v !== "number" || !Number.isInteger(v)) throw new CorruptRowError(`ستون ${k}`);
  return v;
}

export function isoDate(r: Row, k: string): IsoDate {
  const v = r[k];
  if (!isValidIsoDate(v)) throw new CorruptRowError(`ستون ${k}`);
  return v;
}

export function isoDateOrNull(r: Row, k: string): IsoDate | null {
  return r[k] === null ? null : isoDate(r, k);
}

const ISO = (col: string) => `to_char(${col}, 'YYYY-MM-DD')`;

/** ستون‌های منبع/بازبینی برای SELECT. `alias` ثابت درون کد است (هرگز ورودی کاربر). */
export function provenanceSelect(alias: string): SQL {
  const p = alias === "" ? "" : `${alias}.`;
  return sql.raw(
    [
      `${p}source_name`,
      `${p}source_url`,
      `${p}source_kind`,
      `${ISO(`${p}retrieved_on`)} AS retrieved_on`,
      `${p}review_status`,
      `${p}reviewed_by`,
      `${ISO(`${p}reviewed_on`)} AS reviewed_on`,
    ].join(", "),
  );
}

export const DATE_OUT = (col: string, as: string): SQL => sql.raw(`${ISO(col)} AS ${as}`);

function oneOf<T extends string>(value: string, allowed: readonly T[], what: string): T {
  const hit = allowed.find((a) => a === value);
  if (hit === undefined) throw new CorruptRowError(`مقدار ${what}`);
  return hit;
}

export function readProvenance(r: Row): Provenance {
  const status = oneOf<ReviewStatus>(str(r, "review_status"), ["pending-legal-review", "legally-verified"], "review_status");
  const reviewedBy = strOrNull(r, "reviewed_by");
  const reviewedOn = isoDateOrNull(r, "reviewed_on");
  // همان قاعدهٔ loadCorpus، این‌جا هم سنجیده می‌شود: کوئری‌های نقطه‌ای از loadCorpus نمی‌گذرند و
  // «تأییدشده» بدون بازبین (قید برداشته‌شده یا SQL دستی) هرگز نباید `verified: true` شود.
  const consistent = status === "legally-verified" ? reviewedBy !== null && reviewedOn !== null : reviewedBy === null && reviewedOn === null;
  if (!consistent) throw new CorruptRowError("وضعیت بازبینی ناسازگار با نام/تاریخ بازبین");
  return {
    sourceName: str(r, "source_name"),
    sourceUrl: strOrNull(r, "source_url"),
    sourceKind: oneOf<SourceKind>(str(r, "source_kind"), ["official", "secondary"], "source_kind"),
    retrievedOn: isoDateOrNull(r, "retrieved_on"),
    review: { status, reviewedBy, reviewedOn },
  };
}

export function readSubpart(r: Row): Subpart {
  return { kind: oneOf<SubpartKind>(str(r, "kind"), ["note", "clause"], "kind"), label: str(r, "label"), text: str(r, "body") };
}

/** ستون‌های لازم برای ساخت `ArticleVersion` (به‌جز تبصره‌ها): validFrom, validTo, body, provenance. */
export function readVersionRow(r: Row, subparts: readonly Subpart[]): ArticleVersion {
  return {
    validFrom: isoDate(r, "valid_from"),
    validTo: isoDateOrNull(r, "valid_to"),
    text: str(r, "body"),
    subparts,
    provenance: readProvenance(r),
  };
}

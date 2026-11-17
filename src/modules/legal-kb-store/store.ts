/** `createKbStore`: تنها نقطهٔ ساخت. اتصال را از بیرون می‌گیرد (تزریق) و هیچ متغیر محیطی یا اتصال سراسری نمی‌خواند. */
import type { Corpus, CitationRef, InForceEntry, IsoDate, VersionLookup } from "@/modules/legal-kb-schema";
import { insertCorpus } from "./insert";
import { migrate, migrationStatus } from "./migrate";
import { DEFAULT_SCHEMA, parseSchemaName } from "./naming";
import { readCorpus, readStats } from "./read";
import { resolveCitation, versionsInForceAt } from "./temporal";
import type { InsertReport, KbDatabase, MigrationReport, MigrationStatus, StoreOptions, StoreResult, StoreStats } from "./types";

export type KbStore = Readonly<{
  /** نام شِمای پستگرس که این store روی آن کار می‌کند. */
  schema: string;
  /** شِما، افزونهٔ btree_gist و جدول‌ها را می‌سازد/به‌روز می‌کند (ایدمپوتنت، اتمی، زیر قفل). */
  migrate(): Promise<StoreResult<MigrationReport>>;
  /** فقط‌خواندنی: مهاجرت‌های اعمال‌شده/معلق؛ اگر دفتر با کد نخواند، خطا. */
  migrationStatus(): Promise<StoreResult<MigrationStatus>>;
  /** درج فقط‌افزودنی و اتمی یک Corpus خودبسنده. ورودی `unknown` است و از `loadCorpus` می‌گذرد. */
  insertCorpus(input: unknown): Promise<StoreResult<InsertReport>>;
  /** کل پایگاه به‌صورت Corpus متعارف (بازاعتبارسنجی‌شده). */
  readCorpus(): Promise<StoreResult<Corpus>>;
  /** همان معنای `resolveCitation` در legal-kb-schema، اما از پایگاه. */
  resolveCitation(ref: CitationRef, onDate: IsoDate): Promise<StoreResult<VersionLookup>>;
  /** همان معنای `versionsInForceAt` در legal-kb-schema، اما از پایگاه. */
  versionsInForceAt(onDate: IsoDate): Promise<StoreResult<readonly InForceEntry[]>>;
  stats(): Promise<StoreResult<StoreStats>>;
}>;

export function createKbStore(db: KbDatabase, options: StoreOptions = {}): StoreResult<KbStore> {
  const parsed = parseSchemaName(options.schema ?? DEFAULT_SCHEMA);
  if (!parsed.ok) return parsed;
  const schema = parsed.value;
  return {
    ok: true,
    value: Object.freeze({
      schema,
      migrate: () => migrate(db, schema),
      migrationStatus: () => migrationStatus(db, schema),
      insertCorpus: (input: unknown) => insertCorpus(db, schema, input),
      readCorpus: () => readCorpus(db, schema),
      resolveCitation: (ref: CitationRef, onDate: IsoDate) => resolveCitation(db, schema, ref, onDate),
      versionsInForceAt: (onDate: IsoDate) => versionsInForceAt(db, schema, onDate),
      stats: () => readStats(db, schema),
    }),
  };
}

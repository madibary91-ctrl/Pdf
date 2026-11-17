/** رابط عمومی legal-kb-store؛ هر چیز دیگر داخلی است و از بیرون ماژول نباید import شود. */
export { createKbStore } from "./store";
export type { KbStore } from "./store";
export { DEFAULT_SCHEMA, parseSchemaName } from "./naming";
export { MIGRATIONS as KB_STORE_MIGRATIONS, migrationChecksum } from "./migrations";
export type {
  InsertReport,
  KbDatabase,
  MigrationReport,
  MigrationStatus,
  StoreError,
  StoreErrorCode,
  StoreOptions,
  StoreResult,
  StoreStats,
} from "./types";

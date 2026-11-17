/** رابط عمومی legal-kb-store؛ هر چیز دیگر داخلی است و از بیرون ماژول نباید import شود. */
export { createKbStore } from "./store";
export type { KbStore } from "./store";
export { DEFAULT_SCHEMA, auditSchemaName, parseSchemaName, searchSchemaName } from "./naming";
export { SEARCH_LIMITS, searchKeyFingerprint } from "./search-text";
export { SEARCH_MIGRATIONS as KB_SEARCH_MIGRATIONS } from "./search-migrations";
export type { ReindexReport, SearchHit, SearchInput, SearchResult, SearchStatus } from "./search-types";
export { versionContentHash } from "./content-hash";
export { MIGRATIONS as KB_STORE_MIGRATIONS, migrationChecksum } from "./migrations";
export type {
  AuditAction,
  AuditEntry,
  AuditQueryOptions,
  CorrectInput,
  InsertReport,
  KbDatabase,
  MigrationReport,
  MigrationStatus,
  StoreError,
  StoreErrorCode,
  StoreOptions,
  StoreResult,
  StoreStats,
  RevokeInput,
  VerifyInput,
  VersionChange,
  VersionRef,
  VersionSnapshot,
} from "./types";

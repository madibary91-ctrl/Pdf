/** رابط عمومی legal-kb-store؛ هر چیز دیگر داخلی است و از بیرون ماژول نباید import شود. */
export { createKbStore } from "./store";
export type { KbStore } from "./store";
export { DEFAULT_SCHEMA, auditSchemaName, parseSchemaName } from "./naming";
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

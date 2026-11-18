/** رابط آداپتور PostgreSQL برای outbox تسویه (ADR-0022)؛ از `@/modules/settlement` صادر می‌شود. هر چیز دیگرِ این پوشه داخلی است. */
export { createPgSettlementOutbox } from "./store";
export { SETTLEMENT_DEFAULT_SCHEMA } from "./naming";
export type { PgSettlementOutbox, PgSettlementOutboxOptions } from "./types";

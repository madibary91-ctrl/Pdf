/**
 * رابط عمومی settlement (م۳ الف: outbox و رفتگر تسویهٔ metering، ADR-0021؛ م۳ ب: outbox ماندگار روی PostgreSQL، ADR-0022؛ م۳ ج: حلقهٔ رفتگر، ADR-0023؛ م۳ ه‑۱: ارزیابِ سلامتِ رفتگر، ADR-0030).
 * هر چیز دیگر داخلی است و از بیرون ماژول نباید import شود.
 */
export { createDurableMeteredGateway } from "./durable-gateway";
export { createDurableLedger } from "./durable-ledger";
export { createSettlementSweeper } from "./sweeper";
export { createSweepLoop } from "./sweep-loop";
export { createSweepHealthCheck, sweepHealthHttpStatus } from "./health";
export { createMemoryOutbox } from "./memory-outbox";
export { SETTLEMENT_LIMITS } from "./config";
export { createPgSettlementOutbox, SETTLEMENT_DEFAULT_SCHEMA } from "./pg";
export type { PgSettlementOutbox, PgSettlementOutboxOptions } from "./pg";
export type {
  BeginInput,
  BuriedItem,
  ChargeIntent,
  ClaimQuery,
  CloseIntent,
  CloseOrigin,
  DeadAck,
  DeadLetter,
  DeadLetterDelivery,
  DeadLetterOutbox,
  DeadLetterStats,
  DeadReason,
  DueClaimer,
  DueQuery,
  DurableLedgerConfig,
  EntryState,
  FailureInput,
  FailureRecorded,
  HealthReason,
  HealthReasonCode,
  HealthStatus,
  OutboxCounts,
  OutboxEntry,
  OutboxError,
  OutboxErrorCode,
  OutboxResult,
  Replayed,
  ReservationRef,
  SettlementConfigError,
  SettlementOutbox,
  SettlementResult,
  LoopFault,
  LoopFaultKind,
  LoopRunInfo,
  LoopStartResult,
  LoopState,
  LoopStopResult,
  LoopTimer,
  SweepLoop,
  SweepHealth,
  SweepHealthCheck,
  SweepHealthConfig,
  SweepHealthInput,
  SweepLoopConfig,
  SweepLoopStatus,
  SweepObserver,
  Sweeper,
  SweeperConfig,
  SweepReport,
} from "./types";

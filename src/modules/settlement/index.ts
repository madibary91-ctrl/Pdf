/**
 * رابط عمومی settlement (م۳ الف: outbox و رفتگر تسویهٔ metering؛ ADR-0021). هر چیز دیگر داخلی است و از بیرون ماژول نباید import شود.
 */
export { createDurableMeteredGateway } from "./durable-gateway";
export { createDurableLedger } from "./durable-ledger";
export { createSettlementSweeper } from "./sweeper";
export { createMemoryOutbox } from "./memory-outbox";
export { SETTLEMENT_LIMITS } from "./config";
export type {
  BeginInput,
  BuriedItem,
  ChargeIntent,
  CloseIntent,
  CloseOrigin,
  DeadReason,
  DueQuery,
  DurableLedgerConfig,
  EntryState,
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
  Sweeper,
  SweeperConfig,
  SweepReport,
} from "./types";

/**
 * رابط عمومی settlement-host (م۳‑ه‑۳‑الف، ADR-0032): میزبانِ فرایندیِ رفتگرِ تسویه — singleton، بوتِ شکست‌بسته، خاموشیِ مرتب و پروب‌های live/startup/ready.
 * هر چیز دیگر داخلی است و از بیرون ماژول نباید import شود.
 */
export { createSettlementHost } from "./host";
export { acquireSettlementHost, getSettlementHost, probeSettlementHost, SETTLEMENT_HOST_STORE_KEY } from "./singleton";
export { evaluateProbe } from "./probes";
export { createNodeExit, createNodeSignalSource } from "./node-process";
export { SETTLEMENT_HOST_LIMITS } from "./config";
export type {
  AcquireResult,
  BootFailureCode,
  BootFailureReason,
  ClosedState,
  HostBootResult,
  HostBootRetry,
  HostError,
  HostErrorCode,
  HostEvent,
  HostResult,
  HostSignal,
  HostState,
  HostStatus,
  HostStore,
  HostTimer,
  NodeProcessLike,
  ProbeKind,
  ProbeResult,
  ProbeSweep,
  RuntimePort,
  SettlementHost,
  SettlementHostConfig,
  ShutdownReason,
  ShutdownResult,
  SignalSource,
} from "./types";

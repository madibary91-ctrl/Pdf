/**
 * رابط عمومی tool-policy-host (ADR-0075، برش CT‑5c‑2c‑2b‑3): میزبانِ فرایندیِ سیاستِ ابزار — singleton، بوتِ شکست‌بسته، خاموشیِ مرتب و پروب‌های live/startup/ready.
 * آداپتورهای `process` (سیگنال/خروج) در `settlement-host` است (`createNodeSignalSource`/`createNodeExit`)؛ این‌جا بازصادر نمی‌شوند.
 * هر چیز دیگر داخلی است و از بیرون ماژول نباید import شود.
 */
export { createToolPolicyHost } from "./host";
export { acquireToolPolicyHost, getToolPolicyHost, probeToolPolicyHost, TOOL_POLICY_HOST_STORE_KEY } from "./singleton";
export { evaluateProbe } from "./probes";
export { TOOL_POLICY_HOST_LIMITS } from "./config";
export type {
  AcquireResult,
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
  NotReadyReason,
  ProbeKind,
  ProbeResult,
  RuntimeFailureReason,
  RuntimePort,
  ShutdownReason,
  ShutdownResult,
  SignalSource,
  ToolPolicyHost,
  ToolPolicyHostConfig,
} from "./types";

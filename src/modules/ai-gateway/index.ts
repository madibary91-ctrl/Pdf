/** رابط عمومی ai-gateway (برش ۱: هسته؛ برش ۲: تلاش دوباره و جایگزین)؛ هر چیز دیگر داخلی است و از بیرون ماژول نباید import شود. */
export { createGateway } from "./gateway";
export { createResilientGateway } from "./resilience";
export { resolvePolicy, POLICY_LIMITS, RETRYABLE_CODES, FALLBACK_ELIGIBLE_CODES } from "./resilience-policy";
export { computeBackoff, sanitizeUnit } from "./backoff";
export { decideNext } from "./decision";
export type { Decision, DecisionInput } from "./decision";
export type {
  AttemptRecord,
  FallbackEligibleCode,
  JitterMode,
  RandomSource,
  ResiliencePolicy,
  ResilienceReport,
  ResilientCompletion,
  ResilientError,
  ResilientGateway,
  ResilientResult,
  ResolvedPolicy,
  RetryableCode,
  SpendEntry,
  StopReason,
} from "./resilience-types";
export { resolveConfig, LIMITS as CONFIG_LIMITS } from "./config";
export { parseRequest, REQUEST_LIMITS } from "./request";
export { computeCost, parsePrice, parseUsage, PRICE_LIMITS } from "./pricing";
export { ProviderFailure, ERROR_CODES, MAX_RETRY_AFTER_MS } from "./errors";
export type { ProviderFailureKind } from "./errors";
export type {
  ChatMessage,
  Clock,
  Completion,
  CompletionRequest,
  Cost,
  FinishReason,
  Gateway,
  GatewayConfig,
  GatewayError,
  GatewayErrorCode,
  GatewayResult,
  GatewayWarning,
  ModelLimits,
  ModelProvider,
  ModelSpec,
  ParsedRequest,
  PriceSpec,
  ProviderCall,
  ProviderReply,
  Role,
  Timers,
  Usage,
  UsageEvent,
  UsageSink,
} from "./types";

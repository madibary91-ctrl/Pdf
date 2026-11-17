/** رابط عمومی ai-gateway (برش ۱: هسته)؛ هر چیز دیگر داخلی است و از بیرون ماژول نباید import شود. */
export { createGateway } from "./gateway";
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

/**
 * رابط عمومی metered-tool-gateway (MT-1: اندازه‌گیریِ مصرفِ گامِ ابزار روی دفتر اعتبار؛ ADR-0062).
 * هر چیز دیگر داخلی است و از بیرون ماژول نباید import شود.
 */
export { createMeteredToolGateway, MAX_RECEIPTS } from "./gateway";
export type { MeterSummary, MeteredStepCompletion, MeteredStepError, MeteredStepResult, MeteredToolGateway, MeteredToolGatewayOptions, MeteredToolGatewayResult } from "./types";

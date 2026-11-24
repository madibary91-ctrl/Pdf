/** رابط عمومی calc-answer-cards (CT‑5b: کارتِ پاسخِ محاسبه از رویدادِ بی‌واسطهٔ legal-calc)؛ هر چیز دیگر داخلی است. */
export { createCardCollector, MAX_CARDS_CEILING } from "./collector";
export { COMPOSE_MESSAGES, NOTICES, REVIEW_PENDING_LABEL, TOOL_TITLES } from "./messages";
export type {
  CalcCard,
  CardCollector,
  CardCollectorError,
  CardCollectorErrorCode,
  CardCollectorOptions,
  CardCollectorResult,
  ComposeError,
  ComposeErrorCode,
  ComposeResult,
  ComposedAnswer,
} from "./types";

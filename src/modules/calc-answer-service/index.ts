/** رابط عمومی calc-answer-service (CT‑5c‑1: سرویسِ پاسخِ محاسبه، ریشهٔ ترکیبِ بی‌I/O)؛ هر چیز دیگر داخلی است. */
export { createCalcAnswerService, MODEL_NAME_MAX } from "./service";
export { ANSWER_MESSAGES, OPTIONS_MESSAGE } from "./messages";
export type {
  AnswerError,
  AnswerErrorCode,
  AnswerInput,
  AnswerOptions,
  AnswerResult,
  CalcAnswer,
  CalcAnswerService,
  CalcAnswerServiceError,
  CalcAnswerServiceOptions,
  CalcAnswerServiceResult,
  CreateErrorCode,
  RunSpend,
} from "./types";

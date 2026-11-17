/** رابط عمومی legal-calc؛ هر چیز دیگر داخلی است و از بیرون ماژول نباید import شود. */
export { calculateCourtFee, findCourtFeeTariff, validateCourtFeeTariff } from "./court-fee";
export { COURT_FEE_TARIFFS } from "./court-fee-tariffs";
export { COURT_FEE_STAGE_ORDER } from "./court-fee-types";
export type {
  CourtFeeClaim,
  CourtFeeInput,
  CourtFeeResult,
  CourtFeeStage,
  CourtFeeStep,
  CourtFeeTariff,
  RateTier,
  ReviewStatus,
  RoundingMode,
  StageRule,
  TierMethod,
} from "./court-fee-types";

export {
  calculateLatePayment,
  calculateLatePaymentBatch,
  findIndexSeries,
  indexKeyFor,
  validateIndexSeries,
  validateLatePaymentRules,
} from "./late-payment";
export { LATE_PAYMENT_INDEX_SERIES, LATE_PAYMENT_RULES } from "./late-payment-indices";
export type {
  IndexDecreasePolicy,
  IndexGranularity,
  IndexPoint,
  IndexSeries,
  LatePaymentBatchItem,
  LatePaymentBatchResult,
  LatePaymentInput,
  LatePaymentResult,
  LatePaymentRules,
  ManualIndexSource,
  ReviewInfo,
  SeriesIndexSource,
} from "./late-payment-types";

export { calculateInheritance, validateInheritanceRules } from "./inheritance";
export { INHERITANCE_RULES } from "./inheritance-shares";
export type {
  ExactFraction,
  FractionPair,
  GrandchildLine,
  HeirRole,
  HeirShare,
  InheritanceInput,
  InheritanceOutcome,
  InheritanceResult,
  InheritanceRules,
  InheritanceStep,
  Sex,
  ShareBasis,
  SiblingThreshold,
} from "./inheritance-types";

/** رابط عمومی legal-kb-schema؛ هر چیز دیگر داخلی است و از بیرون ماژول نباید import شود. */
export { loadCorpus, loadCorpusFromJson } from "./load";
export { buildCorpusIndex, findArticle, findDocument, relationsFor, resolveCitation, rulingsCiting, versionsInForceAt } from "./lookup";
export type { CorpusIndex, InForceEntry } from "./lookup";
export {
  canonicalArticleLabel,
  canonicalSubpartLabel,
  compareArticleLabels,
  formatArticleLabel,
  formatCitationKey,
  isValidDocumentId,
  parseArticleLabel,
  parseCitationKey,
} from "./label";
export type { ArticleLabel } from "./label";
export { isValidIsoDate, parseIsoDate } from "./dates";
export { KB_LIMITS } from "./issues";
export { DOCUMENT_KINDS, RELATION_TYPES, RULING_KINDS, SUBPART_KINDS } from "./types";
export type {
  Article,
  ArticleVersion,
  CitationRef,
  Corpus,
  CorpusIssue,
  DocumentKind,
  IsoDate,
  IssueCode,
  LawDocument,
  NodeRef,
  Provenance,
  Relation,
  RelationType,
  Review,
  ReviewStatus,
  Ruling,
  RulingKind,
  SourceKind,
  Subpart,
  SubpartKind,
  VersionLookup,
} from "./types";
export { FICTIONAL_SAMPLE_CORPUS } from "./sample-corpus";

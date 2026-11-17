/** رابط عمومی persian-text؛ فقط از همین فایل import کنید. */
export {
  ZWNJ,
  normalizePersianText,
  normalizeForStorage,
  normalizeForDisplay,
  searchKey,
  tokenize,
  containsPersian,
} from "./normalize";
export type { NormalizeOptions } from "./normalize";
export { toPersianDigits, toLatinDigits, formatInteger, parseInteger } from "./digits";
export type { FormatIntegerOptions } from "./digits";

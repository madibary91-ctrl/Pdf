/**
 * تنها نقطهٔ ورود نوع‌های `legal-kb-store` برای این ماژول (طبق registry: وابستگی مجاز).
 * `Subpart` مستقیم از `legal-kb-schema` نمی‌آید (وابستگیِ اعلام‌نشده)؛ از نوع `SearchHit` مشتق می‌شود.
 */
import type { SearchHit } from "@/modules/legal-kb-store";

export type { SearchInput, SearchResult, SearchHit, StoreErrorCode, StoreResult } from "@/modules/legal-kb-store";
export type HitSubpart = SearchHit["subparts"][number];

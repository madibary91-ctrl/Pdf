/**
 * ذخیره‌سازِ حافظه‌ایِ نسخه‌ها (ADR-0069): مرجعِ رفتاریِ پورتِ `PolicyVersionStore` برای آزمون و بسترِ توسعه، و الگوی آداپتورِ PostgreSQL (2b‑2).
 * `append` همگام (بی‌await میانِ بررسی و نوشتن) و در نتیجه اتمی است؛ رکوردها هنگامِ ورود بازسازی و عمیق‌یخ‌زده می‌شوند.
 */
import { isSafeInt, parseRecord } from "./validate";
import type { PolicyVersionRecord, PolicyVersionStore, StoreErrorCode, StoreResult } from "./types";

const ok = <T>(value: T): StoreResult<T> => ({ ok: true, value });
const fail = (code: StoreErrorCode): StoreResult<never> => ({ ok: false, error: Object.freeze({ code }) });

export function createMemoryPolicyStore(): PolicyVersionStore {
  const records: PolicyVersionRecord[] = []; // اندیسِ i ⇒ نسخهٔ i+1 (بی‌شکاف)
  return {
    async latest() {
      return ok(records.length > 0 ? records[records.length - 1]! : null);
    },
    async get(version) {
      if (!isSafeInt(version, 1)) return fail("INVALID");
      return ok(records[version - 1] ?? null);
    },
    async append(record) {
      const parsed = parseRecord(record);
      if (parsed === null) return fail("INVALID");
      if (parsed.version !== records.length + 1) return fail("CONFLICT");
      records.push(parsed);
      return ok(null);
    },
    async list(query) {
      const { beforeVersion, limit } = query;
      if (!isSafeInt(limit, 1) || (beforeVersion !== null && !isSafeInt(beforeVersion, 1))) return fail("INVALID");
      const out: PolicyVersionRecord[] = [];
      for (let i = beforeVersion === null ? records.length - 1 : Math.min(beforeVersion - 2, records.length - 1); i >= 0 && out.length < limit; i--) out.push(records[i]!);
      return ok(Object.freeze(out));
    },
  };
}

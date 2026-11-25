/**
 * الگوی شناسهٔ دامنهٔ رزرو (ADR-0067): `scopeId = "calc-answer." + requestId`. رزروِ هر گام `<scopeId>.r<n>` می‌شود (metered-tool-gateway)؛
 * «برای هر پرسش یک شناسهٔ تازه» و استفادهٔ دوباره ⇒ `SCOPE_REUSED` (ایدمپوتنسیِ مطلوب). تولیدِ شناسهٔ تصادفی کارِ ریشهٔ I/O است (این ماژول
 * ساعت و تصادف ندارد). همان `ID_RE` و سقفِ نویسهٔ ledger/metering؛ با ورودیِ بد `INVALID_REQUEST_ID` (بی‌بازتابِ مقدار).
 */
import { ID_RE } from "@/modules/ledger";
import { CONFIG_LIMITS } from "@/modules/metering";
import { policyFail } from "./resolve";
import type { PolicyResult } from "./types";

export const SCOPE_PREFIX = "calc-answer.";
export const MAX_REQUEST_ID_CHARS = CONFIG_LIMITS.maxScopeIdChars - SCOPE_PREFIX.length;
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function toolScopeId(requestId: unknown): PolicyResult<string> {
  const msg = "شناسهٔ درخواست برای ساختنِ scopeId نامعتبر است.";
  if (typeof requestId !== "string" || requestId.length > MAX_REQUEST_ID_CHARS || !REQUEST_ID_RE.test(requestId)) {
    return policyFail("INVALID_REQUEST_ID", msg, [`requestId باید ۱ تا ${MAX_REQUEST_ID_CHARS} نویسه (حروف/ارقام و . _ : -، با حرف یا رقم شروع) باشد.`]);
  }
  const scope = `${SCOPE_PREFIX}${requestId}`;
  if (scope.length > CONFIG_LIMITS.maxScopeIdChars || !ID_RE.test(scope)) return policyFail("INVALID_REQUEST_ID", msg, ["requestId با قاعدهٔ scopeId سازگار نیست."]);
  return { ok: true, value: scope };
}

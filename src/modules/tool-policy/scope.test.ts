import { describe, expect, it } from "vitest";
import { ID_RE, LIMITS } from "@/modules/ledger";
import { CONFIG_LIMITS } from "@/modules/metering";
import { MAX_REQUEST_ID_CHARS, SCOPE_PREFIX, toolScopeId } from "./index";

describe("tool-policy · الگوی scopeId", () => {
  it("scopeId = پیشوند + requestId؛ با قاعدهٔ ledger و metering سازگار است", () => {
    const r = toolScopeId("req-123");
    expect(r.ok && r.value).toBe("calc-answer.req-123");
    expect(r.ok && ID_RE.test(r.value)).toBe(true);
  });

  it("مرز: ۸۴ نویسه مجاز، ۸۵ رد؛ و سقفِ ۹۶ نویسهٔ scopeId رعایت می‌شود", () => {
    expect(MAX_REQUEST_ID_CHARS).toBe(CONFIG_LIMITS.maxScopeIdChars - SCOPE_PREFIX.length);
    const ok = toolScopeId("a".repeat(MAX_REQUEST_ID_CHARS));
    expect(ok.ok && ok.value.length).toBe(CONFIG_LIMITS.maxScopeIdChars);
    const over = toolScopeId("a".repeat(MAX_REQUEST_ID_CHARS + 1));
    expect(!over.ok && over.error.issues).toEqual([`requestId باید ۱ تا ${MAX_REQUEST_ID_CHARS} نویسه (حروف/ارقام و . _ : -، با حرف یا رقم شروع) باشد.`]);
  });

  it("رزروِ هر گام (`<scope>.r<n>`) حتی برای گامِ ۹۹۹ در سقفِ شناسهٔ ledger می‌ماند", () => {
    const r = toolScopeId("a".repeat(MAX_REQUEST_ID_CHARS));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const reservationId = `${r.value}.r999`;
    expect(ID_RE.test(reservationId)).toBe(true);
    expect(reservationId.length).toBeLessThanOrEqual(LIMITS.MAX_ID_LENGTH);
  });

  it("ورودیِ نامعتبر ⇒ INVALID_REQUEST_ID بی‌بازتابِ مقدار", () => {
    for (const bad of [undefined, null, 5, {}, [], "", " ", "a b", "-a", ".a", "a/b", "a\n", "مدل", "a\u0000b", "x".repeat(200)]) {
      const r = toolScopeId(bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      expect(!r.ok && r.error.code).toBe("INVALID_REQUEST_ID");
    }
    expect(JSON.stringify(toolScopeId("SECRET-VALUE/x"))).not.toContain("SECRET-VALUE");
  });

  it("دو requestIdِ متفاوت ⇒ دو scopeIdِ متفاوت؛ یکسان ⇒ یکسان (ایدمپوتنسی)", () => {
    const a = toolScopeId("q1");
    const b = toolScopeId("q2");
    expect(a.ok && b.ok && a.value !== b.value).toBe(true);
    expect(toolScopeId("q1")).toEqual(a);
  });
});

import { describe, expect, it } from "vitest";
import { hasLoneSurrogate, isCalendarDate, parseAskRequest, REQUEST_LIMITS } from "./request";

const base = { question: "آیا فروشنده مکلف به تحویل است؟", asOf: "2024-03-01", model: "legal-chat", maxOutputTokens: 800 };
const issuesOf = (r: ReturnType<typeof parseAskRequest>): readonly string[] => (r.ok ? [] : (r.error.issues ?? []));

describe("ai-orchestrator · parseAskRequest", () => {
  it("ورودی کمینه: پیش‌فرض‌ها فقط برای زمینه/بازیابی/اختیاری‌ها؛ همه‌چیز صریح برمی‌گردد", () => {
    expect(parseAskRequest(base)).toEqual({
      ok: true,
      value: { ...base, documentId: null, contextMaxChars: 6000, retrieval: {}, requestId: null, timeoutMs: null },
    });
    expect(REQUEST_LIMITS.defaultContextChars).toBe(6000);
  });

  it("همهٔ اختیاری‌ها پذیرفته و بی‌تغییر برمی‌گردند", () => {
    const r = parseAskRequest({ ...base, documentId: "law-a", contextMaxChars: 200, retrieval: { limit: 3, maxTerms: 4, minCoverage: 0.5, maxQueries: 6 }, requestId: "req:1_a.b-c", timeoutMs: 1000 });
    expect(r).toEqual({
      ok: true,
      value: { ...base, documentId: "law-a", contextMaxChars: 200, retrieval: { limit: 3, maxTerms: 4, minCoverage: 0.5, maxQueries: 6 }, requestId: "req:1_a.b-c", timeoutMs: 1000 },
    });
  });

  it("ورودی غیرشیء و فیلدهای الزامی نبودن ⇒ INVALID_INPUT با نام فیلد", () => {
    for (const bad of [null, undefined, "x", 5, [], true]) {
      const r = parseAskRequest(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatchObject({ code: "INVALID_INPUT", retryable: false, issues: ["input"], accounting: null });
    }
    const empty = parseAskRequest({});
    expect(issuesOf(empty)).toEqual(["question", "asOf", "model", "maxOutputTokens"]);
  });

  it("هر فیلد نامعتبر دقیقاً با نام خودش گزارش می‌شود (همه یک‌جا)", () => {
    const cases: [string, Record<string, unknown>][] = [
      ["question", { question: "" }],
      ["question", { question: "   \n" }],
      ["question", { question: 5 }],
      ["question", { question: "a".repeat(REQUEST_LIMITS.maxQuestionChars + 1) }],
      ["question", { question: "a\u0000b" }],
      ["question", { question: "a\ud800b" }],
      ["asOf", { asOf: "2024-13-01" }],
      ["asOf", { asOf: "2023-02-29" }],
      ["asOf", { asOf: "1402/01/01" }],
      ["asOf", { asOf: 20240301 }],
      ["asOf", { asOf: "2024-03-01T00:00:00Z" }],
      ["model", { model: "" }],
      ["model", { model: "a\nb" }],
      ["model", { model: "m".repeat(129) }],
      ["model", { model: 7 }],
      ["maxOutputTokens", { maxOutputTokens: 0 }],
      ["maxOutputTokens", { maxOutputTokens: 1.5 }],
      ["maxOutputTokens", { maxOutputTokens: "800" }],
      ["maxOutputTokens", { maxOutputTokens: Number.NaN }],
      ["documentId", { documentId: "" }],
      ["documentId", { documentId: 5 }],
      ["documentId", { documentId: "a\u0001b" }],
      ["documentId", { documentId: "d".repeat(257) }],
      ["contextMaxChars", { contextMaxChars: 199 }],
      ["contextMaxChars", { contextMaxChars: 200_001 }],
      ["contextMaxChars", { contextMaxChars: 500.5 }],
      ["contextMaxChars", { contextMaxChars: "500" }],
      ["retrieval", { retrieval: 5 }],
      ["retrieval", { retrieval: [] }],
      ["retrieval", { retrieval: { limit: 0 } }],
      ["retrieval", { retrieval: { limit: 101 } }],
      ["retrieval", { retrieval: { minCoverage: 0 } }],
      ["retrieval", { retrieval: { verifiedOnly: false } }],
      ["retrieval", { retrieval: { documentId: "x" } }],
      ["requestId", { requestId: "" }],
      ["requestId", { requestId: "has space" }],
      ["requestId", { requestId: "r".repeat(129) }],
      ["requestId", { requestId: 5 }],
      ["timeoutMs", { timeoutMs: 0 }],
      ["timeoutMs", { timeoutMs: 600_001 }],
      ["timeoutMs", { timeoutMs: 1.5 }],
    ];
    for (const [field, patch] of cases) {
      const r = parseAskRequest({ ...base, ...patch });
      expect(r.ok, JSON.stringify(patch)).toBe(false);
      expect(issuesOf(r), JSON.stringify(patch)).toEqual([field]);
    }
  });

  it("مرزهای پذیرفته: سقف‌ها دقیقاً مجازند", () => {
    for (const patch of [
      { question: "a".repeat(REQUEST_LIMITS.maxQuestionChars) },
      { model: "m".repeat(128) },
      { contextMaxChars: 200 },
      { contextMaxChars: 200_000 },
      { timeoutMs: 1 },
      { timeoutMs: 600_000 },
      { requestId: "r".repeat(128) },
      { documentId: "d".repeat(256) },
      { maxOutputTokens: 1 },
      { asOf: "2024-02-29" },
      { asOf: "2000-02-29" },
      { retrieval: { limit: 100, maxTerms: 12, maxQueries: 64, minCoverage: 1 } },
      { retrieval: {} },
    ]) {
      expect(parseAskRequest({ ...base, ...patch }).ok, JSON.stringify(patch).slice(0, 60)).toBe(true);
    }
  });

  it("کلیدهای ناشناخته رد می‌شوند (غلط املایی نباید پیش‌فرض ایمن را دور بزند) — از جمله verifiedOnly و temperature", () => {
    for (const key of ["verifiedOnly", "temperature", "allowUnverified", "maxOutputToken", "Question", "stream"]) {
      const r = parseAskRequest({ ...base, [key]: key === "verifiedOnly" || key === "allowUnverified" ? false : 1 });
      expect(r.ok, key).toBe(false);
      expect(issuesOf(r)).toEqual([`unknown:${key}`]);
    }
  });

  it("issues محتوا ندارد: نه پرسش، نه مقدار نامعتبر", () => {
    const secret = "SECRET_QUESTION_TEXT_9f3";
    const r = parseAskRequest({ ...base, question: secret + "\u0000", model: secret + "\n", requestId: secret + " ", documentId: secret + "\u0001" });
    expect(JSON.stringify(r)).not.toContain(secret);
    const k = parseAskRequest({ ...base, ["key" + secret]: 1 });
    expect(JSON.stringify(k).length).toBeLessThan(200);
  });

  it("کلید ناشناختهٔ کنترل‌دار در issues پاک‌سازی می‌شود", () => {
    const r = parseAskRequest({ ...base, ["a\nb"]: 1 });
    expect(issuesOf(r)).toEqual(["unknown:a?b"]);
  });
});

describe("ai-orchestrator · isCalendarDate / hasLoneSurrogate", () => {
  it("جدول کبیسه و طول ماه‌ها", () => {
    const valid = ["2024-02-29", "2000-02-29", "2024-01-31", "2024-04-30", "2024-12-31", "0001-01-01", "2001-09-30"];
    const invalid = ["2023-02-29", "1900-02-29", "2100-02-29", "2024-04-31", "2024-06-31", "2024-09-31", "2024-11-31", "2024-00-10", "2024-13-10", "2024-01-00", "2024-01-32", "0000-01-01", "24-01-01", "2024-1-01", "2024-01-1", " 2024-01-01", "2024-01-01 ", "2024/01/01", "۲۰۲۴-۰۱-۰۱", ""];
    for (const s of valid) expect(isCalendarDate(s), s).toBe(true);
    for (const s of invalid) expect(isCalendarDate(s), s).toBe(false);
  });

  it("جفت‌جانشین", () => {
    expect(hasLoneSurrogate("سلام 😀")).toBe(false);
    expect(hasLoneSurrogate("\ud83d")).toBe(true);
    expect(hasLoneSurrogate("\ude00")).toBe(true);
    expect(hasLoneSurrogate("a\ud83d")).toBe(true);
    expect(hasLoneSurrogate("\ud83da")).toBe(true);
    expect(hasLoneSurrogate("\ude00\ud83d")).toBe(true);
    expect(hasLoneSurrogate("")).toBe(false);
  });
});

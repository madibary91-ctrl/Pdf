import { describe, expect, it } from "vitest";
import { OUTPUT_LIMITS, parseModelOutput } from "./model-output";

const ok = (raw: string) => {
  const r = parseModelOutput(raw);
  if (!r.ok) throw new Error(`unexpected reason: ${r.reason}`);
  return r.value;
};
const reason = (raw: string): string => {
  const r = parseModelOutput(raw);
  if (r.ok) throw new Error("expected failure");
  return r.reason;
};
const good = { answer: "پاسخ [S1]", insufficient: false, citations: [{ source: "S1", quote: "نقل" }] };

describe("ai-orchestrator · parseModelOutput", () => {
  it("JSON خام معتبر", () => {
    expect(ok(JSON.stringify(good))).toEqual({ insufficient: false, answer: "پاسخ [S1]", citations: [{ source: "S1", quote: "نقل" }], fenced: false, extraFields: false });
  });

  it("بلوک ``` با و بدون json، BOM و فاصله‌های پیرامون", () => {
    const body = JSON.stringify(good);
    for (const raw of ["```json\n" + body + "\n```", "```\n" + body + "\n```", "  ```JSON \r\n" + body + "\r\n```  ", "\uFEFF```json\n" + body + "```", "\uFEFF" + body]) {
      const v = ok(raw);
      expect(v.answer, raw.slice(0, 12)).toBe("پاسخ [S1]");
      expect(v.fenced).toBe(raw.includes("```"));
    }
  });

  it("هر چیز جز JSON/یک بلوک ⇒ رد با دلیل بسته", () => {
    const body = JSON.stringify(good);
    expect(reason("")).toBe("empty");
    expect(reason("  \n ")).toBe("empty");
    expect(reason("\uFEFF")).toBe("empty");
    expect(reason("پاسخ: " + body)).toBe("not-json");
    expect(reason(body + " توضیح")).toBe("not-json");
    expect(reason(body + body)).toBe("not-json");
    expect(reason("not json")).toBe("not-json");
    expect(reason("[1]")).toBe("not-object");
    expect(reason("null")).toBe("not-object");
    expect(reason('"x"')).toBe("not-object");
    expect(reason("5")).toBe("not-object");
    expect(reason("```json\n" + body)).toBe("bad-fence");
    expect(reason("```json{}```")).toBe("bad-fence");
    expect(reason("```python\n" + body + "\n```")).toBe("bad-fence");
    expect(reason("```json\n" + body + "\n```\n```json\n" + body + "\n```")).toBe("not-json");
    expect(parseModelOutput(5 as unknown as string)).toEqual({ ok: false, reason: "empty" });
  });

  it("answer: الزامی و غیرتهی مگر insufficient", () => {
    expect(reason("{}")).toBe("missing-answer");
    expect(reason('{"answer": ""}')).toBe("missing-answer");
    expect(reason('{"answer": "  \\n"}')).toBe("missing-answer");
    expect(reason('{"answer": 5}')).toBe("missing-answer");
    expect(reason('{"answer": null, "insufficient": false}')).toBe("missing-answer");
    expect(ok('{"insufficient": true}')).toMatchObject({ insufficient: true, answer: "", citations: [] });
    expect(ok('{"answer": "ignored", "insufficient": true}')).toMatchObject({ insufficient: true, answer: "" });
  });

  it("insufficient: فقط بولی؛ نبودن = false", () => {
    for (const v of ['"true"', "1", "0", "null", "[]", '"false"']) expect(reason(`{"answer": "x", "insufficient": ${v}}`), v).toBe("bad-field");
    expect(ok('{"answer": "x"}').insufficient).toBe(false);
    expect(ok('{"answer": "x", "insufficient": false}').insufficient).toBe(false);
  });

  it("citations: ساختار، سقف‌ها و نرمال‌سازی نقل‌قول", () => {
    expect(reason('{"answer":"x","citations":"S1"}')).toBe("bad-field");
    expect(reason('{"answer":"x","citations":{}}')).toBe("bad-field");
    expect(reason('{"answer":"x","citations":[1]}')).toBe("bad-field");
    expect(reason('{"answer":"x","citations":[null]}')).toBe("bad-field");
    expect(reason('{"answer":"x","citations":[["S1"]]}')).toBe("bad-field");
    expect(reason('{"answer":"x","citations":[{}]}')).toBe("bad-field");
    expect(reason('{"answer":"x","citations":[{"source":5}]}')).toBe("bad-field");
    expect(reason('{"answer":"x","citations":[{"source":""}]}')).toBe("bad-field");
    expect(reason('{"answer":"x","citations":[{"source":"S1","quote":5}]}')).toBe("bad-field");
    expect(reason(JSON.stringify({ answer: "x", citations: [{ source: "S".repeat(OUTPUT_LIMITS.maxSourceIdChars + 1) }] }))).toBe("bad-field");
    expect(ok(JSON.stringify({ answer: "x", citations: [{ source: "S".repeat(OUTPUT_LIMITS.maxSourceIdChars) }] })).citations).toHaveLength(1);
    const many = (n: number) => JSON.stringify({ answer: "x", citations: Array.from({ length: n }, () => ({ source: "S1" })) });
    expect(ok(many(OUTPUT_LIMITS.maxCitations)).citations).toHaveLength(OUTPUT_LIMITS.maxCitations);
    expect(reason(many(OUTPUT_LIMITS.maxCitations + 1))).toBe("too-large");
    const q = (n: number) => JSON.stringify({ answer: "x", citations: [{ source: "S1", quote: "q".repeat(n) }] });
    expect(ok(q(OUTPUT_LIMITS.maxQuoteChars)).citations[0]?.quote).toHaveLength(OUTPUT_LIMITS.maxQuoteChars);
    expect(reason(q(OUTPUT_LIMITS.maxQuoteChars + 1))).toBe("too-large");
    const v = ok('{"answer":"x","citations":[{"source":"S1"},{"source":"S2","quote":null},{"source":"S3","quote":"  "},{"source":"S4","quote":" نقل "}]}');
    expect(v.citations).toEqual([{ source: "S1", quote: null }, { source: "S2", quote: null }, { source: "S3", quote: null }, { source: "S4", quote: " نقل " }]);
    expect(ok('{"answer":"x"}').citations).toEqual([]);
  });

  it("سقف‌های اندازه: پاسخ و خروجی خام", () => {
    expect(ok(JSON.stringify({ answer: "a".repeat(OUTPUT_LIMITS.maxAnswerChars) })).answer).toHaveLength(OUTPUT_LIMITS.maxAnswerChars);
    expect(reason(JSON.stringify({ answer: "a".repeat(OUTPUT_LIMITS.maxAnswerChars + 1) }))).toBe("too-large");
    expect(reason("x".repeat(OUTPUT_LIMITS.maxRawChars + 1))).toBe("too-large");
  });

  it("کلید اضافی نادیده و علامت‌گذاری می‌شود؛ __proto__ بی‌اثر است", () => {
    expect(ok('{"answer":"x","confidence":0.9}').extraFields).toBe(true);
    expect(ok('{"answer":"x"}').extraFields).toBe(false);
    const v = ok('{"answer":"x","__proto__":{"polluted":true}}');
    expect(v.extraFields).toBe(true);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("دلیل‌ها هرگز محتوای خروجی را نمی‌آورند", () => {
    const secret = "SECRET_MODEL_TEXT_5521";
    for (const raw of [secret, `{"answer": 5, "x": "${secret}"}`, "```" + secret, `[${secret}]`]) {
      const r = parseModelOutput(raw);
      expect(JSON.stringify(r)).not.toContain(secret);
    }
  });
});

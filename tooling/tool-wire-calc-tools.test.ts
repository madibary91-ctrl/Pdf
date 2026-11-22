import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeToolReply, encodeToolResults, encodeTools, TOOL_LIMITS, type ToolCall, type ToolSpec, type ToolWireFormat } from "@/modules/ai-gateway";
import { CALC_TOOLS, MAX_ARGS_JSON_LENGTH, executeCalcToolJson } from "@/modules/calc-tools";

/**
 * مرزِ «مدل ← سیم ← ابزار» (ADR-0054). ai-gateway و calc-tools عمداً از هم بی‌خبرند (registry)؛ این آزمون در tooling است
 * چون فقط این‌جا می‌شود هر دو را کنار هم گذاشت. هر دو قالبِ سیم، با پاسخ‌های **شبیه‌سازی‌شدهٔ** مدل (نه مدلِ واقعی).
 */

// آزمونِ نوع: توصیفِ calc-tools ساختاراً همان ToolSpec است (اگر ناسازگار شود tsc قرمز می‌شود).
const SPECS: readonly ToolSpec[] = CALC_TOOLS;

const FORMATS: readonly ToolWireFormat[] = ["openai-chat", "anthropic-messages"];
const GOOD_ARGS = { date: { year: 1404, month: 6, day: 15 }, stage: "first-instance", claim: { kind: "known", amountRials: 100_000_000 } };

const modelReply = (format: ToolWireFormat, id: string, name: string, args: unknown, rawArgs?: string): unknown =>
  format === "openai-chat"
    ? {
        model: "sim",
        choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: rawArgs ?? JSON.stringify(args) } }] } }],
        usage: { prompt_tokens: 300, completion_tokens: 40 },
      }
    : {
        type: "message",
        role: "assistant",
        model: "sim",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id, name, input: args }],
        usage: { input_tokens: 300, output_tokens: 40 },
      };

/** همان کاری که حلقهٔ ابزارِ آینده (CT‑4) باید بکند: اجرا و تبدیلِ نتیجه/خطا به محتوای بازگشتی. */
function runCall(call: ToolCall): { id: string; content: string; isError: boolean } {
  const r = executeCalcToolJson(call.name, call.argumentsJson);
  return r.ok
    ? { id: call.id, content: JSON.stringify({ result: r.value.result, review: r.value.review, reviewPending: r.value.reviewPending, notes: r.value.notes }), isError: false }
    : { id: call.id, content: JSON.stringify({ error: r.error }), isError: true };
}

describe("ai-gateway ⇄ calc-tools: توصیف", () => {
  it.each(FORMATS)("%s: توصیفِ هر دو ابزار عیناً (نام، توضیح، شما) به مدل می‌رسد", (format) => {
    const r = encodeTools(format, SPECS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const tools = (r.value["tools"] as Record<string, unknown>[]).map((t) => (format === "openai-chat" ? (t["function"] as Record<string, unknown>) : t));
    expect(tools).toHaveLength(CALC_TOOLS.length);
    tools.forEach((t, i) => {
      const d = CALC_TOOLS[i]!;
      expect(t["name"]).toBe(d.name);
      expect(t["description"]).toBe(d.description);
      expect(t[format === "openai-chat" ? "parameters" : "input_schema"]).toEqual(d.parameters);
    });
    // آنچه فرستاده می‌شود از JSON رد می‌شود و بی‌تغییر برمی‌گردد (بی‌NaN/undefined)
    expect(JSON.parse(JSON.stringify(r.value))).toEqual(r.value);
  });
  it("توصیف‌های calc-tools در سقف‌های رمزگذار می‌گنجند", () => {
    for (const d of CALC_TOOLS) {
      expect(d.description.length).toBeLessThanOrEqual(TOOL_LIMITS.maxDescriptionChars);
      expect(JSON.stringify(d.parameters).length).toBeLessThanOrEqual(TOOL_LIMITS.maxSchemaChars);
    }
    expect(CALC_TOOLS.length).toBeLessThanOrEqual(TOOL_LIMITS.maxTools);
  });
  it("سقفِ دقیقِ آرگومانِ calc-tools پیش از سقفِ فنیِ رمزگذار می‌رسد (خطای قابل‌اصلاح برای مدل)", () => {
    expect(MAX_ARGS_JSON_LENGTH).toBeLessThan(TOOL_LIMITS.maxArgumentChars);
  });
  it("ابزارِ اجباری و ممنوع روی نام‌های واقعی کار می‌کند", () => {
    for (const format of FORMATS) {
      expect(encodeTools(format, SPECS, { choice: { name: "court_fee" } }).ok).toBe(true);
      expect(encodeTools(format, SPECS, { choice: { name: "inheritance" } }).ok).toBe(false);
    }
  });
});

describe("ai-gateway ⇄ calc-tools: گامِ کاملِ مدل ← ابزار ← مدل", () => {
  it.each(FORMATS)("%s: فراخوانیِ درست ⇒ نتیجهٔ legal-calc با reviewPending و notes به مدل برمی‌گردد", (format) => {
    const d = decodeToolReply(format, modelReply(format, "call_1", "court_fee", GOOD_ARGS));
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.value.finish).toBe("tool_calls");
    const out = d.value.toolCalls.map(runCall);
    expect(out[0]?.isError).toBe(false);
    const payload = JSON.parse(out[0]!.content) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["notes", "result", "review", "reviewPending"]);
    expect(typeof payload["reviewPending"]).toBe("boolean");
    const back = encodeToolResults(format, d.value.toolCalls, out);
    expect(back.ok).toBe(true);
    if (back.ok) expect(JSON.stringify(back.value)).toContain("call_1");
  });
  it.each(FORMATS)("%s: مبلغِ رشته‌ای ⇒ خطای ابزار، که با isError به مدل برمی‌گردد تا خودش را اصلاح کند", (format) => {
    const bad = { ...GOOD_ARGS, claim: { kind: "known", amountRials: "۱۰۰۰۰۰۰۰۰" } };
    const d = decodeToolReply(format, modelReply(format, "call_2", "court_fee", bad));
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    const out = d.value.toolCalls.map(runCall);
    expect(out[0]?.isError).toBe(true);
    expect((JSON.parse(out[0]!.content) as { error: { code: string } }).error.code).toBe("INVALID_INPUT");
    const back = encodeToolResults(format, d.value.toolCalls, out);
    expect(back.ok).toBe(true);
    if (back.ok && format === "anthropic-messages") expect(JSON.stringify(back.value)).toContain('"is_error":true');
  });
  it("OpenAI: JSONِ نیمه‌کاره از مدل ⇒ خطای PARSE_ERRORِ ابزار (نه شکستِ رمزگشایی)؛ قابل‌بازگشت به مدل", () => {
    const d = decodeToolReply("openai-chat", modelReply("openai-chat", "call_3", "court_fee", null, '{"date": {"year": 14'));
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    const out = d.value.toolCalls.map(runCall);
    expect(out[0]?.isError).toBe(true);
    expect((JSON.parse(out[0]!.content) as { error: { code: string } }).error.code).toBe("PARSE_ERROR");
    expect(encodeToolResults("openai-chat", d.value.toolCalls, out).ok).toBe(true);
  });
  it.each(FORMATS)("%s: ابزارِ ناموجودِ مدل (توهم) ⇒ خطای بسته، نه پرتاب", (format) => {
    for (const name of ["inheritance", "__proto__", "constructor", "court-fee"]) {
      const d = decodeToolReply(format, modelReply(format, "call_4", name, {}));
      expect(d.ok).toBe(true);
      if (!d.ok) continue;
      const out = d.value.toolCalls.map(runCall);
      expect(out[0]?.isError).toBe(true);
      expect(encodeToolResults(format, d.value.toolCalls, out).ok).toBe(true);
    }
  });
  it.each(FORMATS)("%s: فراخوانیِ بریده هرگز به اجرا نمی‌رسد", (format) => {
    const raw = modelReply(format, "call_5", "court_fee", GOOD_ARGS) as Record<string, unknown>;
    if (format === "openai-chat") (raw["choices"] as { finish_reason: string }[])[0]!.finish_reason = "length";
    else raw["stop_reason"] = "max_tokens";
    const d = decodeToolReply(format, raw);
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.error.code).toBe("TRUNCATED_TOOL_CALL");
      expect(d.error.usage).toEqual({ inputTokens: 300, outputTokens: 40 });
    }
  });
  it("آرگومانِ بزرگتر از سقفِ calc-tools کوچک‌تر از سقفِ فنی است و خطای ابزار می‌دهد، نه شکستِ پاسخ", () => {
    const args = JSON.stringify({ pad: "x".repeat(MAX_ARGS_JSON_LENGTH + 10) });
    expect(args.length).toBeLessThan(TOOL_LIMITS.maxArgumentChars);
    const d = decodeToolReply("openai-chat", modelReply("openai-chat", "call_6", "court_fee", null, args));
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.value.toolCalls.map(runCall)[0]?.isError).toBe(true);
  });
});

describe("ai-gateway: مرزِ ماژول", () => {
  const DIR = join(__dirname, "..", "src", "modules", "ai-gateway");
  const files = readdirSync(DIR).filter((f) => /^tool-wire.*\.ts$/.test(f) && !f.endsWith(".test.ts"));
  it("فایل‌های رمزگذار پیدا شدند", () => {
    expect(files.sort()).toEqual(["tool-wire-decode.ts", "tool-wire-json.ts", "tool-wire-types.ts", "tool-wire.ts"]);
  });
  it("هیچ فایلِ ai-gateway به calc-tools یا ماژولِ دیگر وابسته نیست و فقط از ./ import می‌کند", () => {
    for (const f of readdirSync(DIR).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && n !== "test-kit.ts")) {
      const src = readFileSync(join(DIR, f), "utf8");
      for (const m of src.matchAll(/from "([^"]+)"/g)) expect(m[1]!.startsWith("./"), `${f}: ${m[1]}`).toBe(true);
      expect(/calc-tools/.test(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")), f).toBe(false);
    }
  });
  it("هیچ عددِ حقوقی/تعرفه‌ای در رمزگذار نیست و strict روشن نمی‌شود", () => {
    for (const f of files) {
      const code = readFileSync(join(DIR, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(/\b(ریال|تعرفه|دیه|مهریه)\b/.test(code), f).toBe(false);
      expect(/strict\s*:\s*true/.test(code), f).toBe(false);
    }
  });
});

/**
 * رمزگشای سمتِ پاسخ: پاسخِ خامِ OpenAI (chat/completions) یا Anthropic (messages) ← `DecodedToolReply`.
 * پاسخ «دادهٔ ناقابل‌اعتماد» است؛ هرگز پرتاب نمی‌کند و هر ناسازگاری `BAD_RESPONSE` است.
 *
 * قاعده‌های ایمنی (ADR-0054):
 * - فراخوانیِ **بریده** (`length`/`max_tokens`/`content_filter` همراهِ ابزار) هرگز اجرا نمی‌شود ⇒ `TRUNCATED_TOOL_CALL`
 *   (آرگومانِ نیمه‌تمام می‌تواند عددِ حقوقیِ غلط بسازد).
 * - مصرفِ معتبر حتی از پاسخِ خراب نجات داده می‌شود (هزینه شده است)؛ مصرفِ مشکوک/ناقص `null` است، نه حدس.
 * - Anthropic: توکن‌های کشِ نوشتن/خواندن در `input_tokens` نیستند؛ اگر ناصفر آمدند مصرف را کمتر از واقع نشان نمی‌دهیم ⇒ `null`.
 * - بلوک‌های ناشناخته (مثلاً thinking) رد می‌شوند، نه نادیده؛ بازگرداندنشان به مدل بدونِ آن‌ها ناسازگار است و ما thinking روشن نمی‌کنیم.
 */
import { MAX_ISSUES, checkJson, fail, freezeClone, hasForbiddenChars, isPlainRecord, report, strictUsage } from "./tool-wire-json";
import { ID_RE, NAME_RE, TOOL_LIMITS } from "./tool-wire";
import type { DecodedToolReply, ToolCall, ToolFinish, ToolWireFormat, ToolWireResult, ToolWireUsage } from "./tool-wire-types";

const MSG_BAD = "پاسخِ ارائه‌دهنده برای ابزار معتبر نیست.";
const MSG_TRUNC = "پاسخِ ارائه‌دهنده هنگامِ فراخوانیِ ابزار بریده شد؛ فراخوانی اجرا نمی‌شود.";
const MAX_SERVED_MODEL_CHARS = 200;

type Draft = { text: string; calls: ToolCall[]; finish: ToolFinish; servedModel: string | null; blocks: unknown[] };

const servedModelOf = (raw: Record<string, unknown>, issues: string[]): string | null => {
  const m = raw["model"];
  if (m === undefined) return null;
  if (typeof m !== "string" || m === "" || m.length > MAX_SERVED_MODEL_CHARS) {
    report(issues, `reply.model باید متن ۱ تا ${MAX_SERVED_MODEL_CHARS} نویسه باشد.`);
    return null;
  }
  return m;
};

/** مصرفِ معتبر از پاسخِ خام، حتی اگر باقیِ پاسخ خراب باشد؛ هرگز پرتاب نمی‌کند. */
function salvage(format: ToolWireFormat, raw: unknown): ToolWireUsage | null {
  try {
    if (!isPlainRecord(raw)) return null;
    const u = raw["usage"];
    if (!isPlainRecord(u)) return null;
    if (format === "openai-chat") return strictUsage(u["prompt_tokens"], u["completion_tokens"]);
    for (const k of ["cache_creation_input_tokens", "cache_read_input_tokens"]) {
      const v = u[k];
      if (v !== undefined && v !== null && v !== 0) return null;
    }
    // `cache_creation` (جزئیاتِ TTL) نیز اگر ناصفر باشد مصرفِ کش وجود دارد.
    if (u["cache_creation"] !== undefined && u["cache_creation"] !== null) {
      const cc = u["cache_creation"];
      if (!isPlainRecord(cc) || Object.values(cc).some((x) => x !== 0)) return null;
    }
    return strictUsage(u["input_tokens"], u["output_tokens"]);
  } catch {
    return null;
  }
}

function checkCall(id: unknown, name: unknown, issues: string[], seen: Set<string>, at: string): boolean {
  let good = true;
  if (typeof id !== "string" || !ID_RE.test(id)) {
    report(issues, `${at}: id نامعتبر است.`);
    good = false;
  } else if (seen.has(id)) {
    report(issues, `${at}: id تکراری است.`);
    good = false;
  } else seen.add(id);
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    report(issues, `${at}: name نامعتبر است.`);
    good = false;
  }
  return good;
}

function decodeOpenAi(raw: Record<string, unknown>, issues: string[]): Draft | null {
  const choices = raw["choices"];
  if (!Array.isArray(choices) || choices.length !== 1) {
    report(issues, "reply.choices باید دقیقاً یک عضو داشته باشد.");
    return null;
  }
  const choice: unknown = choices[0];
  if (!isPlainRecord(choice) || !isPlainRecord(choice["message"])) {
    report(issues, "reply.choices[0].message باید شیء باشد.");
    return null;
  }
  const msg = choice["message"];
  if (msg["role"] !== undefined && msg["role"] !== "assistant") report(issues, "message.role باید assistant باشد.");
  const content = msg["content"];
  let text = "";
  if (content !== undefined && content !== null) {
    if (typeof content !== "string") report(issues, "message.content باید متن یا null باشد.");
    else if (hasForbiddenChars(content)) report(issues, "message.content شامل NUL یا جفت‌جانشینِ تنها است.");
    else text = content;
  }
  const refusal = msg["refusal"];
  if (refusal !== undefined && refusal !== null && typeof refusal !== "string") report(issues, "message.refusal باید متن یا null باشد.");
  const refused = typeof refusal === "string" && refusal !== "";

  const calls: ToolCall[] = [];
  const rawCalls = msg["tool_calls"];
  if (rawCalls !== undefined && rawCalls !== null) {
    if (!Array.isArray(rawCalls) || rawCalls.length > TOOL_LIMITS.maxToolCalls) report(issues, `message.tool_calls باید آرایه‌ای تا ${TOOL_LIMITS.maxToolCalls} عضوی باشد.`);
    else {
      const seen = new Set<string>();
      rawCalls.forEach((c: unknown, i: number) => {
        const at = `tool_calls[${i}]`;
        if (!isPlainRecord(c) || c["type"] !== "function" || !isPlainRecord(c["function"])) return report(issues, `${at}: باید فراخوانیِ از نوعِ function باشد.`);
        const fn = c["function"];
        const good = checkCall(c["id"], fn["name"], issues, seen, at);
        const args = fn["arguments"];
        if (typeof args !== "string" || args.length > TOOL_LIMITS.maxArgumentChars || hasForbiddenChars(args)) {
          return report(issues, `${at}: arguments باید متنِ حداکثر ${TOOL_LIMITS.maxArgumentChars} نویسه (بدون NUL) باشد.`);
        }
        if (good) calls.push({ id: c["id"] as string, name: fn["name"] as string, argumentsJson: args });
      });
    }
  }

  const fr = choice["finish_reason"];
  let finish: ToolFinish;
  switch (fr) {
    case "stop": finish = "stop"; break;
    case "length": finish = "length"; break;
    case "content_filter": finish = "content_filter"; break;
    case "tool_calls": finish = "tool_calls"; break;
    default: finish = "other";
  }
  if (refused && finish !== "length") finish = "content_filter";
  const blocks = calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.argumentsJson } }));
  return { text, calls, finish, servedModel: servedModelOf(raw, issues), blocks };
}

function decodeAnthropic(raw: Record<string, unknown>, issues: string[]): Draft | null {
  if (raw["type"] !== undefined && raw["type"] !== "message") report(issues, "reply.type باید message باشد.");
  if (raw["role"] !== undefined && raw["role"] !== "assistant") report(issues, "reply.role باید assistant باشد.");
  const content = raw["content"];
  if (!Array.isArray(content) || content.length > 64) {
    report(issues, "reply.content باید آرایه‌ای تا ۶۴ بلوکی باشد.");
    return null;
  }
  let text = "";
  const calls: ToolCall[] = [];
  const blocks: unknown[] = [];
  const seen = new Set<string>();
  content.forEach((b: unknown, i: number) => {
    const at = `content[${i}]`;
    if (!isPlainRecord(b)) return report(issues, `${at}: باید شیء باشد.`);
    if (b["type"] === "text") {
      const t = b["text"];
      if (typeof t !== "string" || hasForbiddenChars(t)) return report(issues, `${at}: text باید متنِ سالم باشد.`);
      text += t;
      // Anthropic بلوکِ متنیِ تهی را در درخواست رد می‌کند؛ در بازگشت آورده نمی‌شود.
      if (t !== "") blocks.push({ type: "text", text: t });
      return;
    }
    if (b["type"] === "tool_use") {
      const good = checkCall(b["id"], b["name"], issues, seen, at);
      const input = b["input"];
      if (!isPlainRecord(input)) return report(issues, `${at}: input باید شیء باشد.`);
      const before = issues.length;
      checkJson(input, `${at}.input`, issues, false);
      if (issues.length > before) return;
      const argumentsJson = JSON.stringify(input);
      if (argumentsJson.length > TOOL_LIMITS.maxArgumentChars) return report(issues, `${at}: input بزرگ‌تر از ${TOOL_LIMITS.maxArgumentChars} نویسه است.`);
      if (good) {
        calls.push({ id: b["id"] as string, name: b["name"] as string, argumentsJson });
        blocks.push({ type: "tool_use", id: b["id"], name: b["name"], input });
      }
      return;
    }
    report(issues, `${at}: نوعِ بلوک پشتیبانی نمی‌شود.`);
  });
  let finish: ToolFinish;
  switch (raw["stop_reason"]) {
    case "end_turn":
    case "stop_sequence": finish = "stop"; break;
    case "max_tokens": finish = "length"; break;
    case "tool_use": finish = "tool_calls"; break;
    case "refusal": finish = "content_filter"; break;
    default: finish = "other";
  }
  return { text, calls, finish, servedModel: servedModelOf(raw, issues), blocks };
}

/**
 * پاسخِ خامِ (JSONِ پارس‌شدهٔ) ارائه‌دهنده را رمزگشایی می‌کند.
 * `finish === "tool_calls"` ⇔ `toolCalls` ناتهی. اگر ارائه‌دهنده ابزار را به‌اجبار صدا زده و `stop` گفته (OpenAI با tool_choice ثابت)،
 * وجودِ فراخوانیِ کامل مبنا است و `finish` به `tool_calls` اصلاح می‌شود.
 */
export function decodeToolReply(format: unknown, raw: unknown): ToolWireResult<DecodedToolReply> {
  if (format !== "openai-chat" && format !== "anthropic-messages") return fail("BAD_RESPONSE", MSG_BAD, ["format ناشناخته است."]);
  const usage = salvage(format, raw);
  try {
    if (!isPlainRecord(raw)) return fail("BAD_RESPONSE", MSG_BAD, ["reply باید شیء باشد."], usage);
    const issues: string[] = [];
    const d = format === "openai-chat" ? decodeOpenAi(raw, issues) : decodeAnthropic(raw, issues);
    if (d === null || issues.length > 0) return fail("BAD_RESPONSE", MSG_BAD, issues.slice(0, MAX_ISSUES), usage);

    let finish = d.finish;
    if (d.calls.length > 0) {
      if (finish === "length" || finish === "content_filter") return fail("TRUNCATED_TOOL_CALL", MSG_TRUNC, [`finish=${finish} همراهِ ${d.calls.length} فراخوانی.`], usage);
      finish = "tool_calls";
    } else if (finish === "tool_calls") {
      return fail("BAD_RESPONSE", MSG_BAD, ["پایانِ tool_calls بدونِ هیچ فراخوانی."], usage);
    }

    let assistantMessage: Record<string, unknown>;
    if (format === "openai-chat") {
      assistantMessage = { role: "assistant", content: d.text === "" && d.calls.length > 0 ? null : d.text };
      if (d.calls.length > 0) assistantMessage["tool_calls"] = d.blocks;
    } else {
      assistantMessage = { role: "assistant", content: d.blocks };
    }
    return {
      ok: true,
      value: freezeClone({
        text: d.text,
        toolCalls: d.calls.map((c) => ({ id: c.id, name: c.name, argumentsJson: c.argumentsJson })),
        finish,
        usage,
        servedModel: d.servedModel,
        assistantMessage,
      }),
    };
  } catch {
    return fail("BAD_RESPONSE", MSG_BAD, ["reply قابل‌خواندن نیست."], usage);
  }
}

/**
 * رمزگذارِ سمتِ درخواست: توصیفِ ابزارها و نتیجهٔ اجرای آن‌ها ← قالبِ سیمِ OpenAI (chat/completions) و Anthropic (messages).
 * خالص و بی‌پرتاب است؛ هیچ شبکه/ساعت/محیطی ندارد. پیاده‌سازیِ HTTP و حلقهٔ ابزار در برش‌های بعدی‌اند (ADR-0054).
 *
 * اصول: (۱) هر ورودی `unknown` و سنجیده؛ (۲) بی‌حدس: نامِ نامعتبر/تکراری، توصیفِ تهی یا JSONِ مبهم رد می‌شود، نه اصلاح؛
 * (۳) خروجی ژرف یخ‌زده و کپیِ مستقل از ورودی است (ویرایشِ بعدیِ فراخواننده روی آنچه فرستاده می‌شود اثر ندارد).
 */
import { MAX_ISSUES, checkJson, fail, freezeClone, hasForbiddenChars, isPlainRecord, report, shown } from "./tool-wire-json";
import type { ToolResultInput, ToolWireFormat, ToolWireResult, WireMessage } from "./tool-wire-types";

export const TOOL_LIMITS = Object.freeze({
  maxTools: 16,
  /** هر دو ارائه‌دهنده ≥۶۴ نویسه می‌پذیرند (Anthropic تا ۱۲۸)؛ کمینهٔ مشترک. */
  maxNameChars: 64,
  maxDescriptionChars: 8000,
  maxSchemaChars: 32_000,
  maxResultChars: 100_000,
  maxToolCalls: 16,
  /** سقفِ فنیِ متنِ آرگومانِ هر فراخوانی (مرزِ اجرا سقفِ دقیق‌ترِ خودش را دارد). */
  maxArgumentChars: 65_536,
  maxIdChars: 128,
});

export const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

const OPTION_KEYS: ReadonlySet<string> = new Set(["choice", "allowParallel"]);
const SPEC_KEYS: ReadonlySet<string> = new Set(["name", "description", "parameters"]);
const RESULT_KEYS: ReadonlySet<string> = new Set(["id", "content", "isError"]);

const MSG_TOOLS = "توصیفِ ابزارها معتبر نیست.";
const MSG_RESULTS = "نتیجهٔ ابزارها معتبر نیست.";

function isFormat(f: unknown): f is ToolWireFormat {
  return f === "openai-chat" || f === "anthropic-messages";
}

function unknownKeys(o: Record<string, unknown>, allowed: ReadonlySet<string>, path: string, issues: string[]): void {
  for (const k of Object.keys(o)) if (!allowed.has(k)) report(issues, `${path}: کلید ناشناخته ${JSON.stringify(shown(k))}.`);
}

/**
 * بخشِ ابزارِ بدنهٔ درخواست. نتیجه را با بدنهٔ بقیهٔ درخواست (مدل، پیام‌ها، …) ادغام کنید:
 * - `openai-chat`: `{ tools: [{type:"function", function:{name, description, parameters}}], tool_choice, parallel_tool_calls }`
 * - `anthropic-messages`: `{ tools: [{name, description, input_schema}], tool_choice: {type, …} }`
 * حالتِ `strict` ارائه‌دهنده عمداً روشن نمی‌شود: شماهای ما فیلدِ اختیاری دارند و strict همه را الزامی می‌خواهد.
 */
export function encodeTools(format: unknown, specs: unknown, options?: unknown): ToolWireResult<WireMessage> {
  try {
    const issues: string[] = [];
    if (!isFormat(format)) return fail("INVALID_TOOLS", MSG_TOOLS, ["format ناشناخته است."]);
    if (!Array.isArray(specs) || specs.length < 1 || specs.length > TOOL_LIMITS.maxTools) {
      return fail("INVALID_TOOLS", MSG_TOOLS, [`ابزارها باید آرایه‌ای ۱ تا ${TOOL_LIMITS.maxTools} عضوی باشد.`]);
    }
    let opts: Record<string, unknown> = {};
    if (options !== undefined) {
      if (!isPlainRecord(options)) return fail("INVALID_TOOLS", MSG_TOOLS, ["options باید شیء باشد."]);
      unknownKeys(options, OPTION_KEYS, "options", issues);
      opts = options;
    }
    const allowParallel = opts["allowParallel"];
    if (allowParallel !== undefined && typeof allowParallel !== "boolean") report(issues, "options.allowParallel باید بولی باشد.");

    const names = new Set<string>();
    const clean: { name: string; description: string; parameters: Record<string, unknown> }[] = [];
    specs.forEach((raw: unknown, i: number) => {
      const at = `ابزار ${i}`;
      if (!isPlainRecord(raw)) return report(issues, `${at}: باید شیء باشد.`);
      unknownKeys(raw, SPEC_KEYS, at, issues);
      const { name, description, parameters } = raw;
      if (typeof name !== "string" || !NAME_RE.test(name)) report(issues, `${at}: name باید ۱ تا ${TOOL_LIMITS.maxNameChars} نویسه از A-Za-z0-9_- باشد.`);
      else if (names.has(name)) report(issues, `${at}: name تکراری است.`);
      else names.add(name);
      if (typeof description !== "string" || description.trim() === "" || description.length > TOOL_LIMITS.maxDescriptionChars || hasForbiddenChars(description)) {
        report(issues, `${at}: description باید متنِ ناتهی تا ${TOOL_LIMITS.maxDescriptionChars} نویسه (بدون NUL) باشد.`);
      }
      if (!isPlainRecord(parameters) || parameters["type"] !== "object") return report(issues, `${at}: parameters باید JSON Schemaِ از نوع object باشد.`);
      const before = issues.length;
      checkJson(parameters, `${at}.parameters`, issues);
      if (issues.length === before && JSON.stringify(parameters).length > TOOL_LIMITS.maxSchemaChars) report(issues, `${at}: parameters بزرگ‌تر از ${TOOL_LIMITS.maxSchemaChars} نویسه است.`);
      if (issues.length === before && typeof name === "string" && typeof description === "string") clean.push({ name, description, parameters });
    });

    const choice = opts["choice"];
    let choiceName: string | null = null;
    if (choice !== undefined && choice !== "auto" && choice !== "none" && choice !== "required") {
      if (!isPlainRecord(choice) || typeof choice["name"] !== "string" || Object.keys(choice).length !== 1) report(issues, "options.choice باید auto، none، required یا {name} باشد.");
      else if (!names.has(choice["name"])) report(issues, "options.choice.name در میان ابزارها نیست.");
      else choiceName = choice["name"];
    }
    if (issues.length > 0) return fail("INVALID_TOOLS", MSG_TOOLS, issues);

    const mode = choiceName !== null ? "tool" : choice === "none" || choice === "required" ? choice : "auto";
    const parallel = allowParallel === true;
    if (format === "openai-chat") {
      const toolChoice = mode === "tool" ? { type: "function", function: { name: choiceName } } : mode;
      return {
        ok: true,
        value: freezeClone({
          tools: clean.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
          tool_choice: toolChoice,
          parallel_tool_calls: parallel,
        }),
      };
    }
    // Anthropic: `required` ⇒ `any`؛ `disable_parallel_tool_use` برای `none` معنا ندارد و فرستاده نمی‌شود.
    const tc: Record<string, unknown> = mode === "tool" ? { type: "tool", name: choiceName } : { type: mode === "required" ? "any" : mode };
    if (mode !== "none") tc["disable_parallel_tool_use"] = !parallel;
    return {
      ok: true,
      value: freezeClone({ tools: clean.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })), tool_choice: tc }),
    };
  } catch {
    return fail("INVALID_TOOLS", MSG_TOOLS, ["ورودی قابل‌خواندن نیست."]);
  }
}

/**
 * پیام(های) نتیجهٔ ابزارها برای گام بعد. **هر فراخوانیِ گام قبل دقیقاً یک‌بار پاسخ بدهد** (ارائه‌دهنده‌ها نبودنِ نتیجه را با ۴۰۰ رد می‌کنند)؛
 * ترتیبِ خروجی ترتیبِ `calls` است نه ترتیبِ `results`.
 * - `openai-chat`: یک پیامِ `{role:"tool", tool_call_id, content}` برای هر نتیجه.
 * - `anthropic-messages`: **یک** پیامِ `user` با بلوک‌های `tool_result` (و `is_error` فقط وقتی خطاست).
 */
export function encodeToolResults(format: unknown, calls: unknown, results: unknown): ToolWireResult<readonly WireMessage[]> {
  try {
    if (!isFormat(format)) return fail("INVALID_TOOL_RESULTS", MSG_RESULTS, ["format ناشناخته است."]);
    const issues: string[] = [];
    if (!Array.isArray(calls) || calls.length < 1 || calls.length > TOOL_LIMITS.maxToolCalls) return fail("INVALID_TOOL_RESULTS", MSG_RESULTS, [`calls باید آرایه‌ای ۱ تا ${TOOL_LIMITS.maxToolCalls} عضوی باشد.`]);
    if (!Array.isArray(results) || results.length > TOOL_LIMITS.maxToolCalls) return fail("INVALID_TOOL_RESULTS", MSG_RESULTS, [`results باید آرایه‌ای تا ${TOOL_LIMITS.maxToolCalls} عضوی باشد.`]);

    const expected: string[] = [];
    for (const c of calls as readonly unknown[]) {
      const id = isPlainRecord(c) ? c["id"] : undefined;
      if (typeof id !== "string" || !ID_RE.test(id) || expected.includes(id)) report(issues, "calls: هر عضو باید id معتبر و یکتا داشته باشد.");
      else expected.push(id);
    }
    const byId = new Map<string, ToolResultInput>();
    (results as readonly unknown[]).forEach((r, i) => {
      const at = `نتیجه ${i}`;
      if (!isPlainRecord(r)) return report(issues, `${at}: باید شیء باشد.`);
      unknownKeys(r, RESULT_KEYS, at, issues);
      const { id, content, isError } = r;
      if (typeof id !== "string" || !ID_RE.test(id)) return report(issues, `${at}: id نامعتبر است.`);
      if (byId.has(id)) return report(issues, `${at}: id تکراری است.`);
      if (!expected.includes(id)) report(issues, `${at}: id به هیچ فراخوانی مربوط نیست.`);
      if (typeof content !== "string" || content === "" || content.length > TOOL_LIMITS.maxResultChars || hasForbiddenChars(content)) {
        report(issues, `${at}: content باید متنِ ناتهی تا ${TOOL_LIMITS.maxResultChars} نویسه (بدون NUL و جفت‌جانشینِ تنها) باشد.`);
      }
      if (isError !== undefined && typeof isError !== "boolean") report(issues, `${at}: isError باید بولی باشد.`);
      byId.set(id, { id, content: content as string, isError: isError === true });
    });
    for (const id of expected) if (!byId.has(id)) report(issues, "برای دست‌کم یک فراخوانی نتیجه‌ای داده نشده است.");
    if (issues.length > 0) return fail("INVALID_TOOL_RESULTS", MSG_RESULTS, issues.slice(0, MAX_ISSUES));

    const ordered = expected.map((id) => byId.get(id) as ToolResultInput);
    if (format === "openai-chat") {
      return { ok: true, value: freezeClone(ordered.map((r) => ({ role: "tool", tool_call_id: r.id, content: r.content }))) };
    }
    const blocks = ordered.map((r) => (r.isError === true ? { type: "tool_result", tool_use_id: r.id, content: r.content, is_error: true } : { type: "tool_result", tool_use_id: r.id, content: r.content }));
    return { ok: true, value: freezeClone([{ role: "user", content: blocks }]) };
  } catch {
    return fail("INVALID_TOOL_RESULTS", MSG_RESULTS, ["ورودی قابل‌خواندن نیست."]);
  }
}


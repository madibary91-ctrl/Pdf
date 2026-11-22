/** سنجشِ `ToolSetup` روی مرز: هر مدلِ ابزاری باید در پیکربندیِ پایه باشد، قالبِ شناخته‌شده و متدِ `completeWithTools` داشته باشد. */
import type { ToolModelProvider } from "./tool-step-types";
import type { ToolWireFormat } from "./tool-wire-types";

export type ResolvedToolModel = Readonly<{ format: ToolWireFormat; provider: ToolModelProvider }>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** متدِ ارائه‌دهنده هنگام ساخت «گرفته» می‌شود (bind)؛ جایگزین‌کردنِ بعدیِ متد روی شیءِ ورودی اثری ندارد. */
export function resolveToolSetup(
  setup: unknown,
  hasModel: (name: string) => boolean,
): Readonly<{ ok: true; value: ReadonlyMap<string, ResolvedToolModel> }> | Readonly<{ ok: false; issues: readonly string[] }> {
  const issues: string[] = [];
  const out = new Map<string, ResolvedToolModel>();
  try {
    if (!isRecord(setup)) return { ok: false, issues: ["tools باید شیء باشد."] };
    for (const k of Object.keys(setup)) if (k !== "models") issues.push(`tools: کلید ناشناخته ${JSON.stringify(k.slice(0, 40))}.`);
    const models = setup["models"];
    if (!isRecord(models) || Object.keys(models).length === 0) issues.push("tools.models باید شیءِ غیرتهی باشد.");
    else {
      for (const name of Object.keys(models)) {
        const at = `tools.models[${JSON.stringify(name.slice(0, 40))}]`;
        const m = models[name];
        if (!hasModel(name)) {
          issues.push(`${at}: مدل در پیکربندیِ پایه نیست.`);
          continue;
        }
        if (!isRecord(m)) {
          issues.push(`${at} باید شیء باشد.`);
          continue;
        }
        for (const k of Object.keys(m)) if (k !== "format" && k !== "provider") issues.push(`${at}: کلید ناشناخته ${JSON.stringify(k.slice(0, 40))}.`);
        const format = m["format"];
        const provider = m["provider"];
        if (format !== "openai-chat" && format !== "anthropic-messages") issues.push(`${at}.format باید openai-chat یا anthropic-messages باشد.`);
        if (!isRecord(provider) || typeof provider["completeWithTools"] !== "function") issues.push(`${at}.provider باید تابع completeWithTools داشته باشد.`);
        if (format === "openai-chat" || format === "anthropic-messages") {
          if (isRecord(provider) && typeof provider["completeWithTools"] === "function") {
            const fn = (provider["completeWithTools"] as ToolModelProvider["completeWithTools"]).bind(provider);
            out.set(name, Object.freeze({ format, provider: Object.freeze({ completeWithTools: fn }) }));
          }
        }
      }
    }
  } catch {
    return { ok: false, issues: ["tools قابل خواندن نیست."] };
  }
  if (issues.length > 0) return { ok: false, issues: issues.slice(0, 10) };
  return { ok: true, value: out };
}

/**
 * پاسخ ارائه‌دهنده «دادهٔ ناقابل‌اعتماد» است: ساختارش روی مرز سنجیده می‌شود. مصرف جدا و بردبار استخراج می‌شود تا حتی
 * اگر باقی پاسخ خراب بود، مصرفِ معتبرِ گزارش‌شده برای ثبت هزینه از دست نرود.
 */
import { parseUsage } from "./pricing";
import type { FinishReason, Usage } from "./types";

const FINISH: ReadonlySet<string> = new Set(["stop", "length", "content_filter", "other"]);
export const MAX_SERVED_MODEL_CHARS = 200;

export type ParsedReply = Readonly<{ text: string; finishReason: FinishReason; usage: Usage | null; servedModel: string | null }>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** مصرفِ معتبر از پاسخِ خام (حتی اگر پاسخ در جاهای دیگر خراب باشد)؛ ناپیدا یا نامعتبر ⇒ `null`. */
export function salvageUsage(raw: unknown): Usage | null {
  try {
    return isRecord(raw) ? parseUsage(raw["usage"]) : null;
  } catch {
    return null;
  }
}

export function parseReply(raw: unknown): Readonly<{ ok: true; value: ParsedReply }> | Readonly<{ ok: false; issues: readonly string[] }> {
  try {
    if (!isRecord(raw)) return { ok: false, issues: ["reply باید شیء باشد."] };
    const issues: string[] = [];
    const text = raw["text"];
    if (typeof text !== "string") issues.push("reply.text باید متن باشد.");
    const fr = raw["finishReason"];
    if (typeof fr !== "string" || !FINISH.has(fr)) issues.push("reply.finishReason باید stop، length، content_filter یا other باشد.");
    let usage: Usage | null = null;
    if (raw["usage"] !== undefined) {
      usage = parseUsage(raw["usage"]);
      if (usage === null) issues.push("reply.usage باید inputTokens و outputTokens صحیح ۰ تا ۱۰⁹ داشته باشد.");
    }
    let servedModel: string | null = null;
    if (raw["model"] !== undefined) {
      const m = raw["model"];
      if (typeof m !== "string" || m === "" || m.length > MAX_SERVED_MODEL_CHARS) issues.push(`reply.model باید متن ۱ تا ${MAX_SERVED_MODEL_CHARS} نویسه باشد.`);
      else servedModel = m;
    }
    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, value: { text: text as string, finishReason: fr as FinishReason, usage, servedModel } };
  } catch {
    return { ok: false, issues: ["reply قابل خواندن نیست."] };
  }
}

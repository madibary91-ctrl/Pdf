/**
 * ساخت «زمینهٔ شماره‌دار» برای مدل (خالص): هر بند یک شناسهٔ `S<n>` می‌گیرد و مدل باید با همین شناسه ارجاع دهد.
 * چرا؟ ارجاعِ ساختاریافته (نه متن آزاد) خط اصلیِ دفاع citation-verifier است؛ شناسهٔ ناشناخته با `lookupSource` رد می‌شود.
 *
 * برش: بندها به ترتیب رتبه تا سقف `maxChars`. نخستین بندِ بزرگ‌تر از سقف با علامتِ صریح برش می‌خورد؛ از بند دوم به بعد،
 * بندی که جا نشود و همهٔ پس از آن حذف و در `omitted` شمرده می‌شود (ترتیب رتبه عوض نمی‌شود، بندِ کوچک‌تر و کم‌رتبه‌تر جلو نمی‌افتد).
 */
import type { Context, ContextOptions, ContextSource, Passage, RetrievalResult } from "./types";

export const DEFAULT_CONTEXT_CHARS = 6000;
export const MIN_CONTEXT_CHARS = 200;
export const MAX_CONTEXT_CHARS = 200_000;
export const TRUNCATION_MARK = "… [ادامهٔ متن به‌خاطر سقف طول حذف شد]";
const SEPARATOR = "\n\n";

function header(id: string, p: Passage): string {
  const span = `معتبر از ${p.ref.validFrom} تا ${p.validTo ?? "اکنون"}`;
  return `[${id}] ${p.documentTitle} — ماده ${p.ref.article} (${span})${p.verified ? "" : " · تأییدنشده"}`;
}

function bodyOf(p: Passage): string {
  const lines = [p.text];
  for (const s of p.subparts) lines.push(`${s.kind === "note" ? "تبصره" : "بند"} ${s.label}: ${s.text}`);
  return lines.join("\n");
}

/** برش بی‌شکستن جفت‌جانشین (surrogate). */
function cut(text: string, max: number): string {
  if (max <= 0) return "";
  let out = text.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

export function buildContext(passages: readonly Passage[], options: ContextOptions = {}): RetrievalResult<Context> {
  const maxChars = options.maxChars ?? DEFAULT_CONTEXT_CHARS;
  if (!Number.isInteger(maxChars) || maxChars < MIN_CONTEXT_CHARS || maxChars > MAX_CONTEXT_CHARS) {
    return { ok: false, error: { code: "INVALID_INPUT", message: `maxChars باید عدد صحیح ${MIN_CONTEXT_CHARS} تا ${MAX_CONTEXT_CHARS} باشد.` } };
  }
  const allowUnverified = options.allowUnverified === true;
  const eligible = passages.filter((p) => allowUnverified || p.verified);
  const omittedUnverified = passages.length - eligible.length;

  const sources: ContextSource[] = [];
  const parts: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const [i, p] of eligible.entries()) {
    const id = `S${sources.length + 1}`;
    const head = header(id, p);
    const body = bodyOf(p);
    const block = `${head}\n${body}`;
    const cost = (parts.length === 0 ? 0 : SEPARATOR.length) + block.length;
    if (used + cost <= maxChars) {
      sources.push({ id, citation: p.citation, verified: p.verified, header: head, body, truncated: false });
      parts.push(block);
      used += cost;
      continue;
    }
    if (parts.length === 0) {
      const room = maxChars - head.length - 1 - TRUNCATION_MARK.length - 1;
      if (room > 0) {
        const clipped = `${cut(body, room)}\n${TRUNCATION_MARK}`;
        sources.push({ id, citation: p.citation, verified: p.verified, header: head, body: clipped, truncated: true });
        parts.push(`${head}\n${clipped}`);
        used = parts[0]?.length ?? 0;
        omitted = eligible.length - i - 1;
        break;
      }
    }
    omitted = eligible.length - i;
    break;
  }
  return { ok: true, value: { text: parts.join(SEPARATOR), sources, omitted, omittedUnverified } };
}

/** شناسهٔ منبعِ ذکرشده توسط مدل ← ارجاع ساختاریافته؛ شناسهٔ ناموجود/جعلی ⇒ `null`. */
export function lookupSource(context: Context, id: unknown): ContextSource | null {
  return context.sources.find((s) => s.id === id) ?? null;
}

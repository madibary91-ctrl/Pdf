/**
 * نشانه‌های ارجاع `[S1]` درون متن پاسخ (خالص). هر چیزِ «نشانه‌مانند» که دستور را نقض کند **مخدوش** است و حذف می‌شود، نه نادیده:
 * پذیرفتنِ بی‌صدا یعنی چیزی شبیه ارجاع در خروجی بماند که راستی‌آزمایی نشده.
 */

/** علامت جایگزین؛ عمداً شمارهٔ ماده یا نشانهٔ `[S…]` ندارد تا خودش «ارجاع» حساب نشود. */
export const REDACTION_MARK = "[ارجاع نامعتبر حذف شد]";

export type Marker = Readonly<{
  start: number;
  end: number;
  raw: string;
  /** شناسه‌های یکتا به ترتیب ورود؛ `null` = مخدوش. */
  ids: readonly string[] | null;
}>;

// ارقام فارسی/عربی-هندی هم «شروع نشانه» حساب می‌شوند (و چون معتبر نیستند، مخدوش و حذف می‌شوند).
export const markerCandidate = (): RegExp => new RegExp("\\[\\s*[Ss]\\s*[0-9\\u06F0-\\u06F9\\u0660-\\u0669][^\\]\\n]{0,40}\\]", "g");
const VALID = /^\[S([1-9][0-9]{0,2})(?:\s*[,\u060C]\s*S[1-9][0-9]{0,2})*\]$/;

export function scanMarkers(text: string): Marker[] {
  const out: Marker[] = [];
  for (const m of text.matchAll(markerCandidate())) {
    const raw = m[0];
    const start = m.index as number;
    let ids: string[] | null = null;
    if (VALID.test(raw)) ids = [...new Set([...raw.matchAll(/S([1-9][0-9]{0,2})/g)].map((x) => `S${x[1] as string}`))];
    out.push({ start, end: start + raw.length, raw, ids });
  }
  return out;
}

/** شناسه‌های یکتای نشانه‌های معتبر، به ترتیب نخستین ظهور. */
export function idsOf(markers: readonly Marker[]): string[] {
  const seen = new Set<string>();
  for (const m of markers) for (const id of m.ids ?? []) seen.add(id);
  return [...seen];
}

/**
 * نشانهٔ مخدوش یا بی‌هیچ شناسهٔ پذیرفته ⇒ `mark`؛ در گروه فقط پذیرفته‌ها می‌مانند؛ نشانهٔ کاملاً پذیرفته **بی‌تغییر** می‌ماند
 * (تا بازنویسیِ ظاهری، «حذف» به‌شمار نیاید).
 */
export function rewriteMarkers(text: string, markers: readonly Marker[], accepted: ReadonlySet<string>, mark: string = REDACTION_MARK): string {
  let out = "";
  let pos = 0;
  for (const m of markers) {
    out += text.slice(pos, m.start);
    if (m.ids === null) out += mark;
    else {
      const kept = m.ids.filter((id) => accepted.has(id));
      if (kept.length === 0) out += mark;
      else if (kept.length === m.ids.length) out += m.raw;
      else out += `[${kept.join(", ")}]`;
    }
    pos = m.end;
  }
  return out + text.slice(pos);
}

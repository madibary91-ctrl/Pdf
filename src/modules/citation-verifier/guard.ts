/**
 * نگهبان متن: ارجاع‌های درون متنِ آزاد را پیدا، با پایگاه راستی‌آزمایی و در صورت نیاز حذف می‌کند (خالص).
 * خط دوم دفاع است؛ خط اول ارجاع ساختاریافته با `verifyCitations` است (محدودیت‌ها: extract.ts و ADR-0010).
 */
import { err, ok, type Result } from "@/modules/shared-types";
import type { CorpusIndex, IsoDate } from "@/modules/legal-kb-schema";
import { aliasTableFor, extractMentions } from "./extract";
import type { CheckedMention, TextCheck, TextCheckOptions } from "./types";
import { verifyCitation } from "./verify";

/** نشانهٔ جایگزین؛ عمداً هیچ شمارهٔ ماده‌ای ندارد تا خودش «ارجاع» حساب نشود. */
export const DEFAULT_REDACTION = "[ارجاع نامعتبر حذف شد]";

export function checkText(index: CorpusIndex, text: string, onDate: IsoDate, options: TextCheckOptions = {}): TextCheck {
  const mentions = extractMentions(text, aliasTableFor(index), options.defaultDocumentId ?? null);
  const checked: CheckedMention[] = mentions.map((mention) => {
    if (mention.status !== "resolved" || mention.claim === null) return { mention, verdict: null, accepted: false };
    const verdict = verifyCitation(index, mention.claim, onDate, options);
    return { mention, verdict, accepted: verdict.accepted };
  });
  const rejected = checked.filter((c) => !c.accepted);
  return { mentions: checked, rejected, ok: rejected.length === 0 };
}

/**
 * ارجاع‌های ردشده را در همان متن با `marker` عوض می‌کند. اگر `check` به این متن تعلق نداشته باشد (بازه‌ها نخواند)
 * خطا می‌دهد، چون جایگزینیِ نادرست یعنی ارجاع نامعتبر در خروجی بماند.
 */
export function redactRejected(text: string, check: TextCheck, marker: string = DEFAULT_REDACTION): Result<string> {
  const spans = [...check.rejected].map((c) => c.mention).sort((a, b) => b.start - a.start);
  let out = text;
  let limit = text.length;
  for (const m of spans) {
    if (m.start < 0 || m.end > limit || m.start >= m.end || text.slice(m.start, m.end) !== m.text) {
      return err("INVALID_INPUT", "نتیجهٔ بررسی به این متن تعلق ندارد (بازه‌ها با متن نمی‌خوانند).");
    }
    out = out.slice(0, m.start) + marker + out.slice(m.end);
    limit = m.start;
  }
  return ok(out);
}

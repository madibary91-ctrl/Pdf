/** جمع‌آورندهٔ کارتِ پاسخ؛ برای هر اجرای `ToolRunner.run` یک نمونه (ADR-0060). */
import type { CalcCard, CardCollectorOptions, CardCollectorResult } from "./types";
import { OBSERVE_FAILURE, OPTIONS_MESSAGE } from "./messages";
import { cardFromObservation, isRecord } from "./card";
import { composeAnswer } from "./compose";

/** سقفِ فنیِ `maxCards` (مالک کوچک‌تر می‌دهد). نه پیش‌فرض. */
export const MAX_CARDS_CEILING = 50;

const invalid = (issues: readonly string[]): CardCollectorResult => ({ ok: false, error: { code: "INVALID_OPTIONS", message: OPTIONS_MESSAGE, issues: issues.slice(0, 10) } });

/** اعتبارسنجیِ مرزی؛ هرگز پرتاب نمی‌کند و مقدار را بازتاب نمی‌دهد. */
export function createCardCollector(options: CardCollectorOptions): CardCollectorResult {
  let maxCards: unknown;
  const issues: string[] = [];
  try {
    if (!isRecord(options)) return invalid(["options: باید شیء باشد"]);
    for (const k of Object.keys(options)) if (k !== "maxCards") issues.push(`${k.length > 40 ? `${k.slice(0, 40)}…` : k}: کلید ناشناخته`);
    maxCards = options["maxCards"];
  } catch {
    return invalid(["options: خوانده نشد"]);
  }
  if (typeof maxCards !== "number" || !Number.isInteger(maxCards) || maxCards < 1 || maxCards > MAX_CARDS_CEILING) issues.push(`maxCards: عددِ صحیحِ ۱ تا ${MAX_CARDS_CEILING} الزامی است`);
  if (issues.length > 0) return invalid(issues);
  const limit = maxCards as number;

  const cards: CalcCard[] = [];
  return {
    ok: true,
    value: {
      observe(observation) {
        const card = cardFromObservation(observation);
        if (cards.length >= limit || cards.some((c) => c.callId === card.callId)) throw new Error(OBSERVE_FAILURE);
        cards.push(card);
      },
      snapshot: () => Object.freeze([...cards]),
      compose: (report) => composeAnswer(cards, report),
    },
  };
}

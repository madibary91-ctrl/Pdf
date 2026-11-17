/** گردآوری مسائل اعتبارسنجی (داخلی). همهٔ مسائل یک‌جا گزارش می‌شوند تا ingest بتواند یک‌باره همه را اصلاح کند. */
import type { CorpusIssue, IssueCode } from "./types";

/** سقف‌های فنی (نه حقوقی) برای جلوگیری از ورودی غول‌پیکر یا خصمانه. */
export const KB_LIMITS = {
  maxJsonChars: 50_000_000,
  documents: 5_000,
  articlesPerDocument: 5_000,
  versionsPerArticle: 200,
  subpartsPerVersion: 100,
  relations: 100_000,
  rulings: 100_000,
  citesPerRuling: 200,
  textChars: 200_000,
  lineChars: 500,
  urlChars: 2_048,
  maxIssues: 100,
} as const;

export type Ctx = { readonly issues: CorpusIssue[]; truncated: boolean };

export function newCtx(): Ctx {
  return { issues: [], truncated: false };
}

export function addIssue(ctx: Ctx, code: IssueCode, path: string, message: string): void {
  if (ctx.issues.length >= KB_LIMITS.maxIssues) {
    ctx.truncated = true;
    return;
  }
  ctx.issues.push({ code, path, message });
}

/** نتیجهٔ نهایی؛ اگر سقف پر شده یک مسئلهٔ پایانی می‌افزاید. */
export function finishIssues(ctx: Ctx): readonly CorpusIssue[] {
  if (!ctx.truncated) return ctx.issues;
  return [...ctx.issues, { code: "LIMIT_EXCEEDED", path: "$", message: `بیش از ${KB_LIMITS.maxIssues} مسئله وجود دارد؛ بقیه نمایش داده نمی‌شود. ابتدا همین‌ها را اصلاح کنید.` }];
}

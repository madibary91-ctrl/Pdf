/** `loadCorpus`: تنها دروازهٔ ورود داده به پایگاه دانش. ورودی `unknown` ← `Corpus` معتبر و متعارف، یا فهرست کامل مسائل. */
import { ok, type Result } from "@/modules/shared-types";
import { compareIsoDates } from "./dates";
import { checkIntegrity } from "./integrity";
import { addIssue, finishIssues, KB_LIMITS, newCtx } from "./issues";
import { compareArticleLabels, parseArticleLabel } from "./label";
import { readCorpus } from "./parse";
import type { Article, Corpus, CorpusIssue } from "./types";

/** ترتیب متعارف: مواد به ترتیب طبیعی برچسب، نسخه‌ها به ترتیب شروع. (ترتیب سندها و رابطه‌ها حفظ می‌شود.) */
function canonicalize(corpus: Corpus): Corpus {
  const rank = (a: Article) => {
    const r = parseArticleLabel(a.label);
    return r.ok ? r.value : { kind: "single" as const };
  };
  return {
    documents: corpus.documents.map((d) => ({
      ...d,
      articles: [...d.articles]
        .sort((a, b) => compareArticleLabels(rank(a), rank(b)))
        .map((a) => ({ ...a, versions: [...a.versions].sort((x, y) => compareIsoDates(x.validFrom, y.validFrom)) })),
    })),
    relations: corpus.relations,
    rulings: corpus.rulings,
  };
}

export function loadCorpus(input: unknown): Result<Corpus, readonly CorpusIssue[]> {
  const ctx = newCtx();
  const corpus = readCorpus(ctx, input);
  if (corpus && ctx.issues.length === 0) checkIntegrity(corpus, ctx);
  if (ctx.issues.length > 0 || !corpus) return failure(finishIssues(ctx));
  return ok(canonicalize(corpus));
}

export function loadCorpusFromJson(text: string): Result<Corpus, readonly CorpusIssue[]> {
  const ctx = newCtx();
  if (typeof text !== "string") {
    addIssue(ctx, "INVALID_FIELD", "$", "ورودی باید متن JSON باشد.");
    return failure(finishIssues(ctx));
  }
  if (text.length > KB_LIMITS.maxJsonChars) {
    addIssue(ctx, "LIMIT_EXCEEDED", "$", `حجم JSON بیش از ${KB_LIMITS.maxJsonChars} نویسه است.`);
    return failure(finishIssues(ctx));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    addIssue(ctx, "INVALID_FIELD", "$", "JSON نامعتبر است (خطای نحوی).");
    return failure(finishIssues(ctx));
  }
  return loadCorpus(parsed);
}

/** `err` مشترک فقط کد دامنه می‌گیرد؛ اینجا خطا فهرست مسائل است. */
function failure(issues: readonly CorpusIssue[]): Result<never, readonly CorpusIssue[]> {
  return { ok: false, error: issues };
}

/**
 * انتظارِ «قفلِ کانونی» در آزمون‌های قفلِ مشورتیِ PostgreSQL (ADR-0040) — خالص: بی‌پایگاه، بی‌ساعتِ سراسری.
 *
 * چرا؟ آزمونِ `schema-ensure-cross-module.pg.test.ts` می‌خواهد ثابت کند هر نقطهٔ ساختِ شِما پشتِ قفلِ
 * `schema:ensure:<شِما>` می‌ماند. اما `legal-kb-store.migrate` و `migrateSearch` پیش از آن قفلِ **سراسریِ** ماژول
 * (`legal-kb-store:migrate` / `legal-kb-store:search-migrate`) را می‌گیرند. فایلِ آزمونِ دیگری که هم‌زمان در همان
 * دروازه مهاجرت می‌زند آن قفل را لحظه‌ای نگه می‌دارد؛ آنگاه runnerِ این آزمون **موقتاً** پشتِ کلیدی غیرِ کانونی می‌ماند
 * و نسخهٔ قدیمیِ «تا اولین انتظار» همان لحظه `[false]` می‌دید و قرمز می‌شد (ناپایداریِ دروازه، تحویل ۰۰۳۹ بند ۶‑۱).
 * راه‌حل: انتظارِ گذرا روی کلیدِ دیگر را تحمل کن و تا دیدنِ انتظارِ کانونی بپرس؛ اگر هیچ‌گاه کانونی نشد، **آخرین مشاهدهٔ
 * غیرِ تهی را برگردان** تا ادعای فراخوان («دقیقاً [true]») همچنان قرمز شود — شکستِ بسته، نه سبزِ تهی.
 *
 * قرارداد:
 *  - `probe()` برای هر قفلِ مشورتیِ نگرفته‌شدهٔ بک‌اندِ هدف یک بولین می‌دهد: «کلیدش کانونی است؟».
 *  - برگشت: نخستین مشاهده‌ای که دست‌کم یک `true` دارد (همان، بی‌دست‌کاری)؛ وگرنه آخرین مشاهدهٔ غیرِ تهی؛ وگرنه `null`.
 *  - هیچ انتظاری دیده نشد ⇒ پس از `idlePolls` پرسش `null` (بک‌اند هیچ‌گاه پشتِ قفل نماند: آزمون نامعتبر است).
 *  - انتظارِ غیرِ کانونی دیده شد ⇒ بودجه به `transientPolls` پرسش (شمارش از نخستین دیدن) تمدید می‌شود.
 *  - میانِ دو پرسش یک `sleep(pollMs)`؛ پس از پرسشِ آخر نه.
 *  - خطای `probe`/`sleep` بلعیده نمی‌شود.
 */

export type LockWaitOptions = Readonly<{
  probe: () => Promise<readonly boolean[]>;
  sleep: (ms: number) => Promise<void>;
  pollMs: number;
  /** بیشینهٔ پرسش وقتی هیچ انتظاری هنوز دیده نشده. */
  idlePolls: number;
  /** بیشینهٔ پرسش، شمرده از نخستین دیدنِ انتظار (باید ≥ `idlePolls` باشد؛ وگرنه تمدید معنا ندارد). */
  transientPolls: number;
}>;

const isPositiveInt = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 1;

/** اعتبارسنجی پیکربندی؛ خطای برنامه‌نویس است (کمک‌تابعِ آزمون، نه مرزِ محصول) ⇒ پرتاب. */
function assertOptions(o: LockWaitOptions): void {
  if (!isPositiveInt(o.idlePolls)) throw new RangeError("lock-wait: idlePolls باید عددِ صحیحِ ≥ ۱ باشد");
  if (!isPositiveInt(o.transientPolls)) throw new RangeError("lock-wait: transientPolls باید عددِ صحیحِ ≥ ۱ باشد");
  if (o.transientPolls < o.idlePolls) throw new RangeError("lock-wait: transientPolls نباید از idlePolls کمتر باشد");
  if (typeof o.pollMs !== "number" || !Number.isFinite(o.pollMs) || o.pollMs < 0) throw new RangeError("lock-wait: pollMs باید عددِ متناهیِ ≥ ۰ باشد");
}

export async function waitForCanonicalWait(options: LockWaitOptions): Promise<readonly boolean[] | null> {
  assertOptions(options);
  const { probe, sleep, pollMs, idlePolls, transientPolls } = options;
  let lastNonEmpty: readonly boolean[] | null = null;
  let firstSeenAt = -1;
  for (let poll = 0; ; poll++) {
    const seen = await probe();
    if (seen.includes(true)) return seen;
    if (seen.length > 0) {
      lastNonEmpty = seen;
      if (firstSeenAt < 0) firstSeenAt = poll;
    }
    const budget = firstSeenAt < 0 ? idlePolls : firstSeenAt + transientPolls;
    if (poll + 1 >= budget) return lastNonEmpty;
    await sleep(pollMs);
  }
}

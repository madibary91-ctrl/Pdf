/**
 * پایگاهِ تنبل (داخلی): `open()` تزریقی فقط در نخستین استفادهٔ فروشگاه صدا زده می‌شود، تا آرگومانِ بد یا شِمای نامعتبر هرگز اتصالی نسازد.
 * ناورداها: یک‌بار باز می‌شود (هم‌زمانی هم یک وعده)؛ `close` همیشه کران‌دار و نپرتاب؛ اتصالی که پس از رها‌کردنِ اجرا (مهلت) دیر باز شد بی‌درنگ بسته می‌شود؛
 * پایگاهِ نامعتبر (بی‌execute/transaction) خطای برنامه‌نویسی است (`invalid()`)، نه «در دسترس نبودن». خطای باز‌کردن (که ممکن است رشتهٔ اتصال داشته باشد) هرگز خوانده نمی‌شود.
 */
import type { LedgerDatabase } from "@/modules/ledger";
import type { LoopTimer } from "@/modules/settlement";
import { bounded } from "./deadline";
import type { OpenedPendingDatabase } from "./types";

export const CLOSE_TIMEOUT_MS = 5_000;

type OpenState = "idle" | "opening" | "open" | "failed";

export type LazyDatabase = Readonly<{
  db: LedgerDatabase;
  /** `true` اگر اتصال بسته شد یا هرگز نبود؛ `false` اگر بسته‌شدن شکست/به مهلت خورد یا بازشدن هنوز در جریان است. */
  close(timer: LoopTimer): Promise<boolean>;
  invalid(): boolean;
}>;

const hasFn = (o: unknown, k: string): boolean => typeof o === "object" && o !== null && typeof (o as Record<string, unknown>)[k] === "function";

export function createLazyDatabase(open: () => OpenedPendingDatabase | Promise<OpenedPendingDatabase>): LazyDatabase {
  let state: OpenState = "idle";
  let opening: Promise<LedgerDatabase> | null = null;
  let opened: OpenedPendingDatabase | null = null;
  let abandoned = false;
  let invalidDb = false;

  const closeQuietly = async (o: OpenedPendingDatabase): Promise<void> => {
    try {
      await o.close();
    } catch {
      // بستنِ ناموفق بی‌خطر است (فرایند را گلو می‌بُرد).
    }
  };

  const ensure = (): Promise<LedgerDatabase> => {
    if (opening === null) {
      state = "opening";
      opening = (async () => {
        let o: OpenedPendingDatabase;
        try {
          o = await open();
        } catch {
          state = "failed";
          throw new Error("open failed");
        }
        if (!hasFn(o, "close") || !hasFn(o.db, "execute") || !hasFn(o.db, "transaction")) {
          invalidDb = true;
          state = "failed";
          if (hasFn(o, "close")) await closeQuietly(o);
          throw new Error("invalid database");
        }
        opened = o;
        state = "open";
        if (abandoned) {
          await closeQuietly(o);
          throw new Error("abandoned");
        }
        return o.db as LedgerDatabase;
      })();
      opening.then(undefined, () => undefined); // رد‌شدنِ بی‌شنونده «رسیدگی‌نشده» حساب نشود؛ مصرف‌کنندهٔ واقعی خودش await می‌کند.
    }
    return opening;
  };

  const db: LedgerDatabase = {
    execute: async (query) => (await ensure()).execute(query),
    transaction: async (run, config) => (await ensure()).transaction(run, config),
  };

  async function close(timer: LoopTimer): Promise<boolean> {
    abandoned = true;
    if (state === "idle" || state === "failed") return true;
    if (state === "opening" || opened === null) return false;
    const o = opened;
    const r = await bounded(timer, CLOSE_TIMEOUT_MS, () => o.close());
    return r.kind === "done";
  }

  return Object.freeze({ db, close, invalid: () => invalidDb });
}

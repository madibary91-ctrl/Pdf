/**
 * پایگاهِ تنبل (داخلی): `open()` تزریقی فقط در نخستین استفاده صدا زده می‌شود، تا آرگومانِ بد یا `plan` هرگز اتصالی نسازد.
 * ناورداها: یک‌بار باز می‌شود (هم‌زمانی هم یک وعده)؛ `close` همیشه کران‌دار و نپرتاب؛ اتصالی که پس از رها‌کردنِ اجرا (مهلت) دیر باز شد بی‌درنگ بسته می‌شود؛
 * خروجیِ `open` که `close` ندارد خطای برنامه‌نویسی است (`invalid()`). خطای بازکردن (که ممکن است رشتهٔ اتصال داشته باشد) هرگز خوانده نمی‌شود.
 * `db` برای ماژول ناشفاف است؛ فقط به پورت‌های `query`/`transact` می‌رسد.
 */
import { bounded } from "./deadline";
import type { GrantsTimer, OpenedGrantsDatabase } from "./types";

export const CLOSE_TIMEOUT_MS = 5_000;

type OpenState = "idle" | "opening" | "open" | "failed";

export type LazyDatabase = Readonly<{
  get(): Promise<unknown>;
  /** `true` اگر اتصال بسته شد یا هرگز نبود؛ `false` اگر بسته‌شدن شکست/به مهلت خورد یا بازشدن هنوز در جریان است. */
  close(timer: GrantsTimer): Promise<boolean>;
  invalid(): boolean;
}>;

const hasFn = (o: unknown, k: string): boolean => typeof o === "object" && o !== null && typeof (o as Record<string, unknown>)[k] === "function";

export function createLazyDatabase(open: () => OpenedGrantsDatabase | Promise<OpenedGrantsDatabase>): LazyDatabase {
  let state: OpenState = "idle";
  let opening: Promise<unknown> | null = null;
  let opened: OpenedGrantsDatabase | null = null;
  let abandoned = false;
  let invalidDb = false;

  const closeQuietly = async (o: OpenedGrantsDatabase): Promise<void> => {
    try {
      await o.close();
    } catch {
      // بستنِ ناموفق بی‌خطر است (فرایند را گلو می‌بُرد).
    }
  };

  const get = (): Promise<unknown> => {
    if (opening === null) {
      state = "opening";
      opening = (async () => {
        let o: OpenedGrantsDatabase;
        try {
          o = await open();
        } catch {
          state = "failed";
          throw new Error("open failed");
        }
        if (!hasFn(o, "close")) {
          invalidDb = true;
          state = "failed";
          throw new Error("invalid database");
        }
        opened = o;
        state = "open";
        if (abandoned) {
          await closeQuietly(o);
          throw new Error("abandoned");
        }
        return o.db;
      })();
      opening.then(undefined, () => undefined); // ردشدنِ بی‌شنونده «رسیدگی‌نشده» حساب نشود؛ مصرف‌کنندهٔ واقعی خودش await می‌کند.
    }
    return opening;
  };

  async function close(timer: GrantsTimer): Promise<boolean> {
    abandoned = true;
    if (state === "idle" || state === "failed") return true;
    if (state === "opening" || opened === null) return false;
    const o = opened;
    const r = await bounded(timer, CLOSE_TIMEOUT_MS, () => o.close());
    return r.kind === "done";
  }

  return Object.freeze({ get, close, invalid: () => invalidDb });
}

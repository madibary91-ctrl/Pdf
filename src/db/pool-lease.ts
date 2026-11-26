/**
 * اجارهٔ شمارشیِ استخرِ مشترکِ برنامه (ADR-0076 تصمیم ۶). چند مصرف‌کنندهٔ فرایندی (رفتگرِ تسویه، میزبانِ سیاستِ ابزار) از **یک** استخرِ `@/db` می‌خوانند؛
 * هر کدام پس از خاموشیِ تمیز `close` را صدا می‌زنند و `pool.end()` مستقیم دومین بار «Called end on pool more than once» می‌دهد
 * یا استخر را زیرِ پای مصرف‌کنندهٔ دیگر می‌بندد.
 *  - `close()`: اجاره را پس می‌دهد و **فقط وقتی آخرین اجاره‌دار است** `pool.end()` را (یک بار) صدا می‌زند.
 *  - `release()`: اجاره را پس می‌دهد و **هرگز** استخر را نمی‌بندد (شکستِ بوت؛ وبِ اصلی هنوز از استخر می‌خواند).
 *  - هر اجاره یک بار مصرف می‌شود (اولین فراخوانیِ `close`/`release` برنده است؛ بقیه همان وعده/بی‌اثرند).
 *  - پس از بستنِ استخر اجارهٔ تازه می‌پرتابد (شکست‌بسته، نه استخرِ بسته‌شده را بی‌صدا دادن).
 * خطای `end()` به `close` می‌رسد (میزبان آن را `closed:"failed"` می‌کند).
 */
type Ender = Readonly<{ end: () => unknown }>;
type State = { count: number; ending: boolean };

const states = new WeakMap<object, State>();

export type PoolLease = Readonly<{ close: () => Promise<void>; release: () => void }>;

export function acquirePoolLease(pool: unknown): PoolLease {
  if ((typeof pool !== "object" && typeof pool !== "function") || pool === null || typeof (pool as Partial<Ender>).end !== "function") throw new TypeError("pool");
  const p = pool as Ender;
  let state = states.get(p);
  if (state === undefined) {
    state = { count: 0, ending: false };
    states.set(p, state);
  }
  const st = state;
  if (st.ending) throw new Error("POOL_ENDED");
  st.count += 1;
  let done: Promise<void> | null = null;
  return Object.freeze({
    close: (): Promise<void> => {
      if (done === null) {
        st.count -= 1;
        if (st.count > 0) done = Promise.resolve();
        else {
          st.ending = true;
          done = Promise.resolve().then(() => p.end()).then(() => undefined);
        }
      }
      return done;
    },
    release: (): void => {
      if (done === null) {
        st.count -= 1;
        done = Promise.resolve();
      }
    },
  });
}

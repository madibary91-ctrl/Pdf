/**
 * اجارهٔ شمارشیِ استخر (ADR-0076 تصمیم ۶): `end()` فقط یک بار و فقط توسطِ آخرین اجاره‌دارِ `close`؛ `release` هرگز نمی‌بندد؛ اجارهٔ بعد از بستن شکست‌بسته.
 */
import { describe, expect, it } from "vitest";
import { acquirePoolLease } from "./pool-lease";

const fakePool = () => {
  const s = { ends: 0 };
  return { s, pool: { end: async (): Promise<void> => void (s.ends += 1) } };
};

describe("pool-lease · close", () => {
  it("تک‌اجاره‌دار: close ⇒ end یک بار", async () => {
    const { s, pool } = fakePool();
    const l = acquirePoolLease(pool);
    expect(s.ends).toBe(0);
    await l.close();
    expect(s.ends).toBe(1);
  });

  it("دو اجاره‌دار: فقط آخری می‌بندد (هر ترتیبی)", async () => {
    for (const order of [[0, 1], [1, 0]] as const) {
      const { s, pool } = fakePool();
      const ls = [acquirePoolLease(pool), acquirePoolLease(pool)] as const;
      await ls[order[0]].close();
      expect(s.ends, `first:${order[0]}`).toBe(0);
      await ls[order[1]].close();
      expect(s.ends, `second:${order[1]}`).toBe(1);
    }
  });

  it("close تکراری از یک اجاره بی‌اثر و همان وعده است (شمارنده دوبار کم نمی‌شود)", async () => {
    const { s, pool } = fakePool();
    const a = acquirePoolLease(pool);
    const b = acquirePoolLease(pool);
    const p1 = a.close();
    const p2 = a.close();
    expect(p2).toBe(p1);
    await p1;
    expect(s.ends).toBe(0); // b هنوز نگه داشته است
    await b.close();
    expect(s.ends).toBe(1);
    await b.close();
    expect(s.ends).toBe(1);
  });

  it("خطای end() به close می‌رسد (شکستِ بستن پنهان نمی‌شود) و دوباره صدا زده نمی‌شود", async () => {
    let n = 0;
    const l = acquirePoolLease({ end: () => { n += 1; throw new Error("boom"); } });
    await expect(l.close()).rejects.toThrow("boom");
    await expect(l.close()).rejects.toThrow("boom");
    expect(n).toBe(1);
  });

  it("end() ناهمگامِ ردشونده هم به close می‌رسد", async () => {
    const l = acquirePoolLease({ end: () => Promise.reject(new Error("late")) });
    await expect(l.close()).rejects.toThrow("late");
  });
});

describe("pool-lease · release", () => {
  it("release هرگز استخر را نمی‌بندد، حتی برای آخرین اجاره‌دار", async () => {
    const { s, pool } = fakePool();
    const l = acquirePoolLease(pool);
    l.release();
    await Promise.resolve();
    expect(s.ends).toBe(0);
  });

  it("release و بعد close از همان اجاره: close بی‌اثر است (اجارهٔ یک‌بارمصرف)", async () => {
    const { s, pool } = fakePool();
    const l = acquirePoolLease(pool);
    l.release();
    await l.close();
    expect(s.ends).toBe(0);
  });

  it("close و بعد release بی‌اثر؛ شمارنده خراب نمی‌شود", async () => {
    const { s, pool } = fakePool();
    const l = acquirePoolLease(pool);
    await l.close();
    l.release();
    expect(s.ends).toBe(1);
  });

  it("شکستِ بوتِ یکی (release) و خاموشیِ تمیزِ دیگری (close) ⇒ استخر بسته می‌شود (آخرین نفر close کرد)", async () => {
    const { s, pool } = fakePool();
    const failed = acquirePoolLease(pool);
    const live = acquirePoolLease(pool);
    failed.release();
    expect(s.ends).toBe(0);
    await live.close();
    expect(s.ends).toBe(1);
  });

  it("شکستِ بوتِ تنها اجاره‌دار (release) استخرِ مشترکِ برنامه را نمی‌بندد و اجارهٔ بعدی ممکن می‌ماند", async () => {
    const { s, pool } = fakePool();
    acquirePoolLease(pool).release();
    const next = acquirePoolLease(pool);
    await next.close();
    expect(s.ends).toBe(1);
  });
});

describe("pool-lease · پس از بستن و ورودیِ بد", () => {
  it("اجارهٔ تازه پس از بستنِ استخر می‌پرتابد (نه استخرِ بسته را بی‌صدا دادن)", async () => {
    const { pool } = fakePool();
    await acquirePoolLease(pool).close();
    expect(() => acquirePoolLease(pool)).toThrow("POOL_ENDED");
  });

  it("اجارهٔ تازه هنگامِ بسته‌شدنِ در جریان هم می‌پرتابد", () => {
    const l = acquirePoolLease({ end: () => new Promise(() => undefined) });
    void l.close();
    // pool دیگری نیست؛ همان pool را باید دوباره بگیریم:
    const pool = { end: () => new Promise(() => undefined) };
    const a = acquirePoolLease(pool);
    void a.close();
    expect(() => acquirePoolLease(pool)).toThrow("POOL_ENDED");
  });

  it("استخرهای جدا شمارنده‌ی جدا دارند", async () => {
    const a = fakePool();
    const b = fakePool();
    const la = acquirePoolLease(a.pool);
    const lb = acquirePoolLease(b.pool);
    await la.close();
    expect([a.s.ends, b.s.ends]).toEqual([1, 0]);
    await lb.close();
    expect(b.s.ends).toBe(1);
  });

  it.each([[null], [undefined], [5], ["pool"], [{}], [{ end: 1 }]])("ورودیِ نامعتبر %j ⇒ TypeError", (p) => {
    expect(() => acquirePoolLease(p)).toThrow(TypeError);
  });

  it("اجاره یخ‌زده است", () => {
    expect(Object.isFrozen(acquirePoolLease(fakePool().pool))).toBe(true);
  });
});

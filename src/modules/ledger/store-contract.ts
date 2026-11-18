/**
 * آزمون قرارداد پورت `AccountStore` (ADR-0018 §۹). هر پیاده‌سازی (حافظه‌ای اکنون، PostgreSQL در برش ل۲) باید همین آزمون‌ها را بگذراند.
 * فقط آزمون؛ در محصول import نمی‌شود.
 */
import { afterAll, describe, expect, it } from "vitest";
import { applyCommand } from "./engine";
import type { AccountKey, AccountState, AccountStore, JournalEntry, TransactOutcome } from "./types";
import { parseCommand } from "./validate";

export type StoreHarness = Readonly<{ store: AccountStore; dispose?: () => Promise<void> }>;

const key = (tenantId: string, accountId: string): AccountKey => ({ tenantId, accountId });

function openState(k: AccountKey, unit = "IRR_MICROS"): AccountState {
  const c = parseCommand("open", { ...k, unit });
  if (!c.ok) throw new Error("bad");
  const o = applyCommand(null, c.value, 1);
  if (!o.ok) throw new Error("bad");
  return o.state;
}

function entry(seq: number, tag = "g"): JournalEntry {
  return { seq, atMs: seq, type: "grant", amount: 1, shortfall: 0, reservationId: null, attemptId: null, refId: `${tag}${seq}`, availableAfter: seq, heldAfter: 0 };
}

const commit = <T>(state: AccountState, entries: JournalEntry[], value: T): TransactOutcome<T> => ({ commit: { state, entries }, value });

export function describeStoreContract(label: string, make: () => Promise<StoreHarness>): void {
  describe(`ledger/AccountStore · قرارداد · ${label}`, () => {
    const harnesses: StoreHarness[] = [];
    const fresh = async (): Promise<AccountStore> => {
      const h = await make();
      harnesses.push(h);
      return h.store;
    };
    afterAll(async () => {
      for (const h of harnesses) await h.dispose?.();
    });

    it("حساب ناموجود: read ⇒ null، journal ⇒ تهی", async () => {
      const s = await fresh();
      expect(await s.read(key("t", "a"))).toBeNull();
      expect(await s.journal(key("t", "a"))).toEqual([]);
    });

    it("transact روی حساب ناموجود `null` به fn می‌دهد و commit ماندگار می‌شود (حالت + ژورنال)", async () => {
      const s = await fresh();
      const k = key("t", "a");
      let seen: AccountState | null | undefined;
      const v = await s.transact(k, (cur) => {
        seen = cur;
        return commit({ ...openState(k), seq: 1 }, [entry(1)], "done");
      });
      expect(seen).toBeNull();
      expect(v).toBe("done");
      expect((await s.read(k))?.seq).toBe(1);
      expect(await s.journal(k)).toEqual([entry(1)]);
    });

    it("commit: null چیزی نمی‌نویسد ولی مقدار برمی‌گردد", async () => {
      const s = await fresh();
      const k = key("t", "a");
      expect(await s.transact(k, () => ({ commit: null, value: 42 }))).toBe(42);
      expect(await s.read(k)).toBeNull();
      await s.transact(k, () => commit(openState(k), [], 0));
      await s.transact(k, () => ({ commit: null, value: 0 }));
      expect(await s.journal(k)).toEqual([]);
    });

    it("fn پرتاب کند ⇒ transact رد می‌شود و هیچ‌چیز نوشته نمی‌شود", async () => {
      const s = await fresh();
      const k = key("t", "a");
      await s.transact(k, () => commit(openState(k), [entry(1)], 0));
      await expect(
        s.transact(k, (cur) => {
          if (cur === null) throw new Error("unexpected");
          throw new Error("boom");
        }),
      ).rejects.toThrow();
      expect((await s.read(k))?.seq).toBe(0);
      expect(await s.journal(k)).toEqual([entry(1)]);
    });

    it("ورودی‌های ژورنال به‌ترتیب و فقط‌افزودنی انباشته می‌شوند", async () => {
      const s = await fresh();
      const k = key("t", "a");
      await s.transact(k, () => commit(openState(k), [entry(1), entry(2)], 0));
      await s.transact(k, (cur) => commit({ ...(cur as AccountState), seq: 4 }, [entry(3), entry(4)], 0));
      expect((await s.journal(k)).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    });

    it("کپی‌بودن: تغییر مقدارهای برگشتی/ورودی ماندگار را نمی‌شکند", async () => {
      const s = await fresh();
      const k = key("t", "a");
      const st = openState(k);
      const ent = [entry(1)];
      await s.transact(k, () => commit(st, ent, 0));
      st.available = 999; // بعد از commit
      ent.push(entry(2));
      (ent[0] as { amount: number }).amount = 12345; // خودِ شیءِ ورودیِ ژورنال هم کپی می‌شود
      expect((await s.read(k))?.available).toBe(0);
      expect(await s.journal(k)).toEqual([entry(1)]);
      const r = (await s.read(k)) as AccountState;
      r.available = 5;
      expect((await s.read(k))?.available).toBe(0);
      const j = (await s.journal(k)) as JournalEntry[];
      j.length = 0;
      expect(await s.journal(k)).toHaveLength(1);
      await s.transact(k, (cur) => {
        (cur as AccountState).available = 7; // تغییر بدون commit
        return { commit: null, value: 0 };
      });
      expect((await s.read(k))?.available).toBe(0);
    });

    it("جداسازی: مستأجر/حسابِ دیگر با شناسهٔ یکسان مستقل است", async () => {
      const s = await fresh();
      const a = key("t1", "acct");
      const b = key("t2", "acct");
      const c = key("t1", "acct2");
      await s.transact(a, () => commit({ ...openState(a), available: 1, seq: 1 }, [entry(1, "a")], 0));
      expect(await s.read(b)).toBeNull();
      expect(await s.read(c)).toBeNull();
      expect(await s.journal(b)).toEqual([]);
      await s.transact(b, (cur) => {
        expect(cur).toBeNull();
        return commit({ ...openState(b), available: 2, seq: 1 }, [entry(1, "b")], 0);
      });
      expect((await s.read(a))?.available).toBe(1);
      expect((await s.read(b))?.available).toBe(2);
      expect((await s.journal(a))[0]?.refId).toBe("a1");
      expect((await s.journal(b))[0]?.refId).toBe("b1");
    });

    it("کلیدهایی که اگر ساده الحاق شوند یکی می‌شدند ('a','bc' و 'ab','c') یکی نمی‌شوند", async () => {
      const s = await fresh();
      await s.transact(key("a", "bc"), () => commit({ ...openState(key("a", "bc")), seq: 1 }, [entry(1)], 0));
      expect(await s.read(key("ab", "c"))).toBeNull();
    });

    it("همزمانیِ روی یک حساب سریالی است: ۴۰ transact موازی، هر کدام seq یکتا می‌بیند و هیچ به‌روزرسانی گم نمی‌شود", async () => {
      const s = await fresh();
      const k = key("t", "a");
      await s.transact(k, () => commit(openState(k), [], 0));
      const seen: number[] = [];
      let calls = 0;
      await Promise.all(
        Array.from({ length: 40 }, () =>
          s.transact(k, (cur) => {
            calls += 1;
            const state = cur as AccountState;
            seen.push(state.seq);
            return commit({ ...state, seq: state.seq + 1 }, [entry(state.seq + 1)], 0);
          }),
        ),
      );
      expect(calls).toBe(40); // fn دقیقاً یک بار برای هر transact
      expect(new Set(seen).size).toBe(40);
      expect((await s.read(k))?.seq).toBe(40);
      expect((await s.journal(k)).map((e) => e.seq)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    });

    it("همزمانیِ حساب‌های مختلف مستقل است", async () => {
      const s = await fresh();
      const keys = Array.from({ length: 5 }, (_, i) => key("t", `a${i}`));
      await Promise.all(keys.map((k) => s.transact(k, () => commit({ ...openState(k), seq: 1 }, [entry(1)], 0))));
      for (const k of keys) expect((await s.journal(k)).length).toBe(1);
    });
  });
}

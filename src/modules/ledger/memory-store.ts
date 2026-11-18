/**
 * ledger — ذخیرهٔ حافظه‌ای (ADR-0018 §۹): فقط برای آزمون و توسعه؛ ماندگار نیست.
 * `fn` همگام است و بین خواندن و نوشتن هیچ `await`ای نیست؛ پس در جاوااسکریپت (تک‌نخی) سریال‌بودنِ هر حساب خودبه‌خود برقرار است.
 * حالت و ورودی‌ها هنگام ورود و خروج کپی عمیق می‌شوند تا هیچ ارجاع مشترکی بین فراخواننده و ذخیره نماند.
 */
import type { AccountKey, AccountState, AccountStore, JournalEntry, TransactOutcome } from "./types";

const SEP = "\u0000";
const keyOf = (k: AccountKey): string => `${k.tenantId}${SEP}${k.accountId}`;

export function createMemoryStore(): AccountStore {
  const accounts = new Map<string, AccountState>();
  const journals = new Map<string, JournalEntry[]>();

  return Object.freeze({
    async transact<T>(key: AccountKey, fn: (current: AccountState | null) => TransactOutcome<T>): Promise<T> {
      const k = keyOf(key);
      const cur = accounts.get(k);
      const out = fn(cur === undefined ? null : structuredClone(cur));
      if (out.commit !== null) {
        // همه‌چیز را پیش از نوشتن بساز؛ اگر کپی پرتاب کرد، هیچ‌چیز نوشته نشده است (اتمی).
        const state = structuredClone(out.commit.state);
        const entries = structuredClone([...out.commit.entries]);
        const log = journals.get(k) ?? [];
        accounts.set(k, state);
        journals.set(k, [...log, ...entries]);
      }
      return out.value;
    },
    async read(key: AccountKey): Promise<AccountState | null> {
      const cur = accounts.get(keyOf(key));
      return cur === undefined ? null : structuredClone(cur);
    },
    async journal(key: AccountKey): Promise<readonly JournalEntry[]> {
      return structuredClone(journals.get(keyOf(key)) ?? []);
    },
  });
}

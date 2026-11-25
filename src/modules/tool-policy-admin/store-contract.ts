/**
 * آزمونِ قراردادِ پورتِ `PolicyVersionStore` (ADR-0069). هر پیاده‌سازی (حافظه‌ای اکنون، PostgreSQL در برشِ 2b‑2) باید همین آزمون‌ها را بگذراند.
 * فقط آزمون؛ در محصول import نمی‌شود.
 */
import { afterAll, describe, expect, it } from "vitest";
import { sampleRecord } from "./test-kit";
import type { PolicyVersionStore } from "./types";

export type StoreHarness = Readonly<{ store: PolicyVersionStore; dispose?: () => Promise<void> }>;

export function describePolicyStoreContract(label: string, make: () => Promise<StoreHarness>): void {
  describe(`tool-policy-admin/PolicyVersionStore · قرارداد · ${label}`, () => {
    const opened: StoreHarness[] = [];
    afterAll(async () => {
      for (const h of opened) await h.dispose?.();
    });
    const fresh = async (): Promise<PolicyVersionStore> => {
      const h = await make();
      opened.push(h);
      return h.store;
    };
    const must = async (s: PolicyVersionStore, v: number): Promise<void> => {
      const r = await s.append(sampleRecord(v));
      expect(r.ok, `append v${v}`).toBe(true);
    };

    it("ذخیره‌سازِ خالی: latest و get هر دو null؛ list خالی", async () => {
      const s = await fresh();
      expect(await s.latest()).toEqual({ ok: true, value: null });
      expect(await s.get(1)).toEqual({ ok: true, value: null });
      expect(await s.list({ beforeVersion: null, limit: 10 })).toEqual({ ok: true, value: [] });
    });

    it("نسخهٔ ۱ پذیرفته می‌شود؛ latest/get همان را (با محتوای برابر) می‌دهند", async () => {
      const s = await fresh();
      await must(s, 1);
      const l = await s.latest();
      expect(l.ok && l.value?.version).toBe(1);
      const g = await s.get(1);
      expect(g.ok && g.value).toEqual(sampleRecord(1));
    });

    it("شکاف و تکرار رد می‌شود (CONFLICT) و ذخیره‌ساز تغییر نمی‌کند", async () => {
      const s = await fresh();
      expect(await s.append(sampleRecord(2))).toEqual({ ok: false, error: { code: "CONFLICT" } });
      await must(s, 1);
      expect(await s.append(sampleRecord(1))).toEqual({ ok: false, error: { code: "CONFLICT" } });
      expect(await s.append(sampleRecord(3))).toEqual({ ok: false, error: { code: "CONFLICT" } });
      const l = await s.latest();
      expect(l.ok && l.value?.version).toBe(1);
    });

    it("نسخهٔ موجود هرگز بازنویسی نمی‌شود (محتوای تازه با همان شماره ⇒ CONFLICT و محتوای اول می‌ماند)", async () => {
      const s = await fresh();
      await must(s, 1);
      expect((await s.append(sampleRecord(1, { reason: "دلیل دیگر" }))).ok).toBe(false);
      const g = await s.get(1);
      expect(g.ok && g.value?.reason).toBe(sampleRecord(1).reason);
    });

    it("رکوردِ بدشکل INVALID است و چیزی نمی‌نویسد", async () => {
      const s = await fresh();
      const bad = { ...sampleRecord(1), actor: "x y" } as never;
      expect(await s.append(bad)).toEqual({ ok: false, error: { code: "INVALID" } });
      expect(await s.latest()).toEqual({ ok: true, value: null });
    });

    it("رقابتِ هم‌زمان روی یک نسخه: دقیقاً یکی برنده است", async () => {
      const s = await fresh();
      const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => s.append(sampleRecord(1, { actor: `racer${i}` }))));
      expect(rs.filter((r) => r.ok)).toHaveLength(1);
      expect(rs.filter((r) => !r.ok && r.error.code === "CONFLICT")).toHaveLength(7);
      const l = await s.latest();
      expect(l.ok && l.value?.version).toBe(1);
    });

    it("get: نسخهٔ نامعتبر INVALID؛ نسخهٔ نبوده null", async () => {
      const s = await fresh();
      await must(s, 1);
      for (const bad of [0, -1, 1.5, Number.NaN]) expect(await s.get(bad as number)).toEqual({ ok: false, error: { code: "INVALID" } });
      expect(await s.get(2)).toEqual({ ok: true, value: null });
    });

    it("list: نزولی، limit، beforeVersion انحصاری و صفحه‌بندیِ کامل بی‌تکرار", async () => {
      const s = await fresh();
      for (let v = 1; v <= 7; v++) await must(s, v);
      const versions = async (q: { beforeVersion: number | null; limit: number }): Promise<number[]> => {
        const r = await s.list(q);
        return r.ok ? r.value.map((x) => x.version) : [-1];
      };
      expect(await versions({ beforeVersion: null, limit: 3 })).toEqual([7, 6, 5]);
      expect(await versions({ beforeVersion: 5, limit: 3 })).toEqual([4, 3, 2]);
      expect(await versions({ beforeVersion: 2, limit: 3 })).toEqual([1]);
      expect(await versions({ beforeVersion: 1, limit: 3 })).toEqual([]);
      expect(await versions({ beforeVersion: 99, limit: 2 })).toEqual([7, 6]);
      expect(await versions({ beforeVersion: null, limit: 100 })).toEqual([7, 6, 5, 4, 3, 2, 1]);
    });

    it("list: ورودیِ نامعتبر INVALID", async () => {
      const s = await fresh();
      for (const q of [{ beforeVersion: null, limit: 0 }, { beforeVersion: 0, limit: 1 }, { beforeVersion: null, limit: 1.5 }]) {
        expect(await s.list(q)).toEqual({ ok: false, error: { code: "INVALID" } });
      }
    });

    it("بازگشتی‌ها مستقل از ورودی‌اند: دست‌کاریِ شیءِ ورودیِ append بعد از نوشتن در ذخیره‌ساز اثر ندارد", async () => {
      const s = await fresh();
      const rec = { ...sampleRecord(1), overrides: { timing: { graceMs: 60_000 } } } as never as { overrides: { timing: { graceMs: number } } };
      expect((await s.append(rec as never)).ok).toBe(true);
      rec.overrides.timing.graceMs = 1;
      const g = await s.get(1);
      expect(g.ok && (g.value?.overrides as { timing: { graceMs: number } }).timing.graceMs).toBe(60_000);
    });
  });
}

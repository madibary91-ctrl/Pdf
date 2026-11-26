/**
 * آزمونِ مدل‌محور: ۳۰۰ بذر × ۶۰ گام؛ دنباله‌ای تصادفی از پاسخ‌های منبع (سالم/خطا/بدشکل/پرتاب/عقب‌گرد/هم‌نسخهٔ ناهم‌محتوا) و شکستِ ساخت،
 * در برابرِ داورِ ساده و مستقل. ناورداها: اجارهٔ موفق همیشه همان نسخه/projectionِ ورودیِ همان لحظه است؛ هر نسخه حداکثر یک بار ساخته می‌شود؛
 * نسخهٔ موفق هرگز کاهش نمی‌یابد؛ هیچ مسیری بی‌اعتبارسنجی به موفقیت نمی‌رسد.
 */
import { describe, expect, it } from "vitest";
import { defaultsProjection, newBinding, prng, projectionFor, snapErr, snapOk } from "./test-kit";

const lastBuilding = { v: -1 };

describe("tool-policy-binding · مدل‌محور", () => {
  it("۳۰۰ بذر: پیوند با داورِ مستقل یکی است", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rnd = prng(seed);
      const buildFailVersions = new Set<number>();
      const t = newBinding(snapErr("NOT_LOADED"), {
        fail: () => {
          const v = lastBuilding.v;
          return buildFailVersions.has(v) ? { ok: false } : undefined;
        },
      });
      let highest: number | null = null;
      const content = new Map<number, number>(); // نسخه ← سطحِ آخرین محتوای پذیرفته‌شده
      const built = new Map<number, number>(); // نسخه ← تعدادِ ساخت
      let lastOk = -1;
      for (let step = 0; step < 60; step++) {
        const k = rnd();
        let expected: string;
        let version = 0;
        let level = 0;
        if (k < 0.45) {
          const base = highest ?? 0;
          version = Math.max(0, base + Math.floor(rnd() * 4) - 1);
          const sameVersionWrongContent = version === highest && rnd() < 0.3;
          level = sameVersionWrongContent ? (content.get(version)! + 1) % 4 : content.get(version) ?? (version === 0 ? 0 : Math.floor(rnd() * 4));
          if (version > 0 && !content.has(version) && rnd() < 0.15) buildFailVersions.add(version);
          lastBuilding.v = version;
          t.state.next = snapOk(version, level);
          if (highest !== null && version < highest) expected = "VERSION_REGRESSED";
          else if (version === highest && content.get(version) !== level && version !== 0) expected = "VERSION_CONTENT_MISMATCH";
          else if (buildFailVersions.has(version)) expected = "BUILD_FAILED";
          else expected = "OK";
          if (expected === "OK" || expected === "BUILD_FAILED") {
            if (!content.has(version)) {
              content.set(version, level);
              built.set(version, 1);
            }
            highest = version;
          }
        } else if (k < 0.6) {
          const code = ["NOT_LOADED", "STALE", "CLOCK_INVALID"][Math.floor(rnd() * 3)]!;
          t.state.next = snapErr(code);
          expected = code;
        } else if (k < 0.75) {
          t.state.next = [null, undefined, 3, "x", {}, { ok: true }, () => { throw new Error("boom"); }][Math.floor(rnd() * 7)];
          expected = "SOURCE_INVALID";
        } else {
          const bigFake = Math.floor(rnd() * 1000) + 1000;
          t.state.next = snapOk(bigFake, 1, { projection: { loop: {} } });
          expected = "PROJECTION_INVALID";
        }
        const r = t.binding.acquire();
        const got = r.ok ? "OK" : r.error.reason;
        expect(got, `seed ${seed} step ${step}`).toBe(expected);
        if (r.ok) {
          expect(r.value.version).toBe(version);
          expect(r.value.projection).toEqual(version === 0 ? defaultsProjection() : projectionFor(level));
          expect(r.value.version).toBeGreaterThanOrEqual(lastOk);
          lastOk = r.value.version;
        }
      }
      for (const [v, n] of built) expect(n, `seed ${seed} v${v}`).toBe(1);
      expect(t.calls.length, `seed ${seed}`).toBe(built.size);
      expect(t.binding.status().highestVersion).toBe(highest);
    }
  });
});

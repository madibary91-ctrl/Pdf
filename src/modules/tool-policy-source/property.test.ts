/**
 * آزمونِ مدل‌محور: ۳۰۰ بذر × ۶۰ گام؛ دنباله‌ای تصادفی از «گذشتِ زمان» و «تازه‌سازی با پاسخِ خوب/بد/پرتابی» روی منبعِ واقعی،
 * در برابرِ داورِ ساده و مستقل (چند خط، بی‌اشتراکِ کد با evaluate/source). ناورداها: نسخه هرگز کاهش نمی‌یابد؛ snapshot فقط وقتی باز است که
 * سنِ آخرین تأیید ≤ سقف؛ دادهٔ باز همیشه همان projectionِ نسخهٔ نگه‌داشته‌شده است.
 */
import { describe, expect, it } from "vitest";
import { projectToolPolicy } from "@/modules/tool-policy";
import { adminFail, fakeClock, MAX_STALE, newSource, okCurrent, policyFor, prng } from "./test-kit";

type Model = { v: number; lvl: number; confirmed: number; loaded: number; failures: number } | null;

describe("tool-policy-source · مدل‌محور", () => {
  it("۳۰۰ بذر: منبع با داورِ مستقل یکی است", async () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rnd = prng(seed);
      const clock = fakeClock(10_000 + seed);
      let next: unknown = null;
      const reader = {
        current: (): Promise<never> => {
          const n = next;
          if (n === "THROW") throw new Error("sync");
          if (n === "REJECT") return Promise.reject(new Error("async")) as Promise<never>;
          return Promise.resolve(n) as Promise<never>;
        },
      };
      const { source } = newSource(reader, clock);
      let model: Model = null;
      let failures = 0;
      let lastSeenVersion = -1;
      for (let step = 0; step < 60; step++) {
        const r = rnd();
        if (r < 0.35) {
          clock.advance(Math.floor(rnd() * 40_000));
        } else {
          const kind = rnd();
          const t = clock.nowMs();
          if (kind < 0.55) {
            const heldV = model === null ? 0 : model.v;
            const v = Math.max(0, heldV + Math.floor(rnd() * 5) - 1); // گاهی هم‌نسخه، گاهی جلو، گاهی ۱ عقب
            const wrongLevel = v > 0 && rnd() < 0.15;
            const lvl = v === 0 ? -1 : wrongLevel ? v + 1 : v;
            next = okCurrent(v, lvl < 0 ? 0 : lvl);
            const res = await source.refresh();
            if (model === null || v > model.v) {
              model = { v, lvl, confirmed: t, loaded: t, failures: 0 };
              failures = 0;
              expect(res.ok).toBe(true);
            } else if (v === model.v && lvl === model.lvl) {
              model = { v: model.v, lvl: model.lvl, loaded: model.loaded, failures: 0, confirmed: t };
              failures = 0;
              expect(res.ok).toBe(true);
            } else {
              failures += 1;
              expect(res.ok).toBe(false);
            }
          } else {
            next = [adminFail("STORE_FAILURE"), "THROW", "REJECT", { ok: true }, null, adminFail("STORED_POLICY_INVALID")][Math.floor(rnd() * 6)];
            const res = await source.refresh();
            failures += 1;
            expect(res.ok).toBe(false);
          }
        }
        const now = clock.nowMs();
        const snap = source.snapshot();
        const open = model !== null && now >= model.confirmed && now - model.confirmed <= MAX_STALE;
        expect(snap.ok, `seed ${seed} step ${step}`).toBe(open);
        if (snap.ok && model !== null) {
          expect(snap.value.version).toBe(model.v);
          expect(snap.value.ageMs).toBe(now - model.confirmed);
          expect(snap.value.loadedAtMs).toBe(model.loaded);
          const exp = projectToolPolicy(model.v === 0 ? undefined : policyFor(model.lvl));
          expect(exp.ok).toBe(true);
          if (exp.ok) expect(snap.value.projection).toEqual(exp.value);
          expect(snap.value.version).toBeGreaterThanOrEqual(lastSeenVersion);
          lastSeenVersion = snap.value.version;
        }
        expect(source.health().consecutiveFailures).toBe(failures);
      }
    }
  });
});

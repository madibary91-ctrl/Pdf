import { describe, expect, it } from "vitest";
import type { RunReport } from "@/modules/tool-runner";
import { NOTICES } from "./index";
import { VERIFIED_REVIEW, collector, obs, outcomeOf, runOf } from "./test-kit";

/** تصادفیِ قطعی (mulberry32). مقایسه با یک داور (oracle)ِ مستقل، نه بازنویسیِ خودِ پیاده‌سازی. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("compose · تصادفیِ قطعی با داورِ مستقل", () => {
  it("۶۰۰ بذر: خروجی با داور یکی است و فضای حالت پوشش داده می‌شود", () => {
    const seen = { missing: 0, okAnswered: 0, okStopped: 0, dropped: 0, escalated: 0, allVerified: 0, empty: 0 };
    for (let seed = 1; seed <= 600; seed++) {
      const r = rng(seed);
      const pick = (p: number): boolean => r() < p;
      const n = Math.floor(r() * 6);
      const c = collector(6);
      const runs: RunReport["toolRuns"][number][] = [];
      const exp: { id: string; pending: boolean }[] = [];
      let expectMissing = false;
      let expectDropped = 0;
      let anyPending = false;
      for (let i = 0; i < n; i++) {
        const id = `c${i}`;
        const ok = pick(0.7);
        const tool = pick(0.5) ? "court_fee" : "late_payment";
        const cardVerified = pick(0.6);
        const runPending = pick(0.25);
        const observed = pick(0.85);
        runs.push(runOf(id, tool, ok ? "ok" : "error", runPending));
        if (observed) c.observe(obs(cardVerified ? { callId: id, tool, review: VERIFIED_REVIEW, reviewPending: false } : { callId: id, tool }));
        if (ok) {
          if (!observed) expectMissing = true;
          else {
            const pending = !cardVerified || runPending;
            exp.push({ id, pending });
            anyPending = anyPending || pending || runPending;
          }
          anyPending = anyPending || runPending;
        } else if (observed) expectDropped++;
      }
      const stopped = pick(0.3);
      const outPending = pick(0.2);
      const res = c.compose({ outcome: outcomeOf(stopped ? "stopped" : "answered", outPending), abortedBy: null, toolRuns: runs });
      if (expectMissing) {
        seen.missing++;
        expect(res.ok, `seed ${seed}`).toBe(false);
        expect(!res.ok && res.error.code, `seed ${seed}`).toBe("CARD_MISSING");
        continue;
      }
      expect(res.ok, `seed ${seed}`).toBe(true);
      if (!res.ok) continue;
      const v = res.value;
      expect(v.cards.map((x) => [x.callId, x.reviewPending]), `seed ${seed}`).toEqual(exp.map((e) => [e.id, e.pending]));
      const wantPending = outPending || anyPending;
      expect(v.reviewPending, `seed ${seed}`).toBe(wantPending);
      expect(v.droppedCards, `seed ${seed}`).toBe(expectDropped);
      expect(v.status).toBe(stopped ? "stopped" : "answered");
      expect(v.text === null, `seed ${seed}`).toBe(stopped);
      const wantNotices = [...(wantPending ? [NOTICES.reviewPending] : []), ...(!stopped && exp.length > 0 ? [NOTICES.cardPrecedence] : [])];
      expect(v.notices, `seed ${seed}`).toEqual(wantNotices);
      // ناوردا: «تأییدشده» بودنِ پاسخ ⇒ همهٔ کارت‌ها تأییدشده و هیچ اعلانِ تأییدنشدگی نیست
      if (!v.reviewPending) {
        expect(v.cards.every((x) => !x.reviewPending), `seed ${seed}`).toBe(true);
        expect(v.notices).not.toContain(NOTICES.reviewPending);
      }
      if (stopped) seen.okStopped++; else seen.okAnswered++;
      if (expectDropped > 0) seen.dropped++;
      if (exp.length === 0) seen.empty++;
      if (!wantPending && exp.length > 0) seen.allVerified++;
      if (runs.some((x) => x.status === "ok" && x.reviewPending) && exp.some((e) => e.pending)) seen.escalated++;
    }
    // پوششِ فضای حالت: داور به جاهای مهم رسیده باشد
    expect(seen.missing).toBeGreaterThan(30);
    expect(seen.okAnswered).toBeGreaterThan(100);
    expect(seen.okStopped).toBeGreaterThan(30);
    expect(seen.dropped).toBeGreaterThan(20);
    expect(seen.escalated).toBeGreaterThan(20);
    expect(seen.allVerified).toBeGreaterThan(5);
    expect(seen.empty).toBeGreaterThan(5);
  });
});

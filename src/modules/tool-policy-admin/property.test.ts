/**
 * آزمونِ مدل‌محور: رشته‌های تصادفی از set/rollbackTo/current/history روی مدلِ مرجعِ **مستقل** (فقط `resolveToolPolicy` به‌عنوان داورِ اعتبارِ سیاست)
 * مقایسه می‌شود؛ ناوردها: نسخه‌های بی‌شکاف، پیش‌بینیِ دقیقِ کدِ هر نتیجه، بازپخشِ changes از پیش‌فرض‌ها به سیاستِ نهایی، و سیاستِ ثبت‌شده = resolve(overrides).
 */
import { describe, expect, it } from "vitest";
import { resolveToolPolicy } from "@/modules/tool-policy";
import { stable } from "./canonical";
import { ACTOR, REASON, compat, defaultsPolicy, newAdmin, prng } from "./test-kit";
import type { PolicyVersionRecord } from "./types";

type Cand = Readonly<{ value: unknown; canon: string }>;

/** کانونیِ مستقل (بدون استفاده از canonical.ts): مرتب‌سازیِ دستی و حذفِ بخشِ خالی. */
function independentCanon(o: unknown): string {
  if (typeof o !== "object" || o === null) return "{}";
  const rec = o as Record<string, Record<string, unknown>>;
  const parts: string[] = [];
  for (const s of Object.keys(rec).sort()) {
    const keys = Object.keys(rec[s]!).sort();
    if (keys.length === 0) continue;
    parts.push(`${s}{${keys.map((k) => `${k}=${JSON.stringify(rec[s]![k])}`).join(",")}}`);
  }
  return parts.join(";");
}

function candidate(rnd: () => number): Cand {
  const grace = 30_000 + Math.floor(rnd() * 20) * 10_000;
  const maxCall = Math.floor(grace * 0.4);
  const kind = Math.floor(rnd() * 9);
  let value: unknown;
  if (kind === 0) value = {};
  else if (kind === 1) value = compat(grace, Math.max(1_000, Math.floor(maxCall / 2)));
  else if (kind === 2) value = { loop: { maxSteps: 1 + Math.floor(rnd() * 8) } };
  else if (kind === 3) value = { answer: { maxCards: 1 + Math.floor(rnd() * 5) }, metering: { onUnknownCost: rnd() < 0.5 ? "forfeit" : "release" } };
  else if (kind === 4) value = { timing: { graceMs: grace } }; // معمولاً ناسازگار
  else if (kind === 5) value = { nope: { a: 1 } };
  else if (kind === 6) value = { loop: { maxSteps: 0 } };
  else if (kind === 7) value = { timing: compat(grace, 1_000).timing };
  else value = { model: { timeoutMs: 1_000 + Math.floor(rnd() * 5) * 1_000 } };
  return { value, canon: independentCanon(value) };
}

const leaves = (p: unknown): Map<string, unknown> => {
  const m = new Map<string, unknown>();
  for (const [s, sec] of Object.entries(p as Record<string, Record<string, unknown>>)) for (const [k, v] of Object.entries(sec)) m.set(`${s}.${k}`, v);
  return m;
};

describe("tool-policy-admin · ویژگیِ مدل‌محور", () => {
  it("۳۰۰ بذر × ۳۰ عملیات: کدِ هر نتیجه با مدل می‌خواند و ناوردها برقرارند", async () => {
    let oks = 0;
    const codes = new Set<string>();
    for (let seed = 1; seed <= 300; seed++) {
      const rnd = prng(seed);
      const { admin, clock } = newAdmin();
      const model: string[] = []; // canon هر نسخه؛ اندیس i ⇒ نسخهٔ i+1
      for (let step = 0; step < 30; step++) {
        clock.advance(1 + Math.floor(rnd() * 5));
        const latest = model.length;
        const stale = rnd() < 0.2;
        const expectedVersion = stale ? latest + (rnd() < 0.5 ? 1 : -1) : latest;
        const doRollback = latest > 0 && rnd() < 0.3;
        if (doRollback) {
          const to = 1 + Math.floor(rnd() * latest);
          const r = await admin.rollbackTo({ expectedVersion: Math.max(0, expectedVersion), toVersion: to, actor: ACTOR, reason: REASON });
          const exp = Math.max(0, expectedVersion);
          const targetValid = to <= exp ? true : false;
          let want: string;
          if (!targetValid) want = "INVALID_ARGUMENT";
          else if (exp !== latest) want = "VERSION_CONFLICT";
          else if (model[to - 1] === model[latest - 1]) want = "NO_CHANGE";
          else want = "OK";
          const got = r.ok ? "OK" : r.error.code;
          expect(got, `seed ${seed} step ${step} rollback`).toBe(want);
          codes.add(`rollback:${got}`);
          if (r.ok) {
            model.push(model[to - 1]!);
            oks++;
          }
        } else {
          const c = candidate(rnd);
          const r = await admin.set({ expectedVersion: Math.max(0, expectedVersion), overrides: c.value, actor: ACTOR, reason: REASON });
          const exp = Math.max(0, expectedVersion);
          const valid = resolveToolPolicy(c.value).ok;
          let want: string;
          if (!valid) want = "INVALID_OVERRIDES";
          else if (exp !== latest) want = "VERSION_CONFLICT";
          else if ((latest === 0 ? "" : model[latest - 1]) === c.canon) want = "NO_CHANGE";
          else want = "OK";
          const got = r.ok ? "OK" : r.error.code;
          expect(got, `seed ${seed} step ${step} set`).toBe(want);
          codes.add(`set:${got}`);
          if (r.ok) {
            model.push(c.canon);
            oks++;
          }
        }
        const cur = await admin.current();
        expect(cur.ok, `seed ${seed} current`).toBe(true);
        if (cur.ok) {
          expect(cur.value.version).toBe(model.length);
          expect(independentCanon(cur.value.overrides)).toBe(model.length === 0 ? "" : model[model.length - 1]);
          expect(stable(cur.value.policy)).toBe(stable((resolveToolPolicy(cur.value.overrides) as { value: unknown }).value));
          expect(cur.value.drift).toBe(false);
        }
      }
      // تاریخچهٔ کامل: بی‌شکاف، نزولی، زمانِ ناکاهنده، بازپخشِ changes
      const all: PolicyVersionRecord[] = [];
      let before: number | null = null;
      for (let guard = 0; guard < 50; guard++) {
        const h = await admin.history({ beforeVersion: before, limit: 7 });
        if (!h.ok) throw new Error("history");
        all.push(...h.value.entries);
        if (h.value.nextBefore === null) break;
        before = h.value.nextBefore;
      }
      expect(all.map((e) => e.version)).toEqual(Array.from({ length: model.length }, (_, i) => model.length - i));
      const asc = [...all].reverse();
      let prev: Map<string, unknown> = leaves(defaultsPolicy());
      let prevTime = 0;
      for (const rec of asc) {
        expect(rec.createdAtMs).toBeGreaterThan(prevTime);
        prevTime = rec.createdAtMs;
        expect(independentCanon(rec.overrides)).toBe(model[rec.version - 1]);
        expect(stable(rec.policy)).toBe(stable((resolveToolPolicy(rec.overrides) as { value: unknown }).value));
        const replay = new Map(prev);
        for (const ch of rec.changes) {
          expect(replay.get(ch.path), `${seed}/${rec.version} from`).toBe(ch.from);
          replay.set(ch.path, ch.to);
        }
        expect([...replay.entries()].sort().join("|")).toBe([...leaves(rec.policy).entries()].sort().join("|"));
        prev = leaves(rec.policy);
      }
    }
    // پوششِ فضا: همهٔ نتایجِ مهم دیده شده‌اند (آزمون خودش بی‌اثر نباشد)
    for (const k of ["set:OK", "set:NO_CHANGE", "set:INVALID_OVERRIDES", "set:VERSION_CONFLICT", "rollback:OK", "rollback:NO_CHANGE", "rollback:VERSION_CONFLICT"]) expect(codes.has(k), k).toBe(true);
    expect(oks).toBeGreaterThan(1000);
  });

  it("مدلِ هم‌زمان: ۲۰۰ بذرِ رقابت؛ همیشه دقیقاً یک برنده و نسخهٔ نهایی ۱", async () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rnd = prng(seed);
      const { admin } = newAdmin();
      const n = 2 + Math.floor(rnd() * 6);
      const rs = await Promise.all(Array.from({ length: n }, (_, i) => admin.set({ expectedVersion: 0, overrides: compat(40_000 + i * 10_000, 5_000 + i), actor: `u${i}`, reason: REASON })));
      expect(rs.filter((r) => r.ok), `seed ${seed}`).toHaveLength(1);
      const cur = await admin.current();
      expect(cur.ok && cur.value.version).toBe(1);
    }
  });
});

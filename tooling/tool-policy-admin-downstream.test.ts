import { describe, expect, it } from "vitest";
import { createCardCollector } from "@/modules/calc-answer-cards";
import { createLedger, createMemoryStore } from "@/modules/ledger";
import { createDurableLedger, createMemoryOutbox } from "@/modules/settlement";
import { checkTimingRelations } from "@/modules/tool-call-deadline";
import { resolveToolLoopConfig } from "@/modules/tool-loop";
import { projectToolPolicy, timingFromGrace } from "@/modules/tool-policy";
import { createMemoryPolicyStore, createToolPolicyAdmin } from "@/modules/tool-policy-admin";

/**
 * قرارداد با پایین‌دست‌ها (ADR-0069): هر سیاستی که مدیرِ نسخه‌دار ثبت و برمی‌گرداند را اعتبارسنج‌های **واقعیِ** پایین‌دست می‌پذیرند؛
 * یعنی ادمین نمی‌تواند چیزی ذخیره کند که ریشهٔ I/O (CT‑5c‑2c) بعداً در ساخت رد کند.
 */
const clock = { nowMs: (): number => 1_700_000_000_000 };
function mk() {
  const a = createToolPolicyAdmin({ store: createMemoryPolicyStore(), clock });
  if (!a.ok) throw new Error("admin");
  return a.value;
}
function compat(graceMs: number, modelTimeoutMs: number, extra: Record<string, unknown> = {}) {
  const t = timingFromGrace(graceMs);
  if (!t.ok) throw new Error("grace");
  return { timing: { ...t.value }, model: { timeoutMs: modelTimeoutMs }, ...extra };
}

describe("tool-policy-admin ⇄ اعتبارسنج‌های واقعیِ پایین‌دست", () => {
  it.each([
    [30_000, 10_000],
    [45_000, 17_999],
    [90_000, 30_000],
    [300_000, 100_000],
  ])("graceMs=%i: سیاستِ ثبت‌شده با projectToolPolicy و همهٔ اعتبارسنج‌های پایین‌دست سازگار است", async (grace, modelTimeout) => {
    const admin = mk();
    const set = await admin.set({ expectedVersion: 0, overrides: compat(grace, modelTimeout), actor: "admin:test", reason: "آزمون قرارداد" });
    expect(set.ok).toBe(true);
    const cur = await admin.current();
    expect(cur.ok).toBe(true);
    if (!cur.ok) return;
    const p = projectToolPolicy(cur.value.policy);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(resolveToolLoopConfig({ ...p.value.loop, budget: { kind: "none" } }).ok).toBe(true);
    expect(createCardCollector({ maxCards: p.value.service.maxCards }).ok).toBe(true);
    expect(checkTimingRelations({ maxCallMs: p.value.deadline.maxCallMs, graceMs: p.value.durable.graceMs, reservationTtlMs: p.value.durable.reservationTtlMs })).toEqual([]);
    const made = createLedger({ store: createMemoryStore(), clock });
    if (!made.ok) throw new Error("ledger");
    const dl = createDurableLedger({ ledger: made.value, outbox: createMemoryOutbox(), clock, graceMs: p.value.durable.graceMs, onUnknownCost: p.value.durable.onUnknownCost });
    expect(dl.ok).toBe(true);
  });

  it("onUnknownCost=release هم ثبت و بی‌تغییر به دفترِ ماندگار می‌رسد (تصمیمِ صریحِ ادمین)", async () => {
    const admin = mk();
    expect((await admin.set({ expectedVersion: 0, overrides: { metering: { onUnknownCost: "release" } }, actor: "admin:test", reason: "آزمون" })).ok).toBe(true);
    const cur = await admin.current();
    const p = cur.ok ? projectToolPolicy(cur.value.policy) : null;
    expect(p?.ok && p.value.durable.onUnknownCost).toBe("release");
  });

  it("ناسازگارِ پایین‌دست هرگز ذخیره نمی‌شود: مدیر پیش از ذخیره رد می‌کند و نسخه‌ای نمی‌سازد", async () => {
    const admin = mk();
    const bad = [{ timing: { graceMs: 30_000 } }, { timing: { reservationTtlMs: 90_000 } }, { model: { timeoutMs: 36_000 } }, { run: { totalTimeoutMs: 1_000 } }];
    for (const overrides of bad) expect((await admin.set({ expectedVersion: 0, overrides, actor: "admin:test", reason: "آزمون" })).ok).toBe(false);
    const cur = await admin.current();
    expect(cur.ok && cur.value.version).toBe(0);
  });
});

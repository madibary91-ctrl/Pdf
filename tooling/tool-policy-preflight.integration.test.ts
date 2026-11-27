/**
 * یکپارچگیِ tool-policy-preflight (ADR-0078) با **مدیرِ واقعی + ذخیره‌سازِ حافظه + منبعِ واقعی + پیوندِ واقعی + `createCalcAnswerService` واقعی**.
 * سناریوی اصلی: ادمین نامِ مدلی را که جدولِ مدلِ دروازه نمی‌شناسد انتشار می‌دهد. بدونِ پیش‌بازرسی نسخه ثبت می‌شود و پیوند برای کلِ
 * ترافیک `BUILD_FAILED` می‌شود؛ با پیش‌بازرسی (همان `build`) نسخه اصلاً ثبت نمی‌شود. مقدارها همه ساختگیِ آزمون‌اند.
 */
import { describe, expect, it } from "vitest";
import { createCalcAnswerService, type CalcAnswerService } from "@/modules/calc-answer-service";
import { baseOptions, stepOk, stubGateway } from "@/modules/calc-answer-service/test-kit";
import { createToolLoop } from "@/modules/tool-loop";
import type { PolicyProjection } from "@/modules/tool-policy";
import { createMemoryPolicyStore, createToolPolicyAdmin } from "@/modules/tool-policy-admin";
import { compat } from "@/modules/tool-policy-admin/test-kit";
import { createPolicyBinding } from "@/modules/tool-policy-binding";
import { createPreflightedAdmin } from "@/modules/tool-policy-preflight";
import { createPolicySource } from "@/modules/tool-policy-source";
import { fakeClock as sourceClock, MAX_STALE, REFRESH_TIMEOUT } from "@/modules/tool-policy-source/test-kit";

const KNOWN_MODELS: ReadonlySet<string> = new Set(["calc-answer", "calc-answer-v2"]);
const USER = { messages: [{ role: "user", content: "هزینهٔ دادرسی؟" }] };

function setup() {
  const store = createMemoryPolicyStore();
  const made = createToolPolicyAdmin({ store, clock: { nowMs: () => 1_700_000_000_000 } });
  if (!made.ok) throw new Error("admin");
  const admin = made.value;
  const gate = stubGateway(async () => stepOk({ text: "پاسخ" }));
  /** همان سازندهٔ محیطِ تولید: مدلِ نامعلوم ⇒ ساخته نمی‌شود؛ وگرنه سرویسِ واقعی. */
  const build = (p: PolicyProjection): unknown => {
    if (!KNOWN_MODELS.has(p.service.model)) return { ok: false };
    const loop = createToolLoop({ ...p.loop, budget: { kind: "none" } });
    if (!loop.ok) return { ok: false };
    return createCalcAnswerService({ ...baseOptions(gate.gateway), ...p.service, loop: loop.value });
  };
  const pre = createPreflightedAdmin({ admin, build });
  if (!pre.ok) throw new Error("preflighted");
  const source = createPolicySource({ reader: { current: () => admin.current() as never }, clock: sourceClock(), maxStaleMs: MAX_STALE, refreshTimeoutMs: REFRESH_TIMEOUT });
  if (!source.ok) throw new Error("source");
  const binding = createPolicyBinding<CalcAnswerService>({ source: source.value, build });
  if (!binding.ok) throw new Error("binding");
  return { store, admin, pre: pre.value, source: source.value, binding: binding.value };
}
const input = (expectedVersion: number, overrides: unknown) => ({ expectedVersion, overrides, actor: "admin:alice", reason: "آزمون" });
const UNKNOWN = { ...compat(90_000, 30_000), model: { name: "no-such-model", timeoutMs: 30_000 } };
const KNOWN2 = { ...compat(90_000, 30_000), model: { name: "calc-answer-v2", timeoutMs: 30_000 } };

describe("tool-policy-preflight ⇐ مدیر، منبع، پیوند و سرویسِ واقعی", () => {
  it("بدونِ پیش‌بازرسی: مدیر نسخه را می‌پذیرد و پیوند برای همه BUILD_FAILED می‌شود (علتِ وجودِ ماژول)", async () => {
    const t = setup();
    expect((await t.admin.set(input(0, UNKNOWN))).ok).toBe(true);
    expect((await t.source.refresh()).ok).toBe(true);
    const lease = t.binding.acquire();
    expect(!lease.ok && lease.error.reason).toBe("BUILD_FAILED");
  });

  it("با پیش‌بازرسی: همان انتشار رد می‌شود و هیچ نسخه‌ای ثبت نمی‌شود", async () => {
    const t = setup();
    const r = await t.pre.set(input(0, UNKNOWN));
    expect(!r.ok && r.error.code).toBe("PREFLIGHT_REJECTED");
    expect(!r.ok && "stage" in r.error && r.error.stage).toBe("BUILD_FAILED");
    const latest = await t.store.latest();
    expect(latest.ok && latest.value).toBe(null);
  });

  it("پذیرفتهٔ پیش‌بازرسی ⇒ منبع و پیوند و سرویسِ واقعی هم می‌پذیرند و پاسخ می‌دهند", async () => {
    const t = setup();
    expect((await t.pre.set(input(0, KNOWN2))).ok).toBe(true);
    expect((await t.source.refresh()).ok).toBe(true);
    const lease = t.binding.acquire();
    if (!lease.ok) throw new Error(`expected ok: ${lease.error.reason}`);
    expect(lease.value.version).toBe(1);
    expect(lease.value.projection.service.model).toBe("calc-answer-v2");
    expect((await lease.value.instance.answer(USER)).ok).toBe(true);
  });

  it("rollback: نسخهٔ قدیمی که امروز ساخته نمی‌شود ⇒ رد؛ نسخهٔ ۲ فعال می‌ماند", async () => {
    const t = setup();
    expect((await t.pre.set(input(0, KNOWN2))).ok).toBe(true); // v1: مدلِ v2
    expect((await t.pre.set(input(1, compat(60_000, 20_000)))).ok).toBe(true); // v2: پیش‌فرضِ نام
    // جدولِ مدل عوض می‌شود: v2-model دیگر شناخته نیست (مثلاً ارائه‌دهنده برداشته شده).
    (KNOWN_MODELS as Set<string>).delete("calc-answer-v2");
    try {
      const r = await t.pre.rollbackTo({ expectedVersion: 2, toVersion: 1, actor: "admin:alice", reason: "آزمون" });
      expect(!r.ok && r.error.code).toBe("PREFLIGHT_REJECTED");
      const latest = await t.store.latest();
      expect(latest.ok && latest.value?.version).toBe(2);
    } finally {
      (KNOWN_MODELS as Set<string>).add("calc-answer-v2");
    }
    expect((await t.pre.rollbackTo({ expectedVersion: 2, toVersion: 1, actor: "admin:alice", reason: "آزمون" })).ok).toBe(true);
  });

  it("current/history از مدیرِ پیش‌بازرسی‌شده همان مدیرِ واقعی است", async () => {
    const t = setup();
    await t.pre.set(input(0, KNOWN2));
    expect(await t.pre.current()).toEqual(await t.admin.current());
    expect(await t.pre.history()).toEqual(await t.admin.history());
  });
});

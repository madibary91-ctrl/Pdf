/**
 * یکپارچگیِ tool-policy-binding (ADR-0077) با **منبعِ واقعیِ سیاست** (`createPolicySource`) و **سرویسِ واقعیِ پاسخِ محاسبه**
 * (`createCalcAnswerService`) — فقط خواننده و دروازهٔ مدل ساختگی‌اند. مقدارها همه ساختگیِ آزمون‌اند.
 * این‌جا ثابت می‌شود که «سیاست ← منبع ← پیوند ← سرویس» به‌هم می‌خورد و پینِ درخواست در جریان با تازه‌سازیِ سیاست نمی‌شکند.
 */
import { describe, expect, it } from "vitest";
import { createCalcAnswerService, type CalcAnswerService } from "@/modules/calc-answer-service";
import { baseOptions, stepOk, stubGateway } from "@/modules/calc-answer-service/test-kit";
import { createToolLoop } from "@/modules/tool-loop";
import { createPolicyBinding, type PolicyBinding } from "@/modules/tool-policy-binding";
import { createPolicySource } from "@/modules/tool-policy-source";
import { adminFail, fakeClock, MAX_STALE, okCurrent, REFRESH_TIMEOUT } from "@/modules/tool-policy-source/test-kit";
import type { PolicyProjection } from "@/modules/tool-policy";

const USER = { messages: [{ role: "user", content: "هزینهٔ دادرسی؟" }] };

function setup() {
  const clock = fakeClock();
  const state: { next: unknown } = { next: okCurrent(1) };
  const reader = { current: (): Promise<never> => Promise.resolve(state.next as never) };
  const made = createPolicySource({ reader, clock, maxStaleMs: MAX_STALE, refreshTimeoutMs: REFRESH_TIMEOUT });
  if (!made.ok) throw new Error("source");
  const source = made.value;
  const stub = { models: [] as string[], release: null as null | (() => void) };
  const gate = stubGateway(async (input) => {
    stub.models.push(String((input as { model?: unknown }).model));
    if (stub.models.length === 1 && stub.release === null) await new Promise<void>((r) => (stub.release = r));
    return stepOk({ text: "پاسخ" });
  });
  const built: PolicyProjection[] = [];
  const b = createPolicyBinding<CalcAnswerService>({
    source,
    build: (p) => {
      built.push(p);
      const loop = createToolLoop({ ...p.loop, budget: { kind: "none" } });
      if (!loop.ok) return { ok: false };
      // سرویسِ واقعی از projection؛ نامِ مدل از سیاست می‌آید و برای آزمون با نسخه فرق می‌کند.
      return createCalcAnswerService({ ...baseOptions(gate.gateway), ...p.service, model: `${p.service.model}-v${built.length}`, loop: loop.value });
    },
  });
  if (!b.ok) throw new Error("binding");
  const binding: PolicyBinding<CalcAnswerService> = b.value;
  return { clock, state, source, binding, stub, gate, built };
}

describe("tool-policy-binding ⇐ منبع و سرویسِ واقعی", () => {
  it("پیش از بارگذاری بسته است؛ پس از refresh اجاره می‌دهد و سرویس واقعاً پاسخ می‌دهد", async () => {
    const t = setup();
    const before = t.binding.acquire();
    expect(!before.ok && before.error.reason).toBe("NOT_LOADED");
    expect((await t.source.refresh()).ok).toBe(true);
    const lease = t.binding.acquire();
    if (!lease.ok) throw new Error("expected ok");
    expect(lease.value.version).toBe(1);
    t.stub.release = () => undefined; // بی‌انتظار
    const ans = await lease.value.instance.answer(USER);
    expect(ans.ok).toBe(true);
    expect(t.stub.models[0]).toBe("calc-answer-v1");
  });

  it("پین: درخواستِ در جریان با نسخهٔ ۱ تمام می‌شود حتی وقتی نسخهٔ ۲ فعال شد؛ درخواستِ بعدی با نسخهٔ ۲ می‌رود", async () => {
    const t = setup();
    await t.source.refresh();
    const first = t.binding.acquire();
    if (!first.ok) throw new Error("expected ok");
    const p1 = first.value.instance.answer(USER); // روی دروازه معلق می‌ماند
    await Promise.resolve();
    t.state.next = okCurrent(2);
    expect((await t.source.refresh()).ok).toBe(true);
    const second = t.binding.acquire();
    if (!second.ok) throw new Error("expected ok");
    expect(second.value.version).toBe(2);
    const a2 = await second.value.instance.answer(USER);
    expect(a2.ok).toBe(true);
    t.stub.release?.();
    expect((await p1).ok).toBe(true);
    expect(t.stub.models[0]).toBe("calc-answer-v1");
    expect(t.stub.models[1]).toBe("calc-answer-v2");
    expect(new Set(t.stub.models)).toEqual(new Set(["calc-answer-v1", "calc-answer-v2"]));
    expect(first.value.version).toBe(1);
  });

  it("کهنه‌شدنِ منبع ⇒ STALE و بسته؛ تازه‌سازیِ موفق ⇒ دوباره باز (همان نسخه، بی‌ساختِ دوباره)", async () => {
    const t = setup();
    await t.source.refresh();
    expect(t.binding.acquire().ok).toBe(true);
    t.clock.advance(MAX_STALE + 1);
    const r = t.binding.acquire();
    expect(!r.ok && r.error.reason).toBe("STALE");
    expect((await t.source.refresh()).ok).toBe(true);
    expect(t.binding.acquire().ok).toBe(true);
    expect(t.built).toHaveLength(1);
  });

  it("شکستِ خواندنِ تازه‌سازی نسخهٔ خوب را تا سقفِ سن نگه می‌دارد و پس از آن می‌بندد", async () => {
    const t = setup();
    await t.source.refresh();
    t.state.next = adminFail("STORE_FAILURE");
    expect((await t.source.refresh()).ok).toBe(false);
    expect(t.binding.acquire().ok).toBe(true);
    t.clock.advance(MAX_STALE + 1);
    const r = t.binding.acquire();
    expect(!r.ok && r.error.reason).toBe("STALE");
  });

  it("عقب‌گردِ نسخه در خواننده را خودِ منبع رد می‌کند و پیوند همان نسخهٔ بالاتر را نگه می‌دارد", async () => {
    const t = setup();
    t.state.next = okCurrent(3);
    await t.source.refresh();
    t.state.next = okCurrent(2);
    expect((await t.source.refresh()).ok).toBe(false);
    const r = t.binding.acquire();
    expect(r.ok && r.value.version).toBe(3);
  });

  it("پیش‌فرضِ کد (نسخهٔ ۰) هم از همین مسیر عبور می‌کند و منبعِ ‹defaults› را گزارش می‌دهد", async () => {
    const t = setup();
    t.state.next = okCurrent(0);
    await t.source.refresh();
    const r = t.binding.acquire();
    expect(r.ok && r.value.source).toBe("defaults");
  });
});

/**
 * خروجِ هماهنگِ فرایند (ADR-0076 تصمیم ۷): با دو میزبانِ **واقعی** (تسویه و سیاستِ ابزار) که هر دو روی SIGTERM خاموش می‌شوند؛
 * اولی که تمام شود نباید فرایند را بکُشد و خاموشیِ دومی را نیمه‌کاره بگذارد؛ شکستِ یکی با موفقیتِ دیگری پنهان نمی‌شود.
 */
import { describe, expect, it } from "vitest";
import { createSettlementHost } from "@/modules/settlement-host";
import type { SettlementHost } from "@/modules/settlement-host";
import { createToolPolicyHost } from "@/modules/tool-policy-host";
import type { ToolPolicyHost } from "@/modules/tool-policy-host";
import { createCoordinatedExit } from "./process-exit";

const flush = async (rounds = 12): Promise<void> => {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
};
const timer = { after: () => 0, cancel: () => undefined };

function sharedSignals() {
  const ls: Array<() => void> = [];
  return { on: (_s: string, l: () => void): unknown => void ls.push(l), off: (): unknown => undefined, emit: (): void => ls.slice().forEach((l) => l()) };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

type Close = () => unknown;
function twoHosts(exit: (c: number) => void, closeS: Close = () => undefined, closeP: Close = () => undefined) {
  const sig = sharedSignals();
  let s!: SettlementHost;
  let p!: ToolPolicyHost;
  const coordinated = createCoordinatedExit(exit, () => [s, p].some((h) => h.status().state === "stopping"));
  const sMade = createSettlementHost({
    runtime: { start: async () => ({ started: true as const, atMs: 1 }), stop: async () => ({ clean: true }), health: () => ({ health: { status: "ok" }, httpStatus: 200 }) as never },
    timer, signals: sig, exit: coordinated, closeResources: closeS,
  });
  const pMade = createToolPolicyHost({
    runtime: { start: async () => ({ started: true }), stop: async () => ({ stopped: true, abandonedInFlight: false }), health: () => ({ state: "RUNNING", ready: true, reason: null }) },
    timer, signals: sig, exit: coordinated, closeResources: closeP,
  });
  if (!sMade.ok || !pMade.ok) throw new Error("cfg");
  s = sMade.value;
  p = pMade.value;
  return { s, p, sig };
}

describe("process-exit · دو میزبانِ واقعی روی یک SIGTERM", () => {
  it("هر دو موفق: فقط یک exit و با ۰", async () => {
    const exits: number[] = [];
    const { s, p, sig } = twoHosts((c) => void exits.push(c));
    await s.boot();
    await p.boot();
    sig.emit();
    await flush();
    expect(exits).toEqual([0]);
    expect([s.status().state, p.status().state]).toEqual(["stopped", "stopped"]);
  });

  it("سیاست زودتر تمام شود ولی تسویه هنوز در حالِ بستن: exit نمی‌زند تا تسویه تمام شود", async () => {
    const exits: number[] = [];
    const gate = deferred();
    const { s, p, sig } = twoHosts((c) => void exits.push(c), () => gate.promise);
    await s.boot();
    await p.boot();
    sig.emit();
    await flush();
    expect(p.status().state).toBe("stopped");
    expect(s.status().state).toBe("stopping");
    expect(exits).toEqual([]); // بی‌هماهنگی همین‌جا فرایند را می‌کُشت و تسویه نیمه‌کاره می‌ماند
    gate.resolve();
    await flush();
    expect(exits).toEqual([0]);
  });

  it("تسویه زودتر تمام شود و سیاست دیرتر: باز هم فقط یک exit، پس از پایانِ سیاست", async () => {
    const exits: number[] = [];
    const gate = deferred();
    const { s, p, sig } = twoHosts((c) => void exits.push(c), () => undefined, () => gate.promise);
    await s.boot();
    await p.boot();
    sig.emit();
    await flush();
    expect(exits).toEqual([]);
    gate.resolve();
    await flush();
    expect(exits).toEqual([0]);
    expect(s.status().state).toBe("stopped");
  });

  it("شکستِ بستنِ یکی (۱) با موفقیتِ دیگری (۰) پنهان نمی‌شود — در هر دو ترتیب", async () => {
    for (const failFirst of [true, false]) {
      const exits: number[] = [];
      const gate = deferred();
      const bad: Close = () => { throw new Error("close failed"); };
      const { s, p, sig } = failFirst ? twoHosts((c) => void exits.push(c), () => gate.promise, bad) : twoHosts((c) => void exits.push(c), bad, () => gate.promise);
      await s.boot();
      await p.boot();
      sig.emit();
      await flush();
      gate.resolve();
      await flush();
      expect(exits, `failFirst:${failFirst}`).toEqual([1]);
    }
  });

  it("فقط یک میزبان در فرایند: بی‌انتظار و با همان کد", async () => {
    const exits: number[] = [];
    const sig = sharedSignals();
    const only = createToolPolicyHost({
      runtime: { start: async () => ({ started: true }), stop: async () => ({ stopped: true, abandonedInFlight: false }), health: () => ({ state: "RUNNING", ready: true, reason: null }) },
      timer, signals: sig, exit: createCoordinatedExit((c) => void exits.push(c), () => false),
    });
    if (!only.ok) throw new Error("cfg");
    await only.value.boot();
    sig.emit();
    await flush();
    expect(exits).toEqual([0]);
  });
});

describe("process-exit · createCoordinatedExit", () => {
  it("هم‌تای در حالِ خاموشی ⇒ فقط ثبت؛ بعد آخرین نفر بیشینهٔ کدها را می‌زند", () => {
    const exits: number[] = [];
    let waiting = true;
    const ex = createCoordinatedExit((c) => void exits.push(c), () => waiting);
    ex(1);
    expect(exits).toEqual([]);
    waiting = false;
    ex(0);
    expect(exits).toEqual([1]);
  });

  it("بی‌هم‌تا: همان کد", () => {
    const exits: number[] = [];
    createCoordinatedExit((c) => void exits.push(c), () => false)(0);
    expect(exits).toEqual([0]);
  });

  it.each([[1.5], [NaN], [Infinity], ["0" as unknown as number], [undefined as unknown as number]])("کدِ نامعتبر (%j) ⇒ ۱ (شکست‌بسته)", (code) => {
    const exits: number[] = [];
    createCoordinatedExit((c) => void exits.push(c), () => false)(code);
    expect(exits).toEqual([1]);
  });

  it("پرسشِ هم‌تای خراب (پرتاب) ⇒ منتظرِ همیشگی نمی‌شویم و exit می‌زنیم", () => {
    const exits: number[] = [];
    createCoordinatedExit((c) => void exits.push(c), () => { throw new Error("x"); })(0);
    expect(exits).toEqual([0]);
  });

  it("exit واقعی که می‌پرتابد به میزبان می‌رسد (میزبان خودش می‌گیرد؛ این‌جا فقط بی‌بلعیدن)", () => {
    const ex = createCoordinatedExit(() => { throw new Error("exit failed"); }, () => false);
    expect(() => ex(0)).toThrow("exit failed");
  });
});

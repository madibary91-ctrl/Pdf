/**
 * settlement-host · آداپتورِ process: با process ساختگی (EventEmitter)؛ روی process واقعی فقط بهداشتِ شنونده‌ها
 * (هیچ سیگنالِ واقعی ارسال نمی‌شود و process.exit هرگز صدا زده نمی‌شود).
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createNodeExit, createNodeSignalSource, createSettlementHost } from "./index";
import { flush, fakeRuntime, manualTimer } from "./test-kit";

function fakeProc() {
  const ee = new EventEmitter();
  const exits: unknown[] = [];
  const proc = {
    on: (s: string, l: () => void) => ee.on(s, l),
    off: (s: string, l: () => void) => ee.off(s, l),
    exit: (c?: number) => void exits.push(c),
  };
  return { ee, exits, proc };
}

describe("settlement-host · node-process", () => {
  it("createNodeSignalSource: on/off به process می‌رسند و منجمد است", () => {
    const f = fakeProc();
    const src = createNodeSignalSource(f.proc);
    const l = () => undefined;
    src.on("SIGTERM", l);
    expect(f.ee.listenerCount("SIGTERM")).toBe(1);
    src.on("SIGINT", l);
    expect(f.ee.listenerCount("SIGINT")).toBe(1);
    src.off("SIGTERM", l);
    expect(f.ee.listenerCount("SIGTERM")).toBe(0);
    expect(f.ee.listenerCount("SIGINT")).toBe(1);
    expect(Object.isFrozen(src)).toBe(true);
  });
  it("createNodeExit: کد را عیناً به process.exit می‌دهد و فقط وقتی صدا زده شود", () => {
    const f = fakeProc();
    const exit = createNodeExit(f.proc);
    expect(f.exits).toEqual([]);
    exit(0);
    exit(1);
    exit(143);
    expect(f.exits).toEqual([0, 1, 143]);
  });
  it("سرتاسری با process ساختگی: SIGTERM ⇒ خاموشی ⇒ فراخوانیِ exit با کدِ ۰ و شنونده‌ها برداشته می‌شوند", async () => {
    const f = fakeProc();
    const rt = fakeRuntime();
    const h = createSettlementHost({ runtime: rt, timer: manualTimer(), signals: createNodeSignalSource(f.proc), exit: createNodeExit(f.proc) });
    if (!h.ok) throw new Error("x");
    await h.value.boot();
    expect(f.ee.listenerCount("SIGTERM")).toBe(1);
    expect(f.ee.listenerCount("SIGINT")).toBe(1);
    f.ee.emit("SIGTERM");
    await flush();
    expect(f.exits).toEqual([0]);
    expect(f.ee.listenerCount("SIGTERM")).toBe(0);
    expect(f.ee.listenerCount("SIGINT")).toBe(0);
  });
  it("process واقعی: بوت و خاموشی تعدادِ شنونده‌های SIGTERM/SIGINT را دقیقاً به حالتِ پیش برمی‌گرداند", async () => {
    const before = [process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")];
    const h = createSettlementHost({ runtime: fakeRuntime(), timer: manualTimer(), signals: createNodeSignalSource() });
    if (!h.ok) throw new Error("x");
    await h.value.boot();
    expect([process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")]).toEqual([before[0]! + 1, before[1]! + 1]);
    await h.value.shutdown();
    expect([process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")]).toEqual(before);
  });
  it("پیش‌فرضِ createNodeSignalSource/createNodeExit همان process جهانی است (بی‌فراخوانیِ exit)", () => {
    const before = process.listenerCount("SIGTERM");
    const src = createNodeSignalSource();
    const l = () => undefined;
    src.on("SIGTERM", l);
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    src.off("SIGTERM", l);
    expect(process.listenerCount("SIGTERM")).toBe(before);
    expect(typeof createNodeExit()).toBe("function");
  });
});

/**
 * آداپتورِ `process` ِ Node برای سیگنال و خروج (ADR-0032 تصمیم ۲). تنها فایلی که `process` را می‌شناسد (نگهبانِ منبع این را می‌سنجد).
 * `proc` فقط برای آزمون تزریق می‌شود. `createNodeExit` را فقط مالکِ فرایند به `exit` بدهد؛ میزبان خودش هرگز `process.exit` صدا نمی‌زند.
 */
import type { HostSignal, NodeProcessLike, SignalSource } from "./types";

export function createNodeSignalSource(proc: NodeProcessLike = process): SignalSource {
  return Object.freeze({
    on: (signal: HostSignal, listener: () => void): unknown => proc.on(signal, listener),
    off: (signal: HostSignal, listener: () => void): unknown => proc.off(signal, listener),
  });
}

export function createNodeExit(proc: NodeProcessLike = process): (code: number) => void {
  return (code: number): void => {
    proc.exit(code);
  };
}

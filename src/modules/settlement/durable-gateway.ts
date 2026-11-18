/**
 * کارخانهٔ ترکیب (ADR-0021): دروازهٔ اندازه‌گیرِ metering که روی دفتر تسویهٔ ماندگار نشسته است. یک پیکربندیِ واحد، یک سیاستِ `onUnknownCost`
 * (هم برای metering هم برای رزروِ یتیم) تا دو منبعِ حقیقت نداشته باشیم. metering بی‌تغییر است: دروازه‌اش را با `ledger` دکوراته می‌سازیم.
 */
import { createMeteredGateway, resolveMeteringConfig } from "@/modules/metering";
import type { MeteredGateway } from "@/modules/metering";
import { configError, resolveDurableLedgerConfig } from "./config";
import { buildDurableLedger } from "./durable-ledger";
import type { SettlementResult } from "./types";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * ورودی = `MeteringConfig` + `outbox` + `clock` + `graceMs`. `ledger` همان دفتر خام است (رفتگر را هم با همان بسازید).
 * `reservationTtlMs` باید دست‌کم دو برابر `graceMs` باشد.
 */
export function createDurableMeteredGateway(raw: unknown): SettlementResult<MeteredGateway> {
  try {
    if (!isRecord(raw)) return configError(["پیکربندی باید یک شیء ساده باشد."]);
    const { outbox, clock, graceMs, ...metering } = raw;
    const issues: string[] = [];

    const m = resolveMeteringConfig(metering);
    if (!m.ok) issues.push(...m.error.issues);
    const d = resolveDurableLedgerConfig({ ledger: metering["ledger"], outbox, clock, graceMs, onUnknownCost: metering["onUnknownCost"] });
    if (!d.ok) issues.push(...d.error.issues.filter((i) => !issues.includes(i)));
    if (m.ok && d.ok && m.value.reservationTtlMs < 2 * d.value.graceMs) issues.push("reservationTtlMs باید دست‌کم دو برابر graceMs باشد.");
    if (issues.length > 0 || !m.ok || !d.ok) return configError(issues);

    const created = createMeteredGateway({ ...metering, ledger: buildDurableLedger(d.value) });
    return created.ok ? { ok: true, value: created.value } : configError(created.error.issues);
  } catch {
    return configError(["خواندن پیکربندی ناموفق بود."]);
  }
}

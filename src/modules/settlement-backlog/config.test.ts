/**
 * settlement-backlog · اعتبارسنجی پیکربندی (ADR-0039): همهٔ آستانه‌ها الزامی‌اند؛ مرزها، ترتیب‌ها، کلید ناشناخته، getterِ بدجنس، بی‌نشتِ مقدار.
 */
import { describe, expect, it } from "vitest";
import { createMemoryOutbox } from "@/modules/settlement";
import { SETTLEMENT_BACKLOG_LIMITS, createDeadLetterBacklogMonitor } from "./index";
import { TH, manualClock, manualTimer } from "./test-kit";

const BASE = () => ({ outbox: createMemoryOutbox(), clock: manualClock(), ...TH });
const issuesOf = (raw: unknown): readonly string[] => {
  const r = createDeadLetterBacklogMonitor(raw);
  if (r.ok) throw new Error("باید رد می‌شد");
  expect(r.error.code).toBe("INVALID_CONFIG");
  return r.error.issues;
};

describe("settlement-backlog · پیکربندی", () => {
  it("پیکربندیِ کامل پذیرفته می‌شود و مانیتورِ منجمد با سه متد می‌دهد", () => {
    const r = createDeadLetterBacklogMonitor(BASE());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.value).sort()).toEqual(["check", "evaluate", "sample"]);
    expect(Object.isFrozen(r.value)).toBe(true);
  });

  it("سقف‌ها صریح و هم‌خوان با settlement‌اند", () => {
    expect(SETTLEMENT_BACKLOG_LIMITS).toEqual({ maxSampleLimit: 1000, defaultSampleLimit: 1000, maxAgeMs: 31_536_000_000, defaultTimeoutMs: 5000, maxTimeoutMs: 3_600_000 });
    expect(Object.isFrozen(SETTLEMENT_BACKLOG_LIMITS)).toBe(true);
  });

  it.each([null, undefined, 1, "x", [], () => 1])("غیرشیء %j رد می‌شود", (raw) => {
    expect(issuesOf(raw)).toEqual(["پیکربندی باید یک شیء ساده باشد."]);
  });

  it.each(["degradedCount", "downCount", "degradedAfterMs", "downAfterMs", "sampleMaxAgeMs"])("آستانهٔ الزامیِ %s اگر نباشد رد می‌شود (هیچ پیش‌فرضِ حدسی نیست)", (k) => {
    const raw: Record<string, unknown> = BASE();
    delete raw[k];
    delete raw["sampleLimit"];
    const issues = issuesOf(raw);
    expect(issues.some((i) => i.startsWith(`${k} `))).toBe(true);
  });

  it("outbox و clock الزامی‌اند و باید متدِ لازم را داشته باشند", () => {
    expect(issuesOf({ ...BASE(), outbox: undefined })).toContain("outbox باید listUnacknowledgedDead داشته باشد.");
    expect(issuesOf({ ...BASE(), outbox: { listDead: () => 1 } })).toContain("outbox باید listUnacknowledgedDead داشته باشد.");
    expect(issuesOf({ ...BASE(), clock: undefined })).toContain("clock الزامی است و باید nowMs داشته باشد.");
    expect(issuesOf({ ...BASE(), clock: { now: () => 1 } })).toContain("clock الزامی است و باید nowMs داشته باشد.");
  });

  it("outboxِ فقط‌خواندنی (تنها listUnacknowledgedDead) کافی است؛ تابع هم پذیرفته می‌شود", () => {
    expect(createDeadLetterBacklogMonitor({ ...BASE(), outbox: { listUnacknowledgedDead: async () => ({ ok: true, value: [] }) } }).ok).toBe(true);
    const fn = Object.assign(() => 1, { listUnacknowledgedDead: async () => ({ ok: true, value: [] }) });
    expect(createDeadLetterBacklogMonitor({ ...BASE(), outbox: fn }).ok).toBe(true);
  });

  it.each([0, -1, 1.5, Number.NaN, "3", null, Number.MAX_SAFE_INTEGER + 1])("آستانهٔ شمار نامعتبر %j رد می‌شود", (bad) => {
    expect(issuesOf({ ...BASE(), degradedCount: bad }).some((i) => i.startsWith("degradedCount"))).toBe(true);
    expect(issuesOf({ ...BASE(), downCount: bad }).some((i) => i.startsWith("downCount"))).toBe(true);
  });

  it("degradedCount ≤ downCount ≤ sampleLimit؛ برابری مجاز، وارونگی و فراتر از سقف رد", () => {
    expect(createDeadLetterBacklogMonitor({ ...BASE(), degradedCount: 4, downCount: 4 }).ok).toBe(true);
    expect(createDeadLetterBacklogMonitor({ ...BASE(), downCount: 10 }).ok).toBe(true);
    expect(issuesOf({ ...BASE(), degradedCount: 6, downCount: 5 })).toEqual(["degradedCount نباید از downCount بیشتر باشد."]);
    expect(issuesOf({ ...BASE(), downCount: 11 }).some((i) => i.startsWith("downCount"))).toBe(true);
    expect(issuesOf({ ...BASE(), degradedCount: 11, downCount: 11 }).filter((i) => i.startsWith("degradedCount") || i.startsWith("downCount"))).toHaveLength(2);
  });

  it("sampleLimit: پیش‌فرض ۱۰۰۰؛ ۱…۱۰۰۰ مجاز؛ بیرونش و غیرصحیح رد", () => {
    const { sampleLimit: _drop, ...noLimit } = BASE();
    expect(createDeadLetterBacklogMonitor({ ...noLimit, downCount: 1000 }).ok).toBe(true);
    expect(issuesOf({ ...noLimit, downCount: 1001 }).length).toBeGreaterThan(0);
    expect(createDeadLetterBacklogMonitor({ ...BASE(), sampleLimit: 5 }).ok).toBe(true);
    expect(createDeadLetterBacklogMonitor({ ...BASE(), sampleLimit: 1000 }).ok).toBe(true);
    for (const bad of [0, 1001, 2.5, "10", null]) expect(issuesOf({ ...BASE(), sampleLimit: bad })).toContain("sampleLimit باید صحیح ۱ تا 1000 باشد.");
    // sampleLimit کوچک‌تر از downCount ⇒ رد (بریدنِ فهرست آستانه را پنهان می‌کرد)
    expect(issuesOf({ ...BASE(), sampleLimit: 4 }).some((i) => i.startsWith("downCount"))).toBe(true);
  });

  it("آستانه‌های زمانی: ۱…یک سال؛ degradedAfterMs ≤ downAfterMs؛ برابری مجاز", () => {
    const max = SETTLEMENT_BACKLOG_LIMITS.maxAgeMs;
    expect(createDeadLetterBacklogMonitor({ ...BASE(), degradedAfterMs: 1, downAfterMs: 1, sampleMaxAgeMs: 1 }).ok).toBe(true);
    expect(createDeadLetterBacklogMonitor({ ...BASE(), degradedAfterMs: max, downAfterMs: max, sampleMaxAgeMs: max }).ok).toBe(true);
    for (const bad of [0, -5, max + 1, 1.5, "9", null]) {
      for (const k of ["degradedAfterMs", "downAfterMs", "sampleMaxAgeMs"]) expect(issuesOf({ ...BASE(), [k]: bad }).some((i) => i.startsWith(k))).toBe(true);
    }
    expect(issuesOf({ ...BASE(), degradedAfterMs: 6_000 })).toEqual(["degradedAfterMs نباید از downAfterMs بیشتر باشد."]);
  });

  it("timer: باید after و cancel داشته باشد؛ timeoutMs فقط با timer و ۱…۳٬۶۰۰٬۰۰۰", () => {
    expect(createDeadLetterBacklogMonitor({ ...BASE(), timer: manualTimer() }).ok).toBe(true);
    expect(createDeadLetterBacklogMonitor({ ...BASE(), timer: manualTimer(), timeoutMs: 1 }).ok).toBe(true);
    expect(createDeadLetterBacklogMonitor({ ...BASE(), timer: manualTimer(), timeoutMs: 3_600_000 }).ok).toBe(true);
    expect(issuesOf({ ...BASE(), timer: { after: () => 1 } })).toEqual(["timer باید after و cancel داشته باشد."]);
    expect(issuesOf({ ...BASE(), timer: null })).toEqual(["timer باید after و cancel داشته باشد."]);
    expect(issuesOf({ ...BASE(), timeoutMs: 100 })).toEqual(["timeoutMs بدونِ timer معنا ندارد."]);
    for (const bad of [0, 3_600_001, 1.5, "5", null]) expect(issuesOf({ ...BASE(), timer: manualTimer(), timeoutMs: bad })).toEqual(["timeoutMs باید صحیح ۱ تا 3600000 باشد."]);
  });

  it("کلید ناشناخته (حتی غلطِ املایی) رد می‌شود و مقدارش پژواک نمی‌شود؛ نام کوتاه می‌شود", () => {
    const issues = issuesOf({ ...BASE(), degradedcount: "SECRET-VALUE", ["x".repeat(100)]: 1 });
    expect(issues).toContain('کلید ناشناخته: "degradedcount".');
    expect(issues).toContain(`کلید ناشناخته: "${"x".repeat(40)}".`);
    expect(JSON.stringify(issues)).not.toContain("SECRET-VALUE");
  });

  it("چند مشکل با هم گزارش می‌شود و پیام فقط نامِ فیلد است (بی‌مقدار)", () => {
    const issues = issuesOf({ outbox: 1, clock: 2, degradedCount: "SECRET", downCount: "SECRET", degradedAfterMs: "SECRET", downAfterMs: "SECRET", sampleMaxAgeMs: "SECRET" });
    expect(issues.length).toBeGreaterThanOrEqual(7);
    expect(JSON.stringify(issues)).not.toContain("SECRET");
  });

  it("خطای پیکربندی منجمد است", () => {
    const r = createDeadLetterBacklogMonitor({});
    if (r.ok) throw new Error("باید رد می‌شد");
    expect(Object.isFrozen(r.error)).toBe(true);
    expect(Object.isFrozen(r.error.issues)).toBe(true);
  });

  it("getter/Proxyِ بدجنس نمی‌پرتابد و پیکربندیِ ناخوانا رد می‌شود", () => {
    const evil = new Proxy({}, { ownKeys: () => { throw new Error("boom-secret"); } });
    expect(issuesOf(evil)).toEqual(["پیکربندی قابل‌خواندن نیست."]);
    const getter = { ...BASE() };
    Object.defineProperty(getter, "downCount", { enumerable: true, get() { throw new Error("boom-secret"); } });
    expect(issuesOf(getter)).toEqual(["پیکربندی قابل‌خواندن نیست."]);
  });

  it("هر کلید یک بار خوانده می‌شود (getterِ تغییردهنده نمی‌تواند میانِ اعتبارسنجی و استفاده مقدار عوض کند)", async () => {
    const reads: Record<string, number> = {};
    const base: Record<string, unknown> = BASE();
    const raw: Record<string, unknown> = {};
    for (const k of Object.keys(base)) {
      Object.defineProperty(raw, k, { enumerable: true, get() { reads[k] = (reads[k] ?? 0) + 1; return base[k]; } });
    }
    const m = createDeadLetterBacklogMonitor(raw);
    expect(m.ok).toBe(true);
    for (const k of Object.keys(base)) expect(reads[k], k).toBe(1);
  });

  it("ورودیِ پیکربندی دست‌نخورده می‌ماند", () => {
    const raw = Object.freeze(BASE());
    expect(createDeadLetterBacklogMonitor(raw).ok).toBe(true);
  });
});

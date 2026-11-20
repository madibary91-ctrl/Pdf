/**
 * settlement-backlog-watch · آستانه‌ها از متغیرهای محیط (ADR-0042). تابعِ خالص؛ بی‌پایگاه.
 */
import { describe, expect, it } from "vitest";
import { SETTLEMENT_BACKLOG_WATCH_ENV, createBacklogWatch, parseBacklogWatchEnv } from "./index";
import { FAST, T0, deadEntry, manualClock, must, scriptedOutbox, virtual, world } from "./test-kit";

const E = SETTLEMENT_BACKLOG_WATCH_ENV;
const val = (env: unknown): Record<string, unknown> => {
  const r = parseBacklogWatchEnv(env);
  if (!r.ok) throw new Error(`انتظار موفقیت بود: ${r.error.issues.join("; ")}`);
  return { ...r.value };
};
const bad = (env: unknown): readonly string[] => {
  const r = parseBacklogWatchEnv(env);
  if (r.ok) throw new Error("انتظار شکست بود");
  expect(r.error.code).toBe("INVALID_ENV");
  return r.error.issues;
};

describe("settlement-backlog-watch · env", () => {
  it("نبودنِ همهٔ متغیرها یا رشتهٔ خالی ⇒ هیچ بازنویسی (پیش‌فرضِ امن)", () => {
    expect(val({})).toEqual({});
    expect(val(Object.fromEntries(Object.values(E).map((n) => [n, ""])))).toEqual({});
    expect(val({ PATH: "/bin", SETTLEMENT_HOST: "on", SETTLEMENT_GRACE_MS: "20000" })).toEqual({});
  });

  it("نگاشتِ کامل: هر متغیر به کلیدِ پیکربندیِ خودش، عددها به number", () => {
    expect(
      val({
        [E.intervalMs]: "15000",
        [E.timeoutMs]: "2000",
        [E.degradedCount]: "2",
        [E.downCount]: "20",
        [E.degradedAfterMs]: "1800000",
        [E.downAfterMs]: "43200000",
        [E.sampleMaxAgeMs]: "90000",
        [E.sampleLimit]: "500",
        [E.readyPolicy]: "gate_down",
      }),
    ).toEqual({ intervalMs: 15000, timeoutMs: 2000, degradedCount: 2, downCount: 20, degradedAfterMs: 1800000, downAfterMs: 43200000, sampleMaxAgeMs: 90000, sampleLimit: 500, readyPolicy: "gate_down" });
  });

  it("نام‌ها یکتا و با پیشوندِ SETTLEMENT_BACKLOG_ و کلیدهای آن دقیقاً کلیدهای قابل‌تنظیمِ پیکربندی‌اند", () => {
    const names = Object.values(E);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^SETTLEMENT_BACKLOG_[A-Z_]+$/);
    expect(Object.keys(E).sort()).toEqual(["degradedAfterMs", "degradedCount", "downAfterMs", "downCount", "intervalMs", "readyPolicy", "sampleLimit", "sampleMaxAgeMs", "timeoutMs"]);
    expect(Object.isFrozen(E)).toBe(true);
  });

  it.each(["0", "-1", "1.5", "1e3", "٣", " 5", "5 ", "007", "+5", "0x10", "99999999999999999", "9007199254740993", "NaN", "abc"])("عددِ نامعتبر %j رد می‌شود", (v) => {
    const i = bad({ [E.downCount]: v });
    expect(i.join(" ")).toContain(E.downCount);
  });

  it("حدِّ رقم‌ها: ۱۶ رقمِ ایمن پذیرفته می‌شود (به اعتبارسنجیِ ایمنی در createBacklogWatch می‌رسد)", () => {
    expect(val({ [E.sampleMaxAgeMs]: "1000000000000000" })).toEqual({ sampleMaxAgeMs: 1_000_000_000_000_000 });
    expect(val({ [E.sampleMaxAgeMs]: "1" })).toEqual({ sampleMaxAgeMs: 1 });
  });

  it("مقدارِ غیرِ رشته (عدد، شیء) رد می‌شود", () => {
    expect(bad({ [E.intervalMs]: 5 }).join(" ")).toContain(E.intervalMs);
    expect(bad({ [E.readyPolicy]: {} }).join(" ")).toContain(E.readyPolicy);
  });

  it.each(["GATE_DOWN", "gate", "on", "true", "Report", "1"])("readyPolicyِ نامعتبر %j رد می‌شود", (v) => {
    expect(bad({ [E.readyPolicy]: v }).join(" ")).toContain(E.readyPolicy);
  });

  it("متغیرِ ناشناختهٔ SETTLEMENT_BACKLOG_* خطاست (غلط‌یابِ نام)؛ نامِ نزدیک هم", () => {
    expect(bad({ SETTLEMENT_BACKLOG_DOWN_COUNTS: "5" }).join(" ")).toContain("SETTLEMENT_BACKLOG_DOWN_COUNTS");
    expect(bad({ SETTLEMENT_BACKLOG_: "1" }).length).toBe(1);
  });

  it("پیام‌ها فقط نامِ متغیرند: مقدارِ اشتباه (حتی رمز) هرگز نمی‌آید", () => {
    const text = JSON.stringify(bad({ [E.downCount]: "postgres://u:SECRET@127.0.0.1/db", [E.readyPolicy]: "sk-ABCDEFGHIJKLMN", SETTLEMENT_BACKLOG_TYPO: "SECRET-V" }));
    for (const s of ["SECRET", "postgres", "sk-ABC"]) expect(text).not.toContain(s);
  });

  it("ورودیِ غیرِ شیء و getterِ پرتاب‌کننده خطای بسته است (نمی‌پرتابد)", () => {
    for (const x of [null, undefined, 5, "x", []]) expect(bad(x).length).toBeGreaterThan(0);
    const evil: Record<string, unknown> = {};
    Object.defineProperty(evil, E.downCount, {
      enumerable: true,
      get() {
        throw new Error("SECRET-GETTER");
      },
    });
    const r = parseBacklogWatchEnv(evil);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("SECRET");
  });

  it("خروجی و خطا منجمدند", () => {
    const ok = parseBacklogWatchEnv({ [E.downCount]: "5" });
    if (!ok.ok) throw new Error("x");
    expect(Object.isFrozen(ok.value)).toBe(true);
    const err = parseBacklogWatchEnv({ [E.downCount]: "x" });
    if (err.ok) throw new Error("x");
    expect(Object.isFrozen(err.error)).toBe(true);
    expect(Object.isFrozen(err.error.issues)).toBe(true);
  });
});

describe("settlement-backlog-watch · env ← پیکربندی ← رفتار (سرتاسری)", () => {
  it("بازنویسیِ env واقعاً آستانه و سیاست را عوض می‌کند", async () => {
    const o = val({ [E.degradedCount]: "5", [E.downCount]: "8", [E.readyPolicy]: "gate_down" });
    const { outbox, state } = scriptedOutbox();
    const w = world(o, outbox);
    state.list = Array.from({ length: 4 }, (_, i) => deadEntry(i + 1));
    w.watch.start();
    await w.settle();
    expect(w.watch.view()).toMatchObject({ status: "ok", readyPolicy: "gate_down" });
    state.list = Array.from({ length: 8 }, (_, i) => deadEntry(i + 1));
    await w.advance(FAST.intervalMs);
    expect(w.watch.view()).toMatchObject({ status: "down", count: 8 });
  });

  it("مقدارهای ناسازگارِ env (مثلاً downCount بزرگ‌تر از sampleLimit) را createBacklogWatch رد می‌کند، نه parse", () => {
    const o = val({ [E.downCount]: "600", [E.sampleLimit]: "100" });
    const r = createBacklogWatch({ outbox: scriptedOutbox().outbox, clock: manualClock(T0), timer: virtual().timer, ...o });
    expect(r.ok).toBe(false);
    must(createBacklogWatch({ outbox: scriptedOutbox().outbox, clock: manualClock(T0), timer: virtual().timer }));
  });
});

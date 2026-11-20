/**
 * settlement-bootstrap · env · پایشِ پسماندِ زنگ (ADR-0043، م۳‑ه‑۴‑الف‑۲‑۲): کلیدِ صریحِ `SETTLEMENT_BACKLOG_WATCH`، شکست‌بسته، بی‌نشتِ مقدار.
 * فایلِ تازه است؛ هیچ آزمونِ موجودِ env دست نخورده (در حالتِ خاموش خروجی بایت‌به‌بایت مثلِ قبل است).
 */
import { describe, expect, it } from "vitest";
import { SETTLEMENT_BACKLOG_WATCH_ENV } from "@/modules/settlement-backlog-watch";
import { parseBootstrapEnv } from "./env";
import { CANARY, ON_ENV, SECRET_URL } from "./test-kit";

const ok = (raw: unknown) => {
  const r = parseBootstrapEnv(raw);
  if (!r.ok) throw new Error(`انتظار موفقیت بود: ${r.issues.join(" | ")}`);
  return r.value;
};
const bad = (raw: unknown): readonly string[] => {
  const r = parseBootstrapEnv(raw);
  if (r.ok) throw new Error("انتظار شکست بود");
  return r.issues;
};
const SW = "SETTLEMENT_BACKLOG_WATCH";
const E = SETTLEMENT_BACKLOG_WATCH_ENV;

describe("settlement-bootstrap · env · کلیدِ پایشِ پسماند", () => {
  it.each([[{}], [{ [SW]: undefined }], [{ [SW]: "" }], [{ [SW]: "off" }]])("پیش‌فرضِ خاموش: کلیدِ backlog اصلاً نیست (%j)", (extra) => {
    const v = ok({ ...ON_ENV, ...extra });
    expect(v).toEqual({ enabled: true, graceMs: 300000, shutdownTimeoutMs: null, bootAttempts: null, bootRetryDelayMs: null, ledgerSchema: null, settlementSchema: null });
    expect(Object.keys(v)).not.toContain("backlog");
  });

  it("on ⇒ backlog با overrideهای خالی (پیش‌فرض‌های امنِ خودِ ماژولِ watch)", () => {
    const v = ok({ ...ON_ENV, [SW]: "on" });
    expect(v).toMatchObject({ enabled: true, backlog: { overrides: {} } });
  });

  it("on ⇒ همهٔ نُه آستانه با نامِ رسمیِ ماژولِ watch خوانده و منجمد می‌شوند", () => {
    const v = ok({
      ...ON_ENV,
      [SW]: "on",
      [E.intervalMs]: "1000",
      [E.timeoutMs]: "200",
      [E.degradedCount]: "2",
      [E.downCount]: "5",
      [E.degradedAfterMs]: "60000",
      [E.downAfterMs]: "120000",
      [E.sampleMaxAgeMs]: "5000",
      [E.sampleLimit]: "50",
      [E.readyPolicy]: "gate_down",
    });
    if (!v.enabled || v.backlog === undefined) throw new Error("backlog نیست");
    expect(v.backlog.overrides).toEqual({ intervalMs: 1000, timeoutMs: 200, degradedCount: 2, downCount: 5, degradedAfterMs: 60000, downAfterMs: 120000, sampleMaxAgeMs: 5000, sampleLimit: 50, readyPolicy: "gate_down" });
    expect(Object.isFrozen(v)).toBe(true);
    expect(Object.isFrozen(v.backlog)).toBe(true);
    expect(Object.isFrozen(v.backlog.overrides)).toBe(true);
  });

  it.each(["ON", "On", "true", "1", "yes", " on", "on ", "0", "false", "OFF", "off ", "enabled"])("هر مقدارِ جز on/off رد می‌شود، نه حدس: %j", (v) => {
    expect(bad({ ...ON_ENV, [SW]: v })).toEqual([`${SW} باید on یا off باشد.`]);
  });

  it("مقدارِ غیررشته‌ای (عدد، true، شیء، null) رد می‌شود", () => {
    for (const v of [1, true, {}, [], null]) expect(bad({ ...ON_ENV, [SW]: v })).toEqual([`${SW} باید on یا off باشد.`]);
  });

  it("خاصیتی (۲۰۰۰ مقدارِ تصادفی): فقط دقیقاً on روشن می‌کند و فقط on/off/خالی پذیرفته می‌شود", () => {
    let seed = 20261120;
    const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff);
    const alphabet = "onfONF1 \t\n-_xé";
    for (let i = 0; i < 2000; i++) {
      let v = "";
      for (let n = next() % 5; n > 0; n--) v += alphabet[next() % alphabet.length];
      const r = parseBootstrapEnv({ ...ON_ENV, [SW]: v });
      if (v === "on") expect(r).toMatchObject({ ok: true, value: { backlog: { overrides: {} } } });
      else if (v === "" || v === "off") expect(r.ok && "backlog" in r.value).toBe(false);
      else expect(r.ok, JSON.stringify(v)).toBe(false);
    }
  });
});

describe("settlement-bootstrap · env · آستانه‌ها (شکست‌بسته)", () => {
  it("آستانهٔ تنظیم‌شده با کلیدِ خاموش/نبودن خطاست (اپراتور فکر می‌کند gate_down فعال است)", () => {
    for (const extra of [{}, { [SW]: "off" }, { [SW]: "" }]) {
      expect(bad({ ...ON_ENV, ...extra, [E.readyPolicy]: "gate_down" })).toEqual([`${E.readyPolicy} تنظیم شده ولی ${SW} روشن (on) نیست.`]);
    }
  });

  it("آستانهٔ خالص‌خالی (رشتهٔ خالی/undefined) با کلیدِ خاموش خطا نیست", () => {
    expect(ok({ ...ON_ENV, [E.downCount]: "", [E.readyPolicy]: undefined })).toMatchObject({ enabled: true });
  });

  it("همهٔ نُه نام با کلیدِ خاموش جدا جدا خطا می‌دهند و هر کدام فقط نامِ خودش را", () => {
    for (const name of Object.values(E)) expect(bad({ ...ON_ENV, [name]: "5" }), name).toEqual([`${name} تنظیم شده ولی ${SW} روشن (on) نیست.`]);
  });

  it("مقدارِ نامعتبرِ عددی/سیاست با کلیدِ روشن رد می‌شود و مقدار در پیام نمی‌آید", () => {
    for (const v of ["0", "-1", "1.5", "1e3", "۱۲", "٣", " 5", "5 ", "+5", "x", SECRET_URL]) {
      const issues = bad({ ...ON_ENV, [SW]: "on", [E.downCount]: v });
      expect(issues).toEqual([`${E.downCount} باید عددِ صحیحِ مثبت (رقمِ لاتینی) باشد.`]);
      expect(JSON.stringify(issues)).not.toContain(CANARY);
    }
    expect(bad({ ...ON_ENV, [SW]: "on", [E.readyPolicy]: "block" })).toEqual([`${E.readyPolicy} باید report یا gate_down باشد.`]);
    expect(bad({ ...ON_ENV, [SW]: "on", [E.readyPolicy]: "GATE_DOWN" })).toHaveLength(1);
  });

  it("چند اشکال با هم گزارش می‌شوند (کلیدِ نامعتبر + آستانهٔ نامعتبر + graceِ نبود)", () => {
    const issues = bad({ SETTLEMENT_HOST: "on", [SW]: "maybe", [E.downCount]: "0" });
    expect(issues).toContain(`${SW} باید on یا off باشد.`);
    expect(issues).toContain("SETTLEMENT_GRACE_MS الزامی است.");
    expect(issues).toHaveLength(2); // آستانه با کلیدِ نامعتبر بررسی نمی‌شود (روشن/خاموش نامعلوم)
  });

  it("غلطِ تایپی در نامِ آستانه همچنان خطای «ناشناخته» است و فقط یک بار گزارش می‌شود", () => {
    for (const on of [true, false]) {
      const issues = bad({ ...ON_ENV, ...(on ? { [SW]: "on" } : {}), SETTLEMENT_BACKLOG_DOWN_COUNTS: "5" });
      expect(issues).toEqual(['متغیرِ ناشناختهٔ "SETTLEMENT_BACKLOG_DOWN_COUNTS" (پیشوندِ SETTLEMENT_ رزرو است).']);
    }
  });

  it("خاموشیِ میزبان همهٔ این‌ها را نادیده می‌گیرد (مثلِ بقیهٔ محیط)", () => {
    expect(ok({ SETTLEMENT_HOST: "off", [SW]: "maybe", [E.downCount]: "x", SETTLEMENT_BACKLOG_TYPO: "1" })).toEqual({ enabled: false });
    expect(ok({ [SW]: "on" })).toEqual({ enabled: false });
  });

  it("ترتیب/دامنهٔ آستانه‌ها اینجا سنجیده نمی‌شود (بر عهدهٔ createBacklogWatch)", () => {
    expect(ok({ ...ON_ENV, [SW]: "on", [E.degradedCount]: "9", [E.downCount]: "2" })).toMatchObject({ backlog: { overrides: { degradedCount: 9, downCount: 2 } } });
  });

  it("envِ پرتاب‌کننده (Proxy) ⇒ شکست و بی‌پرتاب، بی‌نشت", () => {
    const hostile = new Proxy({ SETTLEMENT_HOST: "on" }, { get: (t, k) => (k === SW ? (() => { throw new Error(CANARY); })() : Reflect.get(t, k)) });
    const r = parseBootstrapEnv(hostile);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(CANARY);
  });
});

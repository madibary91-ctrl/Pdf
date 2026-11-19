/**
 * settlement-bootstrap · سیاستِ env (ADR-0033 تصمیم ۲): شکست‌بسته، بی‌پیش‌فرضِ حدسی، بی‌نشتِ مقدار.
 */
import { describe, expect, it } from "vitest";
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

describe("settlement-bootstrap · env · روشن/خاموش", () => {
  it.each([[{}], [{ SETTLEMENT_HOST: undefined }], [{ SETTLEMENT_HOST: "" }], [{ SETTLEMENT_HOST: "off" }]])("نبودن/خالی/off ⇒ خاموش (%j)", (env) => {
    expect(ok(env)).toEqual({ enabled: false });
  });

  it("خاموش بودن بقیهٔ محیط را نادیده می‌گیرد (حتی ناشناخته و نامعتبر)", () => {
    expect(ok({ SETTLEMENT_HOST: "off", SETTLEMENT_GRACE_MS: "abc", SETTLEMENT_TYPO: "x" })).toEqual({ enabled: false });
    expect(ok({ SETTLEMENT_GRACE_MS: "-1" })).toEqual({ enabled: false });
  });

  it.each(["ON", "On", "true", "1", "yes", "enabled", " on", "on ", "on\n", "0", "false", "OFF", "Off", "off "])("هر مقدارِ جز on/off رد می‌شود، نه حدس: %j", (v) => {
    expect(bad({ SETTLEMENT_HOST: v, SETTLEMENT_GRACE_MS: "1000" })).toEqual(["SETTLEMENT_HOST باید on یا off باشد."]);
  });

  it("مقدارِ غیررشته‌ای (عدد، true، شیء) رد می‌شود", () => {
    for (const v of [1, true, {}, [], null]) expect(bad({ SETTLEMENT_HOST: v })).toEqual(["SETTLEMENT_HOST باید on یا off باشد."]);
  });

  it("خاصیتی (۲۰۰۰ مقدارِ تصادفی): فقط دقیقاً on روشن می‌کند", () => {
    let seed = 20261119;
    const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff);
    const alphabet = "onfONF1 \t\n-_xé";
    for (let i = 0; i < 2000; i++) {
      let v = "";
      for (let n = next() % 5; n > 0; n--) v += alphabet[next() % alphabet.length];
      const r = parseBootstrapEnv({ SETTLEMENT_HOST: v, SETTLEMENT_GRACE_MS: "1000" });
      if (v === "on") expect(r).toMatchObject({ ok: true, value: { enabled: true } });
      else if (v === "" || v === "off") expect(r).toEqual({ ok: true, value: { enabled: false } });
      else expect(r.ok, JSON.stringify(v)).toBe(false);
    }
  });
});

describe("settlement-bootstrap · env · مقدارهای on", () => {
  it("حداقلِ معتبر: فقط graceMs؛ بقیه null (پیش‌فرض‌ها را پایین‌دست می‌گذارد)", () => {
    expect(ok(ON_ENV)).toEqual({ enabled: true, graceMs: 300000, shutdownTimeoutMs: null, bootAttempts: null, bootRetryDelayMs: null, ledgerSchema: null, settlementSchema: null });
  });

  it("همهٔ متغیرها خوانده می‌شوند", () => {
    expect(
      ok({ ...ON_ENV, SETTLEMENT_SHUTDOWN_TIMEOUT_MS: "20000", SETTLEMENT_BOOT_ATTEMPTS: "5", SETTLEMENT_BOOT_RETRY_DELAY_MS: "2000", SETTLEMENT_LEDGER_SCHEMA: "led", SETTLEMENT_OUTBOX_SCHEMA: "out" }),
    ).toEqual({ enabled: true, graceMs: 300000, shutdownTimeoutMs: 20000, bootAttempts: 5, bootRetryDelayMs: 2000, ledgerSchema: "led", settlementSchema: "out" });
  });

  it("graceMs الزامی است و پیش‌فرضِ حدسی ندارد", () => {
    expect(bad({ SETTLEMENT_HOST: "on" })).toEqual(["SETTLEMENT_GRACE_MS الزامی است."]);
    expect(bad({ SETTLEMENT_HOST: "on", SETTLEMENT_GRACE_MS: "" })).toEqual(["SETTLEMENT_GRACE_MS الزامی است."]);
  });

  it.each(["0", "00", "007", "-5", "+5", "1.5", "1e3", "0x10", " 5", "5 ", "۵۰۰", "５００", "12345678901", "NaN", "Infinity", "1_000", "1,000"])("عددِ نامعتبر رد می‌شود: %j", (v) => {
    expect(bad({ ...ON_ENV, SETTLEMENT_GRACE_MS: v })).toEqual(["SETTLEMENT_GRACE_MS باید عددِ صحیحِ مثبتِ لاتین باشد."]);
    expect(bad({ ...ON_ENV, SETTLEMENT_BOOT_ATTEMPTS: v })).toEqual(["SETTLEMENT_BOOT_ATTEMPTS باید عددِ صحیحِ مثبتِ لاتین باشد."]);
  });

  it("عددِ غیررشته‌ای رد می‌شود (محیط فقط رشته است)", () => {
    expect(bad({ SETTLEMENT_HOST: "on", SETTLEMENT_GRACE_MS: 1000 })).toEqual(["SETTLEMENT_GRACE_MS باید عددِ صحیحِ مثبتِ لاتین باشد."]);
  });

  it("بزرگ‌ترین عددِ ده‌رقمی پذیرفته می‌شود (بازه را پایین‌دست می‌سنجد)", () => {
    expect(ok({ ...ON_ENV, SETTLEMENT_GRACE_MS: "9999999999" })).toMatchObject({ graceMs: 9999999999 });
  });

  it("همهٔ مشکل‌ها یک‌جا گزارش می‌شوند", () => {
    const issues = bad({ SETTLEMENT_HOST: "on", SETTLEMENT_SHUTDOWN_TIMEOUT_MS: "x", SETTLEMENT_BOOT_ATTEMPTS: "0", SETTLEMENT_BOOT_RETRY_DELAY_MS: "-1" });
    expect(issues).toEqual([
      "SETTLEMENT_GRACE_MS الزامی است.",
      "SETTLEMENT_SHUTDOWN_TIMEOUT_MS باید عددِ صحیحِ مثبتِ لاتین باشد.",
      "SETTLEMENT_BOOT_ATTEMPTS باید عددِ صحیحِ مثبتِ لاتین باشد.",
      "SETTLEMENT_BOOT_RETRY_DELAY_MS باید عددِ صحیحِ مثبتِ لاتین باشد.",
    ]);
  });

  it("رشتهٔ شِما غیررشته‌ای رد می‌شود؛ خالص ⇒ نبودن", () => {
    expect(bad({ ...ON_ENV, SETTLEMENT_LEDGER_SCHEMA: 5 })).toEqual(["SETTLEMENT_LEDGER_SCHEMA باید رشته باشد."]);
    expect(ok({ ...ON_ENV, SETTLEMENT_LEDGER_SCHEMA: "" })).toMatchObject({ ledgerSchema: null });
  });
});

describe("settlement-bootstrap · env · غلط‌یابِ نام", () => {
  it("کلیدِ ناشناختهٔ SETTLEMENT_* با on خطاست (تایپ نباید پیش‌فرضِ خطرناک بگذارد)", () => {
    expect(bad({ ...ON_ENV, SETTLEMENT_GRAC_MS: "1" })).toEqual(['متغیرِ ناشناختهٔ "SETTLEMENT_GRAC_MS" (پیشوندِ SETTLEMENT_ رزرو است).']);
  });

  it("کلیدهای بی‌پیشوند و حروفِ کوچک (settlement_host) بی‌اثرند و خطا نیستند", () => {
    expect(ok({ ...ON_ENV, settlement_foo: "1", OTHER: "x", NODE_ENV: "production" })).toMatchObject({ enabled: true });
    expect(ok({ settlement_host: "on" })).toEqual({ enabled: false });
  });

  it("نامِ کلیدِ ناشناخته کوتاه و فقط با نویسه‌های قابل‌چاپ در پیام می‌آید", () => {
    const issues = bad({ ...ON_ENV, [`SETTLEMENT_\u0007${"X".repeat(200)}`]: "1" });
    expect(issues).toHaveLength(1);
    expect(issues[0]).not.toContain("\u0007");
    expect((issues[0] as string).length).toBeLessThan(120);
  });
});

describe("settlement-bootstrap · env · بی‌نشت و بی‌پرتاب", () => {
  it("مقدارِ هیچ متغیری (حتی رشتهٔ اتصال در جای اشتباه) در مشکل‌ها نمی‌آید", () => {
    const secret = SECRET_URL;
    for (const env of [
      { SETTLEMENT_HOST: secret },
      { ...ON_ENV, SETTLEMENT_GRACE_MS: secret },
      { ...ON_ENV, SETTLEMENT_SHUTDOWN_TIMEOUT_MS: secret },
      { ...ON_ENV, SETTLEMENT_BOOT_ATTEMPTS: secret },
      { ...ON_ENV, SETTLEMENT_BOOT_RETRY_DELAY_MS: secret },
      { ...ON_ENV, SETTLEMENT_LEDGER_SCHEMA: 7, SETTLEMENT_OUTBOX_SCHEMA: { secret } },
    ]) expect(JSON.stringify(bad(env))).not.toContain(CANARY);
  });

  it.each([[null], [undefined], [5], ["x"], [[]], [() => 1]])("env غیرِ شیء ⇒ شکست (%s)", (raw) => {
    expect(bad(raw)).toEqual(["env باید یک شیء ساده باشد."]);
  });

  it("getter پرتاب‌کننده ⇒ شکستِ بسته نه پرتاب", () => {
    const hostile = new Proxy({}, { get() { throw new Error(CANARY); }, ownKeys() { throw new Error(CANARY); } });
    expect(bad(hostile)).toEqual(["خواندنِ env ناموفق بود."]);
  });

  it("هر کلید فقط یک بار خوانده می‌شود (getterِ دو‌چهره فریب نمی‌دهد)", () => {
    let reads = 0;
    const env = { SETTLEMENT_HOST: "on", get SETTLEMENT_GRACE_MS() { return reads++ === 0 ? "1000" : "abc"; } };
    expect(ok(env)).toMatchObject({ graceMs: 1000 });
    expect(reads).toBe(1);
  });

  it("نتیجه فریز است و ورودی دست نمی‌خورد", () => {
    const env = Object.freeze({ ...ON_ENV });
    const v = ok(env);
    expect(Object.isFrozen(v)).toBe(true);
    expect(env).toEqual(ON_ENV);
    expect(Object.isFrozen(ok({}))).toBe(true);
    expect(Object.isFrozen(bad({ SETTLEMENT_HOST: "on" }))).toBe(true);
    expect(Object.isFrozen(bad({ ...ON_ENV, SETTLEMENT_TYPO: "1" }))).toBe(true);
  });
});

/**
 * سیاستِ env (ADR-0076 تصمیم ۲): شکست‌بسته، بی‌پیش‌فرضِ حدسی برای tuning، غلط‌یابِ نام، بی‌نشتِ مقدار، تک‌خوانیِ هر کلید.
 */
import { describe, expect, it } from "vitest";
import { TOOL_POLICY_BOOTSTRAP_ENV, parseBootstrapEnv } from "./index";

const CANARY = "LEAK-CANARY-policy-bootstrap-91c4";
const TUNING_ENV = {
  TOOL_POLICY_INTERVAL_MS: "10000",
  TOOL_POLICY_RETRY_MS: "2000",
  TOOL_POLICY_ATTEMPT_DEADLINE_MS: "6000",
  TOOL_POLICY_REFRESH_TIMEOUT_MS: "5000",
  TOOL_POLICY_MAX_STALE_MS: "30000",
};
const on = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ TOOL_POLICY_HOST: "on", ...TUNING_ENV, ...extra });

describe("tool-policy-bootstrap · env · خاموش پیش‌فرض است", () => {
  it.each([[{}], [{ TOOL_POLICY_HOST: "" }], [{ TOOL_POLICY_HOST: "off" }], [{ TOOL_POLICY_HOST: undefined }]])("%j ⇒ enabled:false", (env) => {
    expect(parseBootstrapEnv(env)).toEqual({ ok: true, value: { enabled: false } });
  });

  it("خاموش یعنی بقیهٔ محیط نادیده می‌ماند (حتی اعداد بد و کلیدِ ناشناخته)", () => {
    expect(parseBootstrapEnv({ TOOL_POLICY_HOST: "off", TOOL_POLICY_INTERVAL_MS: "abc", TOOL_POLICY_TYPO: "1" })).toEqual({ ok: true, value: { enabled: false } });
    expect(parseBootstrapEnv({ TOOL_POLICY_INTERVAL_MS: "abc" })).toEqual({ ok: true, value: { enabled: false } });
  });

  it("نتیجهٔ خاموش یخ‌زده است", () => {
    const r = parseBootstrapEnv({});
    expect(r.ok && Object.isFrozen(r.value)).toBe(true);
  });
});

describe("tool-policy-bootstrap · env · شکست‌بسته روی مقدارِ کلیدِ اصلی", () => {
  it.each(["ON", "On", "true", "1", "yes", " on", "on ", "enabled", "0", "false", "OFF", "off\n"])("TOOL_POLICY_HOST=%j ⇒ INVALID (نه روشن و نه خاموشِ حدسی)", (v) => {
    const r = parseBootstrapEnv({ TOOL_POLICY_HOST: v, ...TUNING_ENV });
    expect(r).toEqual({ ok: false, issues: ["TOOL_POLICY_HOST باید on یا off باشد."] });
  });

  it.each([[1], [true], [null], [{}], [["on"]]])("مقدارِ غیررشته‌ای %j ⇒ INVALID", (v) => {
    expect(parseBootstrapEnv({ TOOL_POLICY_HOST: v }).ok).toBe(false);
  });

  it.each([[null], [undefined], ["x"], [[]], [42]])("خودِ env نامعتبر (%j) ⇒ خطا بی‌پرتاب", (v) => {
    expect(parseBootstrapEnv(v)).toEqual({ ok: false, issues: ["env باید یک شیء ساده باشد."] });
  });
});

describe("tool-policy-bootstrap · env · روشن", () => {
  it("حداقلِ معتبر: پنج عددِ tuning؛ بقیه null", () => {
    expect(parseBootstrapEnv(on())).toEqual({
      ok: true,
      value: {
        enabled: true,
        tuning: { intervalMs: 10000, retryMs: 2000, attemptDeadlineMs: 6000, refreshTimeoutMs: 5000, maxStaleMs: 30000 },
        schema: null,
        statementTimeoutMs: null,
        shutdownTimeoutMs: null,
        bootAttempts: null,
        bootRetryDelayMs: null,
      },
    });
  });

  it("همهٔ اختیاری‌ها خوانده می‌شوند", () => {
    const r = parseBootstrapEnv(
      on({ TOOL_POLICY_SCHEMA: "policy_x", TOOL_POLICY_STATEMENT_TIMEOUT_MS: "4000", TOOL_POLICY_SHUTDOWN_TIMEOUT_MS: "20000", TOOL_POLICY_BOOT_ATTEMPTS: "3", TOOL_POLICY_BOOT_RETRY_DELAY_MS: "500" }),
    );
    expect(r).toMatchObject({ ok: true, value: { schema: "policy_x", statementTimeoutMs: 4000, shutdownTimeoutMs: 20000, bootAttempts: 3, bootRetryDelayMs: 500 } });
  });

  it("خروجیِ موفق و tuningش یخ‌زده‌اند", () => {
    const r = parseBootstrapEnv(on());
    expect(r.ok && Object.isFrozen(r.value)).toBe(true);
    expect(r.ok && r.value.enabled && Object.isFrozen(r.value.tuning)).toBe(true);
  });

  it.each(Object.keys(TUNING_ENV))("نبودنِ %s الزامی‌ست: بی‌پیش‌فرضِ حدسی", (name) => {
    const env = on();
    delete env[name];
    expect(parseBootstrapEnv(env)).toEqual({ ok: false, issues: [`${name} الزامی است.`] });
    expect(parseBootstrapEnv({ ...env, [name]: "" })).toEqual({ ok: false, issues: [`${name} الزامی است.`] });
  });

  it("نبودنِ همهٔ پنج عدد ⇒ پنج مشکل (همه با هم، نه یکی‌یکی)", () => {
    const r = parseBootstrapEnv({ TOOL_POLICY_HOST: "on" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.issues).toHaveLength(5);
  });

  const BAD_NUMBERS = ["0", "-1", "+5", "01", "1.5", "1e3", "0x10", " 5", "5 ", "۵", "٥", "12345678901", "abc", "5_0", "NaN", "Infinity"];
  const NUMERIC = [...Object.keys(TUNING_ENV), "TOOL_POLICY_STATEMENT_TIMEOUT_MS", "TOOL_POLICY_SHUTDOWN_TIMEOUT_MS", "TOOL_POLICY_BOOT_ATTEMPTS", "TOOL_POLICY_BOOT_RETRY_DELAY_MS"];
  it.each(NUMERIC)("%s فقط رقمِ لاتینِ مثبت: ۱۶ مقدارِ بد همه رد می‌شوند و مقدار در پیام نیست", (name) => {
    for (const bad of BAD_NUMBERS) {
      const r = parseBootstrapEnv(on({ [name]: bad }));
      expect(r.ok, `${name}=${bad}`).toBe(false);
      expect(!r.ok && r.issues, `${name}=${bad}`).toEqual([`${name} باید عددِ صحیحِ مثبتِ لاتین باشد.`]);
    }
  });

  it.each(NUMERIC)("%s غیررشته (عدد/بولی/شیء) ⇒ رد", (name) => {
    for (const bad of [5, true, {}, null as unknown]) expect(parseBootstrapEnv(on({ [name]: bad })).ok, `${name}`).toBe(false);
  });

  it("مرزهای رقم: «1» و ده رقم پذیرفته؛ یازده رقم نه", () => {
    expect(parseBootstrapEnv(on({ TOOL_POLICY_BOOT_ATTEMPTS: "1" })).ok).toBe(true);
    expect(parseBootstrapEnv(on({ TOOL_POLICY_BOOT_ATTEMPTS: "9999999999" })).ok).toBe(true);
    expect(parseBootstrapEnv(on({ TOOL_POLICY_BOOT_ATTEMPTS: "10000000000" })).ok).toBe(false);
  });

  it("بازه و رابطهٔ tuning را این ماژول نمی‌سنجد (منبعِ حقیقتِ یگانه ریشه است): ۱ برای همه پذیرفته", () => {
    const r = parseBootstrapEnv(on({ TOOL_POLICY_INTERVAL_MS: "1", TOOL_POLICY_MAX_STALE_MS: "1" }));
    expect(r.ok).toBe(true);
  });

  it("schema: غیررشته ⇒ رد؛ خالی ⇒ null؛ محتوایش اینجا سنجیده نمی‌شود", () => {
    expect(parseBootstrapEnv(on({ TOOL_POLICY_SCHEMA: 5 }))).toEqual({ ok: false, issues: ["TOOL_POLICY_SCHEMA باید رشته باشد."] });
    expect(parseBootstrapEnv(on({ TOOL_POLICY_SCHEMA: "" }))).toMatchObject({ ok: true, value: { schema: null } });
    expect(parseBootstrapEnv(on({ TOOL_POLICY_SCHEMA: "any thing" }))).toMatchObject({ ok: true, value: { schema: "any thing" } });
  });
});

describe("tool-policy-bootstrap · env · غلط‌یابِ نام", () => {
  it.each(["TOOL_POLICY_INTERVAL", "TOOL_POLICY_HOST_", "TOOL_POLICY_", "TOOL_POLICY_MAX_STALE", "TOOL_POLICY_retry_ms", "TOOL_POLICY_MAXSTALE_MS", "TOOL_POLICY_GRACE_MS"])("%s با on ⇒ خطا", (k) => {
    const r = parseBootstrapEnv(on({ [k]: "1" }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.issues[0]).toContain("متغیرِ ناشناخته");
  });

  it("کلیدهای بی‌پیشوندِ ما (PATH، SETTLEMENT_*، TOOL_POLICYX) نادیده‌اند", () => {
    expect(parseBootstrapEnv(on({ PATH: "/bin", SETTLEMENT_HOST: "on", TOOL_POLICYX_Y: "1", TOOL_POLICY: "1" })).ok).toBe(true);
  });

  it("نامِ ناشناخته کوتاه و چاپ‌پذیر در پیام می‌آید؛ مقدارش هرگز", () => {
    const k = `TOOL_POLICY_${"é".repeat(300)}`;
    const r = parseBootstrapEnv(on({ [k]: CANARY }));
    expect(r.ok).toBe(false);
    const text = JSON.stringify(!r.ok && r.issues);
    expect(text).not.toContain(CANARY);
    expect(text).toContain("?");
    expect(text.length).toBeLessThan(200);
  });
});

describe("tool-policy-bootstrap · env · بی‌نشت و مقاوم", () => {
  it("مقدارِ هیچ متغیری در پیام نمی‌آید (در همهٔ مسیرهای خطا)", () => {
    const envs: Record<string, unknown>[] = [
      { TOOL_POLICY_HOST: CANARY },
      on({ TOOL_POLICY_INTERVAL_MS: CANARY }),
      on({ TOOL_POLICY_SCHEMA: CANARY, TOOL_POLICY_BOOT_ATTEMPTS: CANARY }),
      on({ TOOL_POLICY_UNKNOWN_KEY: CANARY }),
    ];
    for (const e of envs) expect(JSON.stringify(parseBootstrapEnv(e))).not.toContain(CANARY);
  });

  it("هر کلید فقط یک بار خوانده می‌شود (getterِ خصمانه)", () => {
    const reads: Record<string, number> = {};
    const env: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(on({ TOOL_POLICY_SCHEMA: "s", TOOL_POLICY_BOOT_ATTEMPTS: "2" }))) {
      Object.defineProperty(env, k, { enumerable: true, get: () => ((reads[k] = (reads[k] ?? 0) + 1), v) });
    }
    expect(parseBootstrapEnv(env).ok).toBe(true);
    for (const [k, n] of Object.entries(reads)) expect(n, k).toBe(1);
  });

  it("getterِ پرتاب‌کننده ⇒ خطای ثابت، بی‌پرتاب", () => {
    const env = {};
    Object.defineProperty(env, "TOOL_POLICY_HOST", { enumerable: true, get: () => { throw new Error(CANARY); } });
    const r = parseBootstrapEnv(env);
    expect(r).toEqual({ ok: false, issues: ["خواندنِ env ناموفق بود."] });
  });

  it("خروجی دو بار با ورودیِ یکسان یکسان است و ورودی را تغییر نمی‌دهد (خالص)", () => {
    const env = on({ TOOL_POLICY_BOOT_ATTEMPTS: "2" });
    const before = JSON.stringify(env);
    expect(parseBootstrapEnv(env)).toEqual(parseBootstrapEnv(env));
    expect(JSON.stringify(env)).toBe(before);
  });

  it("خاصیتی: ۳۰۰۰ محیطِ تصادفی هرگز نمی‌پرتابد، خروجی همیشه بسته و بی‌مقدار", () => {
    let seed = 20261219;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const pool: unknown[] = ["on", "off", "", "1", "10", "0", "-3", CANARY, "۵", undefined, null, 7, true, {}, "99999999999"];
    const keys = [...Object.keys(TUNING_ENV), "TOOL_POLICY_HOST", "TOOL_POLICY_SCHEMA", "TOOL_POLICY_BOOT_ATTEMPTS", "TOOL_POLICY_X", "FOO"];
    for (let i = 0; i < 3000; i++) {
      const env: Record<string, unknown> = {};
      for (const k of keys) if (rnd() < 0.7) env[k] = pool[Math.floor(rnd() * pool.length)];
      const r = parseBootstrapEnv(env);
      expect(typeof r.ok).toBe("boolean");
      if (!r.ok) expect(JSON.stringify(r.issues)).not.toContain(CANARY);
      if (r.ok && r.value.enabled) {
        expect(Object.values(r.value.tuning).every((n) => Number.isSafeInteger(n) && n > 0)).toBe(true);
        expect(env["TOOL_POLICY_HOST"]).toBe("on");
      }
    }
  });
});

describe("tool-policy-bootstrap · نامِ متغیرها", () => {
  it("TOOL_POLICY_BOOTSTRAP_ENV یخ‌زده و همهٔ نام‌ها با پیشوندِ رزروشده‌اند و یکتا", () => {
    const names = Object.values(TOOL_POLICY_BOOTSTRAP_ENV);
    expect(Object.isFrozen(TOOL_POLICY_BOOTSTRAP_ENV)).toBe(true);
    expect(names.every((n) => n.startsWith("TOOL_POLICY_"))).toBe(true);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(11);
  });

  it("هر نامِ مستند با on پذیرفته می‌شود (تکراری بودنِ فهرست با KNOWN ناهمخوان نیست)", () => {
    const env: Record<string, unknown> = on({ TOOL_POLICY_SCHEMA: "s", TOOL_POLICY_STATEMENT_TIMEOUT_MS: "1", TOOL_POLICY_SHUTDOWN_TIMEOUT_MS: "1", TOOL_POLICY_BOOT_ATTEMPTS: "1", TOOL_POLICY_BOOT_RETRY_DELAY_MS: "1" });
    for (const n of Object.values(TOOL_POLICY_BOOTSTRAP_ENV)) expect(Object.keys(env), n).toContain(n);
    expect(parseBootstrapEnv(env).ok).toBe(true);
  });
});

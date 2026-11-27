import { describe, expect, it } from "vitest";
import { DEFAULT_TIMEOUT_MS, KNOWN_TOOL_POLICY_ENV, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS, USAGE, parseMigrateArgs } from "./args";
import { CANARY } from "./test-kit";

const ENV = { DATABASE_URL: "x" };
const issuesOf = (argv: unknown, env: unknown = ENV): readonly string[] => {
  const r = parseMigrateArgs(argv, env);
  if (r.ok) throw new Error("expected failure");
  return r.issues;
};

describe("tool-policy-migrate · args · مسیر عادی", () => {
  it("status و up با پیش‌فرض‌ها", () => {
    expect(parseMigrateArgs(["status"], ENV)).toEqual({ ok: true, value: { command: "status", timeoutMs: DEFAULT_TIMEOUT_MS, schema: null, createSchema: false } });
    expect(parseMigrateArgs(["up"], ENV)).toEqual({ ok: true, value: { command: "up", timeoutMs: 60_000, schema: null, createSchema: false } });
  });
  it("--create-schema فقط با up؛ ترتیبِ فلگ‌ها آزاد است", () => {
    expect(parseMigrateArgs(["--create-schema", "up", "--timeout-ms=2000"], ENV)).toMatchObject({ ok: true, value: { command: "up", createSchema: true, timeoutMs: 2000 } });
    expect(parseMigrateArgs(["up", "--timeout-ms=2000", "--create-schema"], ENV)).toMatchObject({ ok: true, value: { createSchema: true } });
  });
  it("شِما فقط از محیط؛ خالی/نبود = null", () => {
    expect(parseMigrateArgs(["up"], { ...ENV, TOOL_POLICY_SCHEMA: "pol_x" })).toMatchObject({ ok: true, value: { schema: "pol_x" } });
    expect(parseMigrateArgs(["up"], { ...ENV, TOOL_POLICY_SCHEMA: "" })).toMatchObject({ ok: true, value: { schema: null } });
  });
  it("help فقط تنها", () => {
    expect(parseMigrateArgs(["--help"], {})).toEqual({ ok: true, value: { command: "help" } });
    expect(parseMigrateArgs(["-h"], null)).toEqual({ ok: true, value: { command: "help" } });
    expect(issuesOf(["up", "--help"])).toContain("--help باید تنها بیاید.");
  });
  it("متغیرهای شناخته‌شدهٔ bootstrap پذیرفته و مقدارشان نادیده است", () => {
    const env: Record<string, string> = { ...ENV };
    for (const k of KNOWN_TOOL_POLICY_ENV) if (k !== "TOOL_POLICY_SCHEMA") env[k] = "whatever";
    expect(parseMigrateArgs(["status"], env)).toMatchObject({ ok: true, value: { schema: null } });
  });
});

describe("tool-policy-migrate · args · مرز timeout", () => {
  it.each([[String(MIN_TIMEOUT_MS), true], [String(MAX_TIMEOUT_MS), true], ["999", false], ["600001", false], ["0", false], ["01000", false], ["1e4", false], ["۱۰۰۰۰", false], ["-5000", false], ["", false], ["12345678901", false]])("--timeout-ms=%s ⇒ %s", (v, ok) => {
    expect(parseMigrateArgs(["up", `--timeout-ms=${v}`], ENV).ok).toBe(ok);
  });
  it("شکلِ دو‌توکنی/بی‌مقدار/تکراری رد می‌شود", () => {
    expect(parseMigrateArgs(["up", "--timeout-ms", "5000"], ENV).ok).toBe(false);
    expect(parseMigrateArgs(["up", "--timeout-ms"], ENV).ok).toBe(false);
    expect(issuesOf(["up", "--timeout-ms=2000", "--timeout-ms=3000"])).toContain("--timeout-ms تکراری است.");
  });
});

describe("tool-policy-migrate · args · خطاها", () => {
  it("دستورِ لازم/ناشناخته/اضافه", () => {
    expect(issuesOf([])).toContain("دستور لازم است (status یا up).");
    expect(issuesOf(["down"])).toContain("دستورِ ناشناخته (status یا up).");
    expect(issuesOf(["up", "status"])).toContain("آرگومانِ اضافه (فقط یک دستور).");
    expect(issuesOf(["up", "up"])).toContain("آرگومانِ اضافه (فقط یک دستور).");
  });
  it("--create-schema با status رد، با مقدار رد، تکراری رد", () => {
    expect(issuesOf(["status", "--create-schema"]).join(" ")).toContain("فقط با up");
    expect(issuesOf(["--create-schema", "status"]).join(" ")).toContain("فقط با up");
    expect(issuesOf(["up", "--create-schema=1"])).toContain("--create-schema مقدار نمی‌گیرد.");
    expect(issuesOf(["up", "--create-schema", "--create-schema"])).toContain("--create-schema تکراری است.");
  });
  it("فلگِ ناشناخته: نامِ شبیهِ فلگ پژواک می‌شود، ولی آرگومانِ موضعی/مقدار هرگز", () => {
    const secret = `postgres://u:${CANARY}@h/db`;
    expect(issuesOf(["up", "--schema=x"])).toContain('فلگِ ناشناختهٔ "--schema".');
    expect(issuesOf(["up", `--${secret}`]).join(" ")).not.toContain(CANARY);
    expect(issuesOf(["up", secret]).join(" ")).not.toContain(CANARY);
    expect(issuesOf(["up", "-x"]).join(" ")).not.toContain("-x");
    expect(issuesOf(["up", `--timeout-ms=${CANARY}`]).join(" ")).not.toContain(CANARY);
  });
  it("DATABASE_URL الزامی؛ مقدارش هرگز در خروجی نیست", () => {
    expect(issuesOf(["up"], {})).toContain("DATABASE_URL الزامی است.");
    expect(issuesOf(["up"], { DATABASE_URL: "" })).toContain("DATABASE_URL الزامی است.");
    expect(issuesOf(["up"], { DATABASE_URL: 5 })).toContain("DATABASE_URL الزامی است.");
    const ok = parseMigrateArgs(["up"], { DATABASE_URL: `postgres://u:${CANARY}@h/d` });
    expect(JSON.stringify(ok)).not.toContain(CANARY);
  });
  it("غلط‌یابِ نام: هر TOOL_POLICY_* ناشناخته خطاست و فقط نامش می‌آید", () => {
    const r = issuesOf(["up"], { ...ENV, TOOL_POLICY_SCHEMAA: CANARY, TOOL_POLICY_: "x" });
    expect(r.filter((i) => i.includes("متغیرِ ناشناخته"))).toHaveLength(2);
    expect(r.join(" ")).toContain('"TOOL_POLICY_SCHEMAA"');
    expect(r.join(" ")).not.toContain(CANARY);
    expect(issuesOf(["up"], { ...ENV, ["TOOL_POLICY_é\u0000"]: "x" }).join(" ")).toContain("TOOL_POLICY_?");
  });
  it("پیشوندهای دیگر (SETTLEMENT_*, NODE_ENV) نادیده‌اند", () => {
    expect(parseMigrateArgs(["up"], { ...ENV, SETTLEMENT_TYPO: "1", NODE_ENV: "x" }).ok).toBe(true);
  });
  it("TOOL_POLICY_SCHEMA غیررشته ⇒ خطا", () => {
    expect(issuesOf(["up"], { ...ENV, TOOL_POLICY_SCHEMA: 5 })).toContain("TOOL_POLICY_SCHEMA باید رشته باشد.");
  });
  it("ورودی‌های بدشکل هرگز نمی‌پرتابند", () => {
    for (const argv of [null, undefined, "up", 5, {}, [1], ["up", null]]) expect(parseMigrateArgs(argv, ENV).ok).toBe(false);
    for (const env of [null, undefined, "x", [], 5]) expect(parseMigrateArgs(["up"], env).ok).toBe(false);
    const evil = { get DATABASE_URL(): string { throw new Error(CANARY); } };
    const r = parseMigrateArgs(["up"], evil);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(CANARY);
  });
  it("نتیجه یخ‌زده و USAGE ثابت است", () => {
    const r = parseMigrateArgs(["up"], ENV);
    expect(r.ok && Object.isFrozen(r.value)).toBe(true);
    expect(Object.isFrozen(USAGE)).toBe(true);
    expect(USAGE.join("\n")).toContain("--create-schema");
  });
  it("آرگومانِ بد با دستورِ معتبر: command برای گزارش حفظ می‌شود", () => {
    const r = parseMigrateArgs(["up", "--bogus"], ENV);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.command).toBe("up");
  });
});

describe("tool-policy-migrate · args · قفلِ مقدارهای قراردادی (جهش‌آزمایی)", () => {
  it("مرزهای مهلت با عددِ لفظی: ۱۰۰۰ و ۶۰۰۰۰۰ مجاز، ۹۹۹ و ۶۰۰۰۰۱ نه؛ پیش‌فرض ۶۰۰۰۰", () => {
    expect([MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS]).toEqual([1000, 600_000, 60_000]);
    for (const [v, ok] of [["1000", true], ["1001", true], ["599999", true], ["600000", true], ["999", false], ["600001", false]] as const) {
      expect(parseMigrateArgs(["up", `--timeout-ms=${v}`], ENV).ok, v).toBe(ok);
    }
  });
  it("--help فقط وقتی تنها است: چه در ابتدا چه در انتها", () => {
    expect(parseMigrateArgs(["--help", "up"], ENV).ok).toBe(false);
    expect(parseMigrateArgs(["-h", "status"], ENV).ok).toBe(false);
    expect(parseMigrateArgs(["--help", "--help"], ENV).ok).toBe(false);
  });
  it("فلگِ کوتاهِ ناشناخته پیامِ مخصوصِ خودش را می‌دهد", () => {
    expect(issuesOf(["up", "-x"])).toContain("فلگِ ناشناخته (کوتاه).");
    expect(issuesOf(["-x", "up"])).toContain("فلگِ ناشناخته (کوتاه).");
  });
  it("نامِ بلندِ متغیرِ ناشناخته در پیام کوتاه می‌شود (۴۸ نویسه)", () => {
    const key = `TOOL_POLICY_${"X".repeat(300)}`;
    const msg = issuesOf(["up"], { ...ENV, [key]: "1" }).find((i) => i.includes("متغیرِ ناشناخته")) ?? "";
    expect(msg.length).toBeGreaterThan(0);
    expect(msg.length).toBeLessThan(120);
    expect(msg).toContain(`"TOOL_POLICY_${"X".repeat(36)}"`);
  });
});

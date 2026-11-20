/**
 * CLIِ `npm run backlog:cost` به‌صورت فرایندِ واقعی (ADR-0044): حلقهٔ resolve، اجرای بومیِ TypeScript، کدهای خروج، stdout/stderr و بی‌نشتِ رشتهٔ اتصال.
 * آزمون‌های خطای ورودی و پایگاهِ در دسترس‌نبودن بی‌پایگاه‌اند؛ اجرای موفق به PostgreSQLِ واقعی نیاز دارد (شِمای یک‌بارمصرفِ خودِ ابزار).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";
import { describe, expect, it } from "vitest";
import type { CostReport } from "./backlog-cost";

config({ quiet: true });
const DB_URL: string | undefined = process.env["KB_TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
const dbIt = typeof DB_URL === "string" && DB_URL !== "" ? it : it.skip;
const ROOT = join(__dirname, "..");
const SECRET_URL = ["postgres", "://u:", "pw-canary", "@127.0.0.1:1/none"].join("");

function run(args: string[], url: string | null) {
  const env: Record<string, string | undefined> = { PATH: process.env["PATH"], HOME: process.env["HOME"], ...(url === null ? {} : { DATABASE_URL: url }) };
  const r = spawnSync("node", ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--import", "./tooling/cli/register.mjs", "tooling/cli/backlog-cost.ts", ...args], { cwd: ROOT, env: env as unknown as NodeJS.ProcessEnv, encoding: "utf8", timeout: 120_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("backlog-cost · CLI (فرایندِ واقعی)", () => {
  it("اسکریپتِ package.json همان فرمانِ مستند است و وابستگیِ تازه نیامده", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["backlog:cost"]).toBe("node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tooling/cli/register.mjs tooling/cli/backlog-cost.ts");
  });

  it("فلگِ ناشناخته ⇒ خروج ۲، stderr یک خطِ JSON با کدِ بسته، stdout خالی", () => {
    const r = run(["--nope=1"], "x");
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(JSON.parse(r.stderr.trim())).toEqual({ ok: false, code: "UNKNOWN_FLAG", flag: "nope" });
  });

  it("آرگومانِ موضعیِ حاویِ رشتهٔ اتصال ⇒ خروج ۲ و هیچ‌جا پژواک نمی‌شود", () => {
    const r = run([SECRET_URL], SECRET_URL);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stderr.trim())).toEqual({ ok: false, code: "POSITIONAL", flag: null });
    expect(r.stdout + r.stderr).not.toContain("pw-canary");
  });

  it("بی‌DATABASE_URL ⇒ خروج ۲ و DATABASE_URL_MISSING", () => {
    const r = run(["--scales=10"], null);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stderr.trim())).toEqual({ ok: false, code: "DATABASE_URL_MISSING" });
    expect(run(["--scales=10"], "").code).toBe(2);
  });

  it("پایگاهِ در دسترس نیست ⇒ خروج ۳، DATABASE_UNAVAILABLE، و نشتِ رمز/میزبان نه در stdout نه stderr", () => {
    const r = run(["--scales=10", "--repeats=1"], SECRET_URL);
    expect(r.code).toBe(3);
    expect(r.stdout).toBe("");
    expect(JSON.parse(r.stderr.trim())).toEqual({ ok: false, code: "DATABASE_UNAVAILABLE" });
    expect(r.stdout + r.stderr).not.toMatch(/pw-canary|127\.0\.0\.1/);
  });

  dbIt("اجرای موفق: stdout دقیقاً یک خطِ JSON (گزارشِ نسخهٔ ۱)، stderr خالی، خروج ۰", () => {
    const r = run(["--scales=20,60", "--unacked=2", "--done=10", "--repeats=2"], DB_URL ?? null);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout.endsWith("\n")).toBe(true);
    expect(r.stdout.trimEnd().split("\n")).toHaveLength(1);
    const report = JSON.parse(r.stdout) as CostReport;
    expect(report.version).toBe(1);
    expect(report.scenarios.map((s) => s.ackedDead)).toEqual([20, 60]);
    expect(report.scenarios.every((s) => s.plan.returnedRows === 2)).toBe(true);
    expect(["ok", "warn"]).toContain(report.verdict.status);
    expect(r.stdout).not.toMatch(/postgres(ql)?:\/\//);
  });

  dbIt("--format=text: جدولِ انسانی با خطِ حکمِ کل، خروج ۰", () => {
    const r = run(["--scales=20,60", "--repeats=1", "--format=text"], DB_URL ?? null);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toMatch(/^backlog-cost v1 · postgresql /);
    expect(r.stdout).toMatch(/overall: (ok|warn)\n$/);
  });

  dbIt("حکمِ warn (اسکنِ پهن: ۲۰٬۰۰۰ تأییدشده، ۳ برگشتی) ⇒ خروج ۰ (هشدار، شکست نیست) و WIDE_SCAN در گزارش", () => {
    const r = run(["--scales=20000", "--unacked=3", "--repeats=1"], DB_URL ?? null);
    expect(r.stderr).toBe("");
    const report = JSON.parse(r.stdout) as CostReport;
    expect(report.verdict.status).toBe("warn");
    expect(report.verdict.scenarios[0]?.reasons).toContain("WIDE_SCAN");
    expect(r.code).toBe(0);
  });

  dbIt("بودجهٔ ناممکن (timeout-ms=1) ⇒ حکمِ fail ⇒ خروج ۱ با گزارشِ کامل در stdout", () => {
    // مهلتِ ۱ms: کمینهٔ هر خواندنِ واقعی (دست‌کم یک رفت‌وبرگشتِ تراکنش) ≥ ۱ms نیست تضمین‌شده؛ پس مقیاسِ بزرگ‌تر و limit بزرگ برای اطمینان.
    const r = run(["--scales=20000", "--unacked=3", "--repeats=1", "--timeout-ms=1"], DB_URL ?? null);
    expect(r.stderr).toBe("");
    const report = JSON.parse(r.stdout) as CostReport;
    expect(report.verdict.status).toBe("fail");
    expect(r.code).toBe(1);
  });
});

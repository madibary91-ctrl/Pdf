import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT_DB_UNAVAILABLE } from "./ci-tests";
import { decideGateOutcome, GATE_EXIT_DB_UNAVAILABLE, isStrictGateEnv } from "./git-discipline";

const TOOLING = dirname(fileURLToPath(import.meta.url));
const NODE_FLAGS = ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON"];

describe("pre-push: تصمیم خالصِ نتیجهٔ دروازه", () => {
  it("کد خروجیِ «پایگاه در دسترس نیست» در ci-tests و git-discipline همگام و متمایز از شکست است", () => {
    expect(GATE_EXIT_DB_UNAVAILABLE).toBe(EXIT_DB_UNAVAILABLE);
    expect(GATE_EXIT_DB_UNAVAILABLE).not.toBe(0);
    expect(GATE_EXIT_DB_UNAVAILABLE).not.toBe(1);
  });

  it("کد ۰ می‌گذرد؛ بدون پیام", () => {
    expect(decideGateOutcome({ status: 0 }, false)).toEqual({ kind: "pass", message: "" });
    expect(decideGateOutcome({ status: 0 }, true).kind).toBe("pass");
  });

  it("نبودن پایگاه در حالت غیرسخت‌گیر هشدار است (نه مسدود) و CI را به‌عنوان دروازهٔ نهایی نام می‌برد", () => {
    const o = decideGateOutcome({ status: GATE_EXIT_DB_UNAVAILABLE }, false);
    expect(o.kind).toBe("warn");
    expect(o.message).toContain("هشدار");
    expect(o.message).toContain("CI");
    expect(o.message).toContain("GIT_DISCIPLINE_REQUIRE_DB");
  });

  it("نبودن پایگاه در حالت سخت‌گیر مسدود است", () => {
    expect(decideGateOutcome({ status: GATE_EXIT_DB_UNAVAILABLE }, true).kind).toBe("block");
  });

  it("هر چیز جز «دقیقاً کد پایگاه» مسدود است، حتی در حالت غیرسخت‌گیر (ایمن‌به‌طور پیش‌فرض)", () => {
    const blocked: Array<Parameters<typeof decideGateOutcome>[0]> = [
      { status: 1 }, // تست شکست خورد / کف سبز
      { status: 2 },
      { status: 4 },
      { status: 127 },
      { status: 255 },
      { status: -1 },
      { status: null }, // کشته‌شدن
      { status: null, signal: "SIGKILL" },
      { status: GATE_EXIT_DB_UNAVAILABLE, spawnFailed: true }, // اجراگر اصلاً اجرا نشد؛ کد معتبر نیست
      { status: 0, spawnFailed: true },
    ];
    for (const run of blocked) {
      for (const strict of [false, true]) {
        expect(decideGateOutcome(run, strict).kind, JSON.stringify({ run, strict })).toBe("block");
      }
    }
    expect(decideGateOutcome({ status: null, signal: "SIGTERM" }, false).message).toContain("SIGTERM");
    expect(decideGateOutcome({ status: 1 }, false).message).toContain("کد 1");
  });

  it("isStrictGateEnv: CI، GITHUB_ACTIONS و GIT_DISCIPLINE_REQUIRE_DB", () => {
    expect(isStrictGateEnv({})).toBe(false);
    expect(isStrictGateEnv({ CI: "" })).toBe(false);
    expect(isStrictGateEnv({ CI: "false" })).toBe(false);
    expect(isStrictGateEnv({ CI: "0" })).toBe(false);
    expect(isStrictGateEnv({ GIT_DISCIPLINE_REQUIRE_DB: "no" })).toBe(false);
    expect(isStrictGateEnv({ CI: "true" })).toBe(true);
    expect(isStrictGateEnv({ CI: "1" })).toBe(true);
    expect(isStrictGateEnv({ CI: " TRUE " })).toBe(true);
    expect(isStrictGateEnv({ GITHUB_ACTIONS: "true" })).toBe(true);
    expect(isStrictGateEnv({ GIT_DISCIPLINE_REQUIRE_DB: "1" })).toBe(true);
    expect(isStrictGateEnv({ GIT_DISCIPLINE_REQUIRE_DB: "true" })).toBe(true);
  });
});

/** محیط تمیز: بدون متغیرهای GIT_* ارثی و بدون هیچ‌یک از نشانه‌های سخت‌گیری؛ فقط آنچه آزمون صریحاً می‌دهد. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("GIT_") || k === "CI" || k === "GITHUB_ACTIONS" || k === "KB_TEST_DATABASE_URL" || k === "DATABASE_URL" || k === "CI_MIN_PASSED") continue;
    env[k] = v;
  }
  return { ...env, ...extra } as NodeJS.ProcessEnv;
}

describe("pre-push: اجرای واقعی هوک با دروازهٔ جایگزین (مخزن موقت)", () => {
  let dir = "";
  let head = "";
  const Z = "0".repeat(40);

  const git = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: cleanEnv() });
    return { code: r.status ?? -1, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
  };
  const hook = (env: Record<string, string>, input: string) => {
    const r = spawnSync(process.execPath, [...NODE_FLAGS, join(dir, "tooling/git-discipline.ts"), "pre-push", "origin", "url"], {
      cwd: dir,
      encoding: "utf8",
      env: cleanEnv(env),
      input,
    });
    return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };
  const prePush = (env: Record<string, string>) => hook(env, `refs/heads/main ${head} refs/heads/main ${Z}\n`);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "pre-push-gate-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    git("config", "commit.gpgsign", "false");
    mkdirSync(join(dir, "tooling"), { recursive: true });
    // ابزار واقعی کپی می‌شود (REPO_ROOT = والدِ پوشهٔ tooling)؛ دروازه با یک جایگزینِ قابل‌کنترل عوض می‌شود تا تست به پایگاه و بازگشتِ بی‌پایان نیازی نداشته باشد.
    copyFileSync(join(TOOLING, "git-discipline.ts"), join(dir, "tooling/git-discipline.ts"));
    writeFileSync(
      join(dir, "tooling/ci-tests.ts"),
      'if (process.env["STUB_SIGNAL"]) process.kill(process.pid, process.env["STUB_SIGNAL"]);\nprocess.exit(Number(process.env["STUB_EXIT"] ?? "0"));\n',
    );
    writeFileSync(join(dir, "README.md"), "x\n");
    git("add", "-A");
    expect(git("-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "chore: initial").code).toBe(0);
    head = git("rev-parse", "HEAD").out;
  }, 30_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("دروازه سبز (۰): پوش آزاد و بی‌هشدار", () => {
    const r = prePush({ STUB_EXIT: "0" });
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain("هشدار");
  });

  it("نبودن پایگاه (۳) در ماشین توسعه: هشدار می‌دهد و پوش آزاد است", () => {
    const r = prePush({ STUB_EXIT: String(GATE_EXIT_DB_UNAVAILABLE) });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("هشدار");
    expect(r.out).toContain("CI");
  });

  it("نبودن پایگاه در CI یا با GIT_DISCIPLINE_REQUIRE_DB مسدود است", () => {
    const stricts: Array<Record<string, string>> = [{ CI: "true" }, { GITHUB_ACTIONS: "true" }, { GIT_DISCIPLINE_REQUIRE_DB: "1" }];
    for (const strict of stricts) {
      const r = prePush({ STUB_EXIT: String(GATE_EXIT_DB_UNAVAILABLE), ...strict });
      expect(r.code, JSON.stringify(strict)).toBe(1);
      expect(r.out).toContain("سخت‌گیر");
      expect(r.out).not.toContain("پوش مجاز است");
    }
  });

  it("شکست واقعی تست (۱) همیشه مسدود است — هشداری در کار نیست", () => {
    const r = prePush({ STUB_EXIT: "1" });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("قرمز است");
    expect(r.out).not.toContain("هشدار");
  });

  it("کدهای ناشناخته و کشته‌شدن اجراگر هم مسدود است", () => {
    expect(prePush({ STUB_EXIT: "2" }).code).toBe(1);
    expect(prePush({ STUB_EXIT: "127" }).code).toBe(1);
    const killed = prePush({ STUB_SIGNAL: "SIGKILL" });
    expect(killed.code).toBe(1);
    expect(killed.out).toContain("SIGKILL");
  });

  it("تسامحِ پایگاه، بررسی‌های دیگرِ پوش را دور نمی‌زند: درخت کثیف همچنان رد می‌شود", () => {
    writeFileSync(join(dir, "README.md"), "dirty\n");
    const r = prePush({ STUB_EXIT: String(GATE_EXIT_DB_UNAVAILABLE) });
    expect(r.code).toBe(1);
    expect(r.out).toContain("تمیز نیست");
    git("checkout", "--", "README.md");
  });

  it("تسامحِ پایگاه، بررسی‌های دیگرِ پوش را دور نمی‌زند: تاریخچهٔ ناشناخته/بازنویسی همچنان رد می‌شود", () => {
    const r = hook({ STUB_EXIT: String(GATE_EXIT_DB_UNAVAILABLE) }, `refs/heads/main ${"1".repeat(40)} refs/heads/main ${"2".repeat(40)}\n`);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/push-fetch-first|push-force/);
  });
});

describe("ci-tests.ts واقعی: نبودن پایگاه کد ۳ می‌دهد (و هرگز سبز نمی‌شود)", () => {
  let cwd = "";
  beforeAll(() => {
    cwd = mkdtempSync(join(tmpdir(), "ci-gate-env-")); // بدون .env تا dotenv چیزی تزریق نکند
  });
  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  const runGate = (env: Record<string, string>) => {
    const r = spawnSync(process.execPath, [...NODE_FLAGS, resolve(TOOLING, "ci-tests.ts")], { cwd, encoding: "utf8", env: cleanEnv(env), timeout: 60_000 });
    return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };

  it("پایگاه تنظیم نشده ⇒ ۳", () => {
    const r = runGate({});
    expect(r.code, r.out).toBe(EXIT_DB_UNAVAILABLE);
    expect(r.out).toContain("تنظیم نشده");
  });

  it("پایگاه تنظیم‌شده ولی در دسترس نیست (درگاه بسته) ⇒ ۳", () => {
    const r = runGate({ KB_TEST_DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:1/none" });
    expect(r.code, r.out).toBe(EXIT_DB_UNAVAILABLE);
    expect(r.out).toContain("اتصال به پایگاه آزمون ممکن نشد");
  });

  it("در هر دو حالت غیرصفر است؛ کنترل منفی CI (فقط «غیرصفر» را می‌سنجد) سالم می‌ماند", () => {
    expect(runGate({}).code).not.toBe(0);
    expect(runGate({ CI_GATE_SELF_CHECK: "1" }).code).not.toBe(0);
  });
});

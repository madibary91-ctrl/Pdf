import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { planCiRange, type CiRangeEnv, type CiRangeGit } from "./git-discipline";

const TOOLING = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(TOOLING, "..");
const NODE_FLAGS = ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON"];

const H = (c: string): string => c.repeat(40);
const [A, B, C, D] = [H("a"), H("b"), H("c"), H("d")];
const Z = "0".repeat(40);

const baseEnv: CiRangeEnv = { eventName: "push", prBaseSha: "", prHeadSha: "", pushBefore: "", sha: D, defaultBranch: "main" };
const fakeGit = (o: Partial<CiRangeGit> = {}): CiRangeGit => ({ commitExists: () => true, mergeBaseWithDefault: () => null, ...o });

describe("planCiRange: انتخاب بازهٔ کامیت‌ها (خالص)", () => {
  it("pull_request: base..head با نوک PR (نه کامیت ادغامِ مجازی)", () => {
    const p = planCiRange({ ...baseEnv, eventName: "pull_request", prBaseSha: B, prHeadSha: C, sha: D }, fakeGit());
    expect(p).toEqual({ ok: true, range: `${B}..${C}`, note: expect.any(String) });
  });

  it("pull_request: کامیت پایه در کلون نباشد ⇒ خطای روشن دربارهٔ fetch-depth (نه سبزِ بی‌بررسی)", () => {
    const p = planCiRange({ ...baseEnv, eventName: "pull_request", prBaseSha: B, prHeadSha: C }, fakeGit({ commitExists: (s) => s !== B }));
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.message).toContain("fetch-depth");
  });

  it("pull_request: SHAهای ناقص یا نامعتبر ⇒ خطا", () => {
    for (const [prBaseSha, prHeadSha] of [["", C], [B, ""], ["xyz", C], [B, "not-a-sha"]] as const) {
      expect(planCiRange({ ...baseEnv, eventName: "pull_request", prBaseSha, prHeadSha }, fakeGit()).ok, `${prBaseSha}|${prHeadSha}`).toBe(false);
    }
  });

  it("push با before شناخته‌شده: before..sha", () => {
    expect(planCiRange({ ...baseEnv, pushBefore: B }, fakeGit())).toMatchObject({ ok: true, range: `${B}..${D}` });
  });

  it("push: before صفر (ref تازه)، ناموجود (force-push) یا خالی ⇒ نسبت به شاخهٔ پیش‌فرض", () => {
    const git = fakeGit({ commitExists: (s) => s !== A, mergeBaseWithDefault: (sha, br) => (sha === D && br === "main" ? C : null) });
    for (const pushBefore of [Z, A, "", "garbage"]) {
      expect(planCiRange({ ...baseEnv, pushBefore }, git), pushBefore).toMatchObject({ ok: true, range: `${C}..${D}` });
    }
  });

  it("اجرای دستی و رویدادهای دیگر هم همان بازهٔ نسبت به شاخهٔ پیش‌فرض", () => {
    const git = fakeGit({ mergeBaseWithDefault: () => C });
    expect(planCiRange({ ...baseEnv, eventName: "workflow_dispatch" }, git)).toMatchObject({ ok: true, range: `${C}..${D}` });
    expect(planCiRange({ ...baseEnv, eventName: "schedule", pushBefore: B }, git)).toMatchObject({ ok: true, range: `${C}..${D}` });
  });

  it("پایه‌ای پیدا نشود ⇒ فقط خودِ کامیت (sha^!)؛ هرگز بازهٔ تهیِ بی‌صدا", () => {
    expect(planCiRange({ ...baseEnv, pushBefore: Z }, fakeGit())).toMatchObject({ ok: true, range: `${D}^!` });
    expect(planCiRange({ ...baseEnv, pushBefore: Z, defaultBranch: "" }, fakeGit({ mergeBaseWithDefault: () => C }))).toMatchObject({ ok: true, range: `${D}^!` });
  });

  it("SHA نامعتبر ⇒ خطا", () => {
    expect(planCiRange({ ...baseEnv, sha: "" }, fakeGit()).ok).toBe(false);
    expect(planCiRange({ ...baseEnv, sha: "HEAD" }, fakeGit()).ok).toBe(false);
  });
});

function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("GIT_") || k.startsWith("CI_") || k === "CI" || k === "GITHUB_ACTIONS") continue;
    env[k] = v;
  }
  return { ...env, ...extra } as NodeJS.ProcessEnv;
}

describe("ci-range: اجرای واقعی روی مخزن موقت", () => {
  let dir = "";
  const sha: Record<string, string> = {};
  const git = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: cleanEnv() });
    return { code: r.status ?? -1, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
  };
  const commit = (name: string, message: string) => {
    writeFileSync(join(dir, `${name}.txt`), `${name}\n`);
    git("add", "-A");
    const r = git("-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", message);
    expect(r.code, r.err).toBe(0);
    sha[name] = git("rev-parse", "HEAD").out;
  };
  const ciRange = (env: Record<string, string>) => {
    const r = spawnSync(process.execPath, [...NODE_FLAGS, join(dir, "tooling/git-discipline.ts"), "ci-range"], { cwd: dir, encoding: "utf8", env: cleanEnv(env) });
    return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };
  const push = (before: string, to: string, extra: Record<string, string> = {}) =>
    ciRange({ CI_EVENT_NAME: "push", CI_PUSH_BEFORE: before, CI_SHA: to, CI_DEFAULT_BRANCH: "main", ...extra });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ci-range-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    git("config", "commit.gpgsign", "false");
    mkdirSync(join(dir, "tooling"), { recursive: true });
    copyFileSync(join(TOOLING, "git-discipline.ts"), join(dir, "tooling/git-discipline.ts"));
    git("add", "-A");
    expect(git("-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "chore: tooling").code).toBe(0);
    sha["root"] = git("rev-parse", "HEAD").out;
    commit("a", "docs: نخست");
    commit("bad", "sloppy message without format"); // پیام نامعتبر
    commit("c", "docs: سوم");
    // شاخهٔ جدا از a با یک کامیت بد
    git("checkout", "-q", "-b", "feature", sha["a"] as string);
    commit("f-bad", "update stuff");
    git("checkout", "-q", "main");
  }, 30_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("پوش: بازهٔ شامل کامیت بد قرمز، بازهٔ پس از آن سبز", () => {
    const bad = push(sha["a"] as string, sha["c"] as string);
    expect(bad.code, bad.out).toBe(1);
    expect(bad.out).toContain("header-format");
    expect(bad.out).toContain((sha["bad"] as string).slice(0, 7));
    const good = push(sha["bad"] as string, sha["c"] as string);
    expect(good.code, good.out).toBe(0);
    expect(good.out).toContain(`${sha["bad"] as string}..${sha["c"] as string}`);
  });

  it("PR: base..head؛ پایهٔ ناموجود در کلون ⇒ شکستِ بلند (نه سبز)", () => {
    const pr = (base: string, head: string) => ciRange({ CI_EVENT_NAME: "pull_request", CI_PR_BASE_SHA: base, CI_PR_HEAD_SHA: head, CI_SHA: head, CI_DEFAULT_BRANCH: "main" });
    expect(pr(sha["a"] as string, sha["c"] as string).code).toBe(1);
    expect(pr(sha["bad"] as string, sha["c"] as string).code).toBe(0);
    const missing = pr("f".repeat(40), sha["c"] as string);
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("fetch-depth");
  });

  it("شاخهٔ تازه (before صفر): فقط کامیت‌های نسبت به main سنجیده می‌شود", () => {
    const r = push(Z, sha["f-bad"] as string);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain((sha["f-bad"] as string).slice(0, 7));
    expect(r.out).not.toContain((sha["bad"] as string).slice(0, 7)); // کامیت بدِ main به این شاخه ربطی ندارد
  });

  it("تگِ تازه روی کامیتی که روی main است: بازهٔ تهی ⇒ سبز (چیز تازه‌ای نیست)", () => {
    const r = push(Z, sha["c"] as string);
    expect(r.code, r.out).toBe(0);
  });

  it("بدون پایهٔ قابل‌اتکا (شاخهٔ پیش‌فرضِ ناموجود) فقط خودِ کامیت سنجیده می‌شود", () => {
    expect(push(Z, sha["bad"] as string, { CI_DEFAULT_BRANCH: "nope" }).code).toBe(1);
    expect(push(Z, sha["c"] as string, { CI_DEFAULT_BRANCH: "nope" }).code).toBe(0);
  });

  it("ورودی‌های ناقص ⇒ شکست روشن", () => {
    const r = ciRange({});
    expect(r.code).toBe(1);
    expect(r.out).toContain("SHA");
  });
});

describe("ci.yml: گام check-range", () => {
  const yml = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const stepsStart = yml.indexOf("    steps:");
  const stepNames = [...yml.slice(stepsStart).matchAll(/^ {6}- name: (.+)$/gm)].map((m) => (m[1] ?? "").trim());
  const stepBlock = (name: string): string => {
    const start = yml.indexOf(`- name: ${name}`);
    const next = yml.indexOf("\n      - name:", start + 1);
    return yml.slice(start, next === -1 ? undefined : next);
  };

  it("checkout با تاریخچهٔ کامل است (بدون آن پایهٔ بازه در کلون نیست)", () => {
    const co = stepBlock("Checkout");
    expect(co).toContain("actions/checkout@v4");
    expect(co).toMatch(/fetch-depth:\s*0\b/);
  });

  it("گام ci-range هست، پیش از نصب وابستگی‌ها و پیش از دروازهٔ تست می‌آید", () => {
    const i = stepNames.indexOf("Commit messages (check-range)");
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeGreaterThan(stepNames.indexOf("Setup Node.js")); // Node لازم است
    expect(i).toBeLessThan(stepNames.indexOf("Install dependencies (frozen lockfile)"));
    expect(i).toBeLessThan(stepNames.findIndex((n) => n.startsWith("Tests (zero-skip gate")));
  });

  it("گام فقط ci-range را اجرا می‌کند و همهٔ متغیرهای لازمِ planCiRange را از رویداد می‌گیرد", () => {
    const b = stepBlock("Commit messages (check-range)");
    expect(b).toContain("tooling/git-discipline.ts ci-range");
    for (const [name, expr] of [
      ["CI_EVENT_NAME", "github.event_name"],
      ["CI_PR_BASE_SHA", "github.event.pull_request.base.sha"],
      ["CI_PR_HEAD_SHA", "github.event.pull_request.head.sha"],
      ["CI_PUSH_BEFORE", "github.event.before"],
      ["CI_SHA", "github.sha"],
      ["CI_DEFAULT_BRANCH", "github.event.repository.default_branch"],
    ] as const) {
      expect(b, name).toContain(`${name}: \${{ ${expr} }}`);
    }
  });

  it("دورزدنی نیست: نه continue-on-error، نه شرط if روی این گام (و در کل فایل continue-on-error نیست)", () => {
    expect(yml).not.toMatch(/continue-on-error/);
    expect(stepBlock("Commit messages (check-range)")).not.toMatch(/^\s+if:/m);
  });
});

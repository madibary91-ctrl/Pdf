import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkCommitMessage,
  checkCommitPolicy,
  checkPushUpdates,
  checkStagedHygiene,
  checkTagName,
  cleanMessage,
  extractMinPassed,
  findSecrets,
  isDocsOnly,
  isHighRiskPath,
  moduleOf,
  parseAddedLines,
  parseCommitMessage,
  parseNameStatusZ,
  parsePushLines,
  stripLiteralsAndComments,
  type PolicyInput,
  type PushGit,
  type StagedEntry,
} from "./git-discipline";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rules = (vs: readonly { rule: string }[]): string[] => vs.map((v) => v.rule);
const GOOD_BODY = "این تغییر لازم است چون پایگاه بدون آن نمی‌تواند جست‌وجو کند.";

describe("پیام کامیت", () => {
  it("پیام‌های واقعیِ تاریخچهٔ این مخزن همه می‌خوانند", () => {
    for (const h of [
      "ci: GitHub Actions pipeline with zero-skip gate for real-PostgreSQL tests",
      "fix(ci): stop flaky 5s test timeouts, make CI failures diagnosable",
      "feat(legal-kb): trust workflow, audit trail and incremental insert (part 4B-2)",
      "feat(legal-kb): PostgreSQL store (part 4B-1)",
    ]) {
      const msg = BODY_REQUIRED_FOR(h) ? `${h}\n\n${GOOD_BODY}` : h;
      expect(checkCommitMessage(msg), h).toEqual([]);
    }
  });

  it("قالب سرایند را می‌سنجد", () => {
    expect(rules(checkCommitMessage("update stuff"))).toContain("header-format");
    expect(rules(checkCommitMessage("Feat: x"))).toContain("header-format");
    expect(rules(checkCommitMessage("feat(Scope): x"))).toContain("header-format");
    expect(rules(checkCommitMessage("feat:x"))).toContain("header-format");
    expect(rules(checkCommitMessage("wibble(core): do it"))).toContain("header-type");
    expect(checkCommitMessage("docs: توضیح قواعد گیت")).toEqual([]);
    expect(checkCommitMessage("docs(git)!: توضیح")).toEqual([]);
  });

  it("سقف طول سرایند دقیقاً ۱۰۰", () => {
    const head = (n: number) => `docs: ${"x".repeat(n - 6)}`;
    expect(checkCommitMessage(head(100))).toEqual([]);
    expect(rules(checkCommitMessage(head(101)))).toContain("header-length");
  });

  it("موضوع خالی، نقطهٔ پایانی و WIP/fixup رد می‌شود", () => {
    expect(rules(checkCommitMessage("docs: "))).toContain("header-format");
    expect(rules(checkCommitMessage("docs:"))).toContain("header-format");
    expect(rules(checkCommitMessage("docs: done."))).toContain("subject-period");
    expect(rules(checkCommitMessage("chore: WIP save"))).toContain("no-wip");
    expect(rules(checkCommitMessage("chore: wip"))).toContain("no-wip");
    expect(rules(checkCommitMessage("fixup! feat: x"))).toContain("no-wip");
    expect(rules(checkCommitMessage("chore: wipe cache"))).not.toContain("no-wip");
  });

  it("خط خالی بین سرایند و بدنه لازم است", () => {
    expect(rules(checkCommitMessage("docs: a\nبدنه بلافاصله"))).toContain("blank-after-header");
    expect(checkCommitMessage("docs: a\n\nبدنه")).toEqual([]);
  });

  it("feat/fix/refactor/perf بدنهٔ توضیحی می‌خواهند؛ docs/test/chore نه", () => {
    for (const t of ["feat", "fix", "refactor", "perf"]) expect(rules(checkCommitMessage(`${t}(x): y`)), t).toContain("body-required");
    for (const t of ["docs", "test", "chore", "ci", "build", "revert"]) expect(checkCommitMessage(`${t}: y`), t).toEqual([]);
    expect(rules(checkCommitMessage("feat: y\n\nکوتاه"))).toContain("body-required");
    expect(checkCommitMessage(`feat: y\n\n${GOOD_BODY}`)).toEqual([]);
  });

  it("trailer به‌تنهایی بدنه حساب نمی‌شود", () => {
    expect(rules(checkCommitMessage("feat: y\n\nMulti-Module: به دلیل یک و دو و سه"))).toContain("body-required");
  });

  it("پیام خالی و فقط‌توضیح رد می‌شود؛ خط‌های # حذف می‌شوند", () => {
    expect(rules(checkCommitMessage(""))).toEqual(["message-empty"]);
    expect(rules(checkCommitMessage("# فقط توضیح گیت\n# دیگر"))).toEqual(["message-empty"]);
    expect(cleanMessage("docs: a\r\n# c\r\n\r\n")).toBe("docs: a");
  });

  it("Merge/Revert خودکار گیت لینت قالب نمی‌شود", () => {
    expect(checkCommitMessage("Merge branch 'x' into main")).toEqual([]);
    expect(checkCommitMessage('Revert "feat: x"\n\nThis reverts commit abc.')).toEqual([]);
  });

  it("trailerها تجزیه و اعتبارسنجی می‌شوند", () => {
    const p = parseCommitMessage(`feat(a): b\n\n${GOOD_BODY}\n\nRisk-Tag: pre-risk/20250101-x\nTest-Change-Approved: تأیید مالک معماری`);
    expect(p.trailers).toEqual({ "Risk-Tag": "pre-risk/20250101-x", "Test-Change-Approved": "تأیید مالک معماری" });
    expect(p.body).toBe(GOOD_BODY);
    expect(p.scope).toBe("a");
    expect(rules(checkCommitMessage(`docs: a\n\nRisk-Tag: green/x`))).toContain("trailer-risk-tag");
    expect(rules(checkCommitMessage(`docs: a\n\nRisk-Tag: foo`))).toContain("trailer-risk-tag");
    expect(rules(checkCommitMessage(`docs: a\n\nTest-Change-Approved: ok`))).toContain("trailer-reason");
    expect(rules(checkCommitMessage(`docs: a\n\nGate-Floor-Lowered: short`))).toContain("trailer-reason");
    expect(rules(checkCommitMessage(`docs: a\n\nMulti-Module: short`))).toContain("trailer-reason");
    expect(checkCommitMessage(`docs: a\n\nMulti-Module: دو ماژول جدانشدنی`)).toEqual([]);
  });

  it("پاراگراف آخرِ مخلوط (نه همه trailer) بدنه است", () => {
    const p = parseCommitMessage("docs: a\n\nخط اول: دوم\nجمله‌ای عادی");
    expect(p.trailers).toEqual({});
    expect(p.body).toContain("جمله‌ای عادی");
  });
});

describe("نام تگ", () => {
  it("فقط دو خانوادهٔ مجاز", () => {
    for (const ok of ["pre-risk/20250131-search-migration", "pre-risk/20241201-a", "green/4b-3", "green/part-4b.3"]) expect(checkTagName(ok), ok).toBeNull();
    for (const bad of ["v1.0", "pre-risk/2025-01-01-x", "pre-risk/20251301-x", "pre-risk/20250100-x", "pre-risk/20250132-x", "pre-risk/20250101-", "pre-risk/20250101-X", "green/", "green/UPPER", "release/1", "pre-risk/20250101-a_b", ""]) {
      expect(checkTagName(bad), bad).not.toBeNull();
    }
  });
});

describe("مسیرهای پرریسک", () => {
  it("کد پرریسک بله؛ تست و README نه", () => {
    for (const p of [
      "src/modules/legal-kb-store/migrations.ts",
      "src/modules/legal-kb-store/search.ts",
      "src/modules/jalali-date/calendar.ts",
      "src/modules/legal-calc/court-fee-tariffs.ts",
      "src/modules/registry.ts",
      "src/db/schema.ts",
      ".github/workflows/ci.yml",
      "tooling/ci-tests.ts",
      "tooling/git-discipline.ts",
      "tooling/git-hooks/pre-commit",
      "vitest.config.ts",
    ]) expect(isHighRiskPath(p), p).toBe(true);
    for (const p of [
      "src/modules/legal-kb-store/search.test.ts",
      "src/modules/legal-calc/README.md",
      "src/modules/persian-text/normalize.ts",
      "src/app/page.tsx",
      "docs/adr/0008-git-discipline.md",
      "AGENTS.md",
      "tooling/boundaries.ts",
    ]) expect(isHighRiskPath(p), p).toBe(false);
  });

  it("همگام با docs/high-risk-areas.md: هر مسیر src/… که آنجا آمده پرریسک است", () => {
    const doc = readFileSync(join(ROOT, "docs/high-risk-areas.md"), "utf8");
    const tokens = [...doc.matchAll(/`(src\/[^`\s]+)`/g)].map((m) => m[1] as string);
    expect(tokens.length).toBeGreaterThanOrEqual(5);
    for (const t of tokens) {
      const sample = t.endsWith("/") ? `${t}index.ts` : t;
      expect(isHighRiskPath(sample), t).toBe(true);
    }
  });

  it("moduleOf و isDocsOnly", () => {
    expect(moduleOf("src/modules/legal-kb-store/a.ts")).toBe("legal-kb-store");
    expect(moduleOf("src/modules/registry.ts")).toBeNull();
    expect(moduleOf("tooling/x.ts")).toBeNull();
    expect(isDocsOnly(["AGENTS.md", "docs/adr/x.md", "docs/a.txt"])).toBe(true);
    expect(isDocsOnly(["AGENTS.md", "src/a.ts"])).toBe(false);
    expect(isDocsOnly([])).toBe(false);
  });
});

describe("بهداشت محتوای مرحله‌بندی‌شده", () => {
  const e = (path: string, status = "A"): StagedEntry => ({ status, path });
  it("فایل‌های ممنوع", () => {
    for (const p of [".env", ".env.local", "a/.env.production", "k.pem", "x/id.key", "test-results/r.json", ".next/x.js", "node_modules/a/b.js", "tsconfig.tsbuildinfo", ".DS_Store"]) {
      expect(rules(checkStagedHygiene([e(p)], {})), p).toEqual(["forbidden-path"]);
    }
    for (const p of [".env.example", "src/environment.ts", "docs/key.md"]) expect(checkStagedHygiene([e(p)], {}), p).toEqual([]);
    expect(checkStagedHygiene([e(".env", "D")], {})).toEqual([]); // حذفِ فایل ممنوع اشکال ندارد
  });

  it("رازها (نمونه‌ها در تست قطعه‌قطعه ساخته می‌شوند تا خودِ تست راز نباشد)", () => {
    const pk = "-----BEGIN " + "RSA PRIVATE " + "KEY-----";
    const gh = "gh" + "p_" + "a".repeat(36);
    const aws = "AK" + "IA" + "A".repeat(16);
    const sk = "s" + "k-" + "b".repeat(32);
    const conn = "postgres" + "ql://admin:hunter2@db.example.com:5432/app";
    expect(findSecrets([pk, gh, aws, sk, conn]).slice().sort()).toEqual(["توکن گیت‌هاب", "رشتهٔ اتصال با رمز", "کلید AWS", "کلید API (sk-)", "کلید خصوصی"].sort());
    expect(findSecrets(["postgresql://postgres:postgres@127.0.0.1:5432/app_db", "postgres://u:p@localhost/x", "const sk = 3", "ghp_short", "AKIAshort"])).toEqual([]);
    expect(rules(checkStagedHygiene([e("a.ts")], { "a.ts": [gh] }))).toEqual(["secret"]);
  });

  it("skip/only در تست‌ها ممنوع؛ todo و describe.skip بیرون از تست مجاز", () => {
    for (const l of ["it.only('a', () => {})", "  describe.skip('x', () => {", "test.skip(1)", "xit('a')", "xdescribe('a')", "fit('a')"]) {
      expect(rules(checkStagedHygiene([e("a.test.ts")], { "a.test.ts": [l] })), l).toEqual(["no-skip-only"]);
    }
    expect(checkStagedHygiene([e("a.test.ts")], { "a.test.ts": ["it.todo('منتظر حقوقدان')", "it('x', () => {})", "const fix = 1; // fit for use"] })).toEqual([]);
    // فراخوانی واقعی داخل بلوک/هم‌خط با کد دیگر هم گرفته می‌شود؛ ذکر در رشته یا توضیح نه
    for (const l of ['describe("x", () => { it.only("y", f); });', "const a = 1; test.skip('b', f);", "beforeEach(() => {}); xdescribe('z', f)", "it.skip.each([1])('x', f)"]) {
      expect(rules(checkStagedHygiene([e("a.test.ts")], { "a.test.ts": [l] })), l).toEqual(["no-skip-only"]);
    }
    expect(checkStagedHygiene([e("a.test.ts")], { "a.test.ts": ['const s = "it.only(";', "// نباید describe.skip( بماند", "for (const l of [\"it.only('a')\", \"xit('b')\"]) {}"] })).toEqual([]);
    expect(checkStagedHygiene([e("test-db.ts")], { "test-db.ts": ["export const dbDescribe = HAS_DB ? describe : describe.skip;"] })).toEqual([]);
  });
});

describe("stripLiteralsAndComments", () => {
  it("محتوای رشته تهی و توضیح حذف می‌شود؛ کد می‌ماند", () => {
    expect(stripLiteralsAndComments(`it.only("a it.only(", f); // x`)).toBe(`it.only("", f); `);
    expect(stripLiteralsAndComments("const s = 'it\\'s'; const t = `a${1}b`;")).toBe("const s = ''; const t = ``;");
    expect(stripLiteralsAndComments('const u = "http://x.y"; run();')).toBe('const u = ""; run();');
    expect(stripLiteralsAndComments("plain")).toBe("plain");
  });
});

describe("سیاست کامیت (وابسته به trailer)", () => {
  const base: PolicyInput = { entries: [], trailers: {}, riskTag: null, gateFloor: { before: null, after: null } };
  const withE = (entries: StagedEntry[], extra: Partial<PolicyInput> = {}): PolicyInput => ({ ...base, entries, ...extra });
  const a = (path: string): StagedEntry => ({ status: "A", path });
  const m = (path: string): StagedEntry => ({ status: "M", path });

  it("افزودن تست آزاد؛ تغییر/حذف/جابه‌جایی تستِ موجود بدون تأیید ممنوع (قانون آهنین)", () => {
    expect(checkCommitPolicy(withE([a("src/modules/persian-text/new.test.ts")]))).toEqual([]);
    expect(rules(checkCommitPolicy(withE([m("src/x.test.ts")])))).toEqual(["existing-test-changed"]);
    expect(rules(checkCommitPolicy(withE([{ status: "D", path: "src/x.test.ts" }])))).toEqual(["existing-test-changed"]);
    expect(rules(checkCommitPolicy(withE([{ status: "R100", path: "src/y.ts", oldPath: "src/x.test.ts" }])))).toEqual(["existing-test-changed"]);
    expect(rules(checkCommitPolicy(withE([{ status: "T", path: "src/x.test.ts" }])))).toEqual(["existing-test-changed"]);
    expect(checkCommitPolicy(withE([m("src/x.test.ts")], { trailers: { "Test-Change-Approved": "مالک معماری تأیید کرد" } }))).toEqual([]);
  });

  it("ناحیهٔ پرریسک: تگ لازم، معتبر و دیده‌شده", () => {
    const risky = [m("src/modules/legal-kb-store/migrations.ts")];
    expect(rules(checkCommitPolicy(withE(risky)))).toEqual(["risk-tag-missing"]);
    expect(rules(checkCommitPolicy(withE(risky, { riskTag: { ok: false, reason: "نیست" } })))).toEqual(["risk-tag-invalid"]);
    expect(checkCommitPolicy(withE(risky, { riskTag: { ok: true, reason: "" } }))).toEqual([]);
    expect(rules(checkCommitPolicy(withE([{ status: "R090", path: "src/z.ts", oldPath: "src/db/a.ts" }])))).toEqual(["risk-tag-missing"]);
    expect(checkCommitPolicy(withE([m("src/modules/legal-kb-store/README.md"), a("src/modules/legal-kb-store/x.test.ts")]))).toEqual([]);
  });

  it("چند ماژول در یک کامیت: دلیل لازم؛ registry و tooling ماژول نیستند", () => {
    const two = [m("src/modules/persian-text/a.ts"), m("src/modules/jalali-date/b.ts")];
    expect(rules(checkCommitPolicy(withE(two, { riskTag: { ok: true, reason: "" } })))).toEqual(["multi-module"]);
    expect(checkCommitPolicy(withE(two, { riskTag: { ok: true, reason: "" }, trailers: { "Multi-Module": "تغییر هماهنگ ناگزیر" } }))).toEqual([]);
    expect(checkCommitPolicy(withE([m("src/modules/persian-text/a.ts"), m("tooling/boundaries.ts"), m("docs/a.md")]))).toEqual([]);
  });

  it("کف دروازهٔ تست پایین نمی‌آید", () => {
    const gate = [m("tooling/ci-tests.ts")];
    const ok = { ok: true, reason: "" };
    expect(checkCommitPolicy(withE(gate, { riskTag: ok, gateFloor: { before: 603, after: 650 } }))).toEqual([]);
    expect(checkCommitPolicy(withE(gate, { riskTag: ok, gateFloor: { before: 603, after: 603 } }))).toEqual([]);
    expect(rules(checkCommitPolicy(withE(gate, { riskTag: ok, gateFloor: { before: 603, after: 602 } })))).toEqual(["gate-floor-lowered"]);
    expect(checkCommitPolicy(withE(gate, { riskTag: ok, gateFloor: { before: 603, after: 500 }, trailers: { "Gate-Floor-Lowered": "حذف تست‌های منسوخ با تأیید" } }))).toEqual([]);
    expect(rules(checkCommitPolicy(withE(gate, { riskTag: ok, gateFloor: { before: 603, after: null } })))).toEqual(["gate-floor-unreadable"]);
  });

  it("extractMinPassed", () => {
    expect(extractMinPassed("export const MIN_PASSED_TESTS = 603;")).toBe(603);
    expect(extractMinPassed("x\nexport const MIN_PASSED_TESTS=7;\n")).toBe(7);
    expect(extractMinPassed("const MIN_PASSED_TESTS = 603;")).toBeNull();
    expect(extractMinPassed(null)).toBeNull();
    expect(extractMinPassed(readFileSync(join(ROOT, "tooling/ci-tests.ts"), "utf8"))).toBeGreaterThanOrEqual(603);
  });
});

describe("پوش", () => {
  const Z = "0".repeat(40);
  const S1 = "1".repeat(40);
  const S2 = "2".repeat(40);
  const S3 = "3".repeat(40);
  const fakeGit = (o: Partial<PushGit> = {}): PushGit => ({ isAncestor: () => true, objectExists: () => true, objectType: () => "commit", ...o });
  const up = (remoteRef: string, localSha: string, remoteSha: string) => ({ localRef: "x", localSha, remoteRef, remoteSha });

  it("fast-forward و شاخهٔ تازه مجاز و دروازه می‌خواهد", () => {
    expect(checkPushUpdates([up("refs/heads/main", S2, S1)], fakeGit())).toEqual({ violations: [], needsGate: true });
    expect(checkPushUpdates([up("refs/heads/feat/x", S2, Z)], fakeGit())).toEqual({ violations: [], needsGate: true });
  });
  it("بازنویسی تاریخچه (non-fast-forward) و راه دورِ ناشناخته رد می‌شود", () => {
    expect(rules(checkPushUpdates([up("refs/heads/main", S2, S1)], fakeGit({ isAncestor: () => false })).violations)).toEqual(["push-force"]);
    expect(rules(checkPushUpdates([up("refs/heads/main", S2, S1)], fakeGit({ objectExists: () => false })).violations)).toEqual(["push-fetch-first"]);
  });
  it("حذف هر ref ممنوع", () => {
    expect(rules(checkPushUpdates([up("refs/heads/main", Z, S1)], fakeGit()).violations)).toEqual(["push-delete"]);
    expect(rules(checkPushUpdates([up("refs/tags/green/x", Z, S1)], fakeGit()).violations)).toEqual(["push-delete"]);
  });
  it("تگ: نام معتبر، حاشیه‌دار، و جابه‌جا نشدن", () => {
    const annotated = fakeGit({ objectType: () => "tag" });
    expect(checkPushUpdates([up("refs/tags/green/4b-3", S2, Z)], annotated)).toEqual({ violations: [], needsGate: false });
    expect(checkPushUpdates([up("refs/tags/green/4b-3", S2, S2)], annotated).violations).toEqual([]); // دوباره‌پوشِ همان تگ
    expect(rules(checkPushUpdates([up("refs/tags/green/4b-3", S3, S2)], annotated).violations)).toEqual(["tag-move"]);
    expect(rules(checkPushUpdates([up("refs/tags/green/4b-3", S2, Z)], fakeGit()).violations)).toEqual(["tag-lightweight"]);
    expect(rules(checkPushUpdates([up("refs/tags/v1", S2, Z)], annotated).violations)).toEqual(["tag-name"]);
  });
  it("parsePushLines", () => {
    expect(parsePushLines(`refs/heads/a ${S1} refs/heads/a ${Z}\n\n`)).toEqual([{ localRef: "refs/heads/a", localSha: S1, remoteRef: "refs/heads/a", remoteSha: Z }]);
    expect(parsePushLines("")).toEqual([]);
  });
});

describe("تجزیهٔ خروجی git", () => {
  it("name-status -z (شامل مسیر فارسی و rename)", () => {
    const out = ["A", "docs/یادداشت.md", "M", "src/a.ts", "R087", "old.test.ts", "new.ts", "D", "gone.ts", ""].join("\0");
    expect(parseNameStatusZ(out)).toEqual([
      { status: "A", path: "docs/یادداشت.md" },
      { status: "M", path: "src/a.ts" },
      { status: "R087", path: "new.ts", oldPath: "old.test.ts" },
      { status: "D", path: "gone.ts" },
    ]);
    expect(parseNameStatusZ("")).toEqual([]);
  });
  it("خط‌های افزوده‌شده (بدون سرایندها و بدون خط‌های حذف‌شده)", () => {
    const diff = ["diff --git a/x.ts b/x.ts", "--- a/x.ts", "+++ b/x.ts", "@@ -1 +1,2 @@", "-old", "+new", "++plus", "diff --git a/g.ts b/g.ts", "--- a/g.ts", "+++ /dev/null", "-gone", ""].join("\n");
    expect(parseAddedLines(diff)).toEqual({ "x.ts": ["new", "+plus"] });
  });
});

// ───────── یکپارچگی روی مخزن موقت: خودِ CLI و خودِ هوک ─────────

const NODE_FLAGS = ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON"];
const TOOL = join(ROOT, "tooling/git-discipline.ts");
const HOOKS = join(ROOT, "tooling/git-hooks");

describe("هوک‌ها در مخزن گیتِ موقت", () => {
  let dir = "";
  const git = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    return { code: r.status ?? -1, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
  };
  const cli = (args: string[], input?: string) => {
    const r = spawnSync(process.execPath, [...NODE_FLAGS, TOOL, ...args], { cwd: dir, encoding: "utf8", ...(input === undefined ? {} : { input }) });
    return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };
  const write = (rel: string, text: string) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  const msgFile = (text: string) => {
    write(".git/msg.txt", text);
    return join(dir, ".git/msg.txt");
  };
  const commitRaw = (message: string) => git("-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", message);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "git-discipline-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    git("config", "commit.gpgsign", "false");
    git("config", "tag.gpgsign", "false");
    write("README.md", "x\n");
    write("src/modules/a-mod/a.test.ts", "it('x')\n");
    write("src/modules/a-mod/a.ts", "export {}\n");
    git("add", "-A");
    expect(commitRaw("chore: initial").code).toBe(0);
  }, 30_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("commit-msg: پیام بد رد، پیام خوب پذیرفته", () => {
    write("docs/n.md", "n\n");
    git("add", "docs/n.md");
    const bad = cli(["commit-msg", msgFile("update stuff\n")]);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("header-format");
    expect(cli(["commit-msg", msgFile("docs: یادداشت\n")]).code).toBe(0);
    git("reset", "-q");
  });

  it("خودِ git commit با هوک‌های واقعی: پیام بد رد، پیام خوبِ مستند پذیرفته (pre-commit بدون دروازه)", () => {
    write("docs/n2.md", "n2\n");
    git("add", "docs/n2.md");
    const bad = git("-c", `core.hooksPath=${HOOKS}`, "commit", "-q", "-m", "stuff");
    expect(bad.code).not.toBe(0);
    expect(bad.err).toContain("header-format");
    const good = git("-c", `core.hooksPath=${HOOKS}`, "commit", "-q", "-m", "docs: نخستین یادداشت");
    expect(good.code, good.err).toBe(0);
    expect(git("log", "-1", "--format=%s").out).toBe("docs: نخستین یادداشت");
  }, 30_000);

  it("pre-commit: فایل .env و راز حتی در کامیت مستند رد می‌شود", () => {
    write(".env", "A=1\n");
    git("add", "-f", ".env");
    const r = cli(["pre-commit"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("forbidden-path");
    git("reset", "-q");
    write("notes.md", "token " + "gh" + "p_" + "z".repeat(36) + "\n");
    git("add", "notes.md");
    const s = cli(["pre-commit"]);
    expect(s.code).toBe(1);
    expect(s.out).toContain("secret");
    git("reset", "-q");
    rmSync(join(dir, ".env"));
    rmSync(join(dir, "notes.md"));
  });

  it("pre-commit: کامیت فقط‌مستند دروازه را اجرا نمی‌کند", () => {
    write("docs/n3.md", "n3\n");
    git("add", "docs/n3.md");
    const r = cli(["pre-commit"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("فقط مستند");
    git("reset", "-q");
    rmSync(join(dir, "docs/n3.md"));
  });

  it("commit-msg: تغییر تستِ موجود بدون تأیید رد و با تأیید پذیرفته (قانون آهنین)", () => {
    write("src/modules/a-mod/a.test.ts", "it('changed')\n");
    git("add", "-A");
    const bad = cli(["commit-msg", msgFile("test(a-mod): تغییر\n")]);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("existing-test-changed");
    expect(cli(["commit-msg", msgFile("test(a-mod): تغییر\n\nTest-Change-Approved: مالک معماری تأیید کرد\n")]).code).toBe(0);
    git("reset", "-q", "--hard");
  });

  it("commit-msg: ناحیهٔ پرریسک — بدون تگ رد؛ تگ سبک رد؛ تگ حاشیه‌دار پیشینِ HEAD پذیرفته", () => {
    write("src/modules/legal-calc/x.ts", "export {}\n");
    git("add", "-A");
    const none = cli(["commit-msg", msgFile("docs: x\n")]);
    expect(none.out).toContain("risk-tag-missing");

    const trailer = (t: string) => `docs: x\n\nRisk-Tag: ${t}\n`;
    expect(cli(["commit-msg", msgFile(trailer("pre-risk/20250101-ghost"))]).out).toContain("وجود ندارد");

    git("tag", "pre-risk/20250101-light"); // سبک
    expect(cli(["commit-msg", msgFile(trailer("pre-risk/20250101-light"))]).out).toContain("حاشیه‌دار نیست");

    expect(git("tag", "-a", "pre-risk/20250101-ok", "-m", "قبل از تغییر").code).toBe(0);
    const ok = cli(["commit-msg", msgFile(trailer("pre-risk/20250101-ok"))]);
    expect(ok.code, ok.out).toBe(0);

    // تگی که پیشینِ HEAD نیست (روی شاخهٔ دیگر)
    git("stash", "-q", "-u");
    git("switch", "-q", "-c", "other");
    write("other.txt", "o\n");
    git("add", "-A");
    expect(commitRaw("chore: other").code).toBe(0);
    expect(git("tag", "-a", "pre-risk/20250101-elsewhere", "-m", "جای دیگر").code).toBe(0);
    git("switch", "-q", "main");
    git("stash", "pop", "-q");
    git("add", "-A");
    expect(cli(["commit-msg", msgFile(trailer("pre-risk/20250101-elsewhere"))]).out).toContain("پیشینِ HEAD نیست");
    git("reset", "-q", "--hard");
    git("clean", "-fdq");
  }, 30_000);

  it("commit-msg: کاهش MIN_PASSED_TESTS بدون دلیل رد می‌شود", () => {
    write("tooling/ci-tests.ts", "export const MIN_PASSED_TESTS = 100;\n");
    git("add", "-A");
    commitRaw("chore: floor");
    git("tag", "-a", "pre-risk/20250102-floor", "-m", "m");
    write("tooling/ci-tests.ts", "export const MIN_PASSED_TESTS = 90;\n");
    git("add", "-A");
    const t = (extra: string) => `chore: floor\n\nRisk-Tag: pre-risk/20250102-floor\n${extra}`;
    expect(cli(["commit-msg", msgFile(t(""))]).out).toContain("gate-floor-lowered");
    expect(cli(["commit-msg", msgFile(t("Gate-Floor-Lowered: حذف تست‌های منسوخ با تأیید\n"))]).code).toBe(0);
    git("reset", "-q", "--hard");
  });

  it("pre-push: بازنویسی تاریخچه، حذف و جابه‌جایی تگ رد می‌شود", () => {
    const head = git("rev-parse", "HEAD").out;
    const root = git("rev-list", "--max-parents=0", "HEAD").out;
    const Z = "0".repeat(40);
    // «راه دور» قبلاً HEAD را داشته و حالا می‌خواهیم به ریشه برگردیم ⇒ non-fast-forward
    expect(cli(["pre-push", "origin", "url"], `refs/heads/main ${root} refs/heads/main ${head}\n`).out).toContain("push-force");
    expect(cli(["pre-push", "origin", "url"], `(delete) ${Z} refs/heads/main ${head}\n`).out).toContain("push-delete");
    const tagSha = git("rev-parse", "pre-risk/20250102-floor").out;
    expect(cli(["pre-push", "origin", "url"], `refs/tags/pre-risk/20250102-floor ${tagSha} refs/tags/pre-risk/20250102-floor ${head}\n`).out).toContain("tag-move");
    expect(cli(["pre-push", "origin", "url"], `refs/tags/pre-risk/20250101-light ${git("rev-parse", "pre-risk/20250101-light").out} refs/tags/pre-risk/20250101-light ${Z}\n`).out).toContain("tag-lightweight");
  });

  it("pre-push: پوش تگ حاشیه‌دارِ معتبر بدون اجرای دروازه پذیرفته می‌شود", () => {
    const sha = git("rev-parse", "pre-risk/20250102-floor").out;
    const r = cli(["pre-push", "origin", "url"], `refs/tags/pre-risk/20250102-floor ${sha} refs/tags/pre-risk/20250102-floor ${"0".repeat(40)}\n`);
    expect(r.code, r.out).toBe(0);
  });

  it("check-range و check-tag و install/doctor", () => {
    const first = git("rev-list", "--max-parents=0", "HEAD").out;
    expect(cli(["check-range", `${first}..HEAD`]).code).toBe(0);
    write("sloppy.txt", "s\n");
    git("add", "-A");
    expect(commitRaw("sloppy message").code).toBe(0);
    const r = cli(["check-range", `${first}..HEAD`]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("header-format");
    expect(cli(["check-tag", "green/ok"]).code).toBe(0);
    expect(cli(["check-tag", "v1"]).code).toBe(1);
    expect(cli(["doctor"]).code).toBe(1);
    expect(cli(["install"]).code).toBe(0);
    expect(git("config", "--get", "core.hooksPath").out).toBe("tooling/git-hooks");
    expect(cli(["doctor"]).code).toBe(0);
    expect(cli(["bogus"]).code).toBe(1);
  });
});

function BODY_REQUIRED_FOR(header: string): boolean {
  return /^(feat|fix|refactor|perf)\b/.test(header);
}

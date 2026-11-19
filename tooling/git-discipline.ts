/**
 * «انضباط گیت» (Git Discipline) — بخش اجرایی قواعد AGENTS.md و ADR-0008.
 *
 * قاعده‌ای که اجرا نشود پیشنهاد است، نه قاعده. این فایل سه چیز دارد:
 *   ۱. توابع **خالص** (بدون I/O) که هر قاعده را می‌سنجند؛ همه در `tooling/git-discipline.test.ts` آزموده می‌شوند.
 *   ۲. لایهٔ نازک اجرا (`git`، فایل) که فقط داده را جمع می‌کند و به توابع خالص می‌دهد.
 *   ۳. دستورهای خط فرمان که هوک‌های `tooling/git-hooks/*` صدا می‌زنند.
 *
 * اجرا: node tooling/git-discipline.ts <install|doctor|commit-msg|pre-commit|pre-push|check-range|ci-range|check-tag>
 *   (Node ≥ 22.18؛ مثل `ci-tests.ts` بدون وابستگی تازه.)
 *
 * صادقانه: هوک‌های محلی را می‌شود با `--no-verify` دور زد؛ دروازهٔ نهایی همچنان CI و Branch protection است.
 * دورزدن عمدی خودش ممنوع است (AGENTS.md، بخش «انضباط گیت»، قاعدهٔ G3).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ───────────────────────── نوع‌ها ─────────────────────────

export type Violation = Readonly<{ rule: string; message: string }>;
const viol = (rule: string, message: string): Violation => ({ rule, message });

export type Trailers = Readonly<Record<string, string>>;
export type ParsedMessage = Readonly<{
  /** `null` یعنی سرایند با قالب نخواند (یا پیام Merge/Revert خودکار گیت است). */
  type: string | null;
  scope: string | null;
  subject: string;
  header: string;
  body: string;
  trailers: Trailers;
  /** بین سرایند و بدنه خط خالی هست؟ (بدنه نباشد = درست) */
  blankAfterHeader: boolean;
  /** پیام خودکار گیت (Merge …/Revert "…") که لینت قالب را رد می‌کند. */
  automatic: boolean;
}>;

export type StagedEntry = Readonly<{ status: string; path: string; oldPath?: string }>;

// ───────────────────────── پیام کامیت ─────────────────────────

export const COMMIT_TYPES = ["feat", "fix", "refactor", "perf", "test", "docs", "build", "ci", "chore", "revert"] as const;
/** نوع‌هایی که باید «چرا» را در بدنه توضیح دهند. */
export const BODY_REQUIRED_TYPES: readonly string[] = ["feat", "fix", "refactor", "perf"];
export const HEADER_MAX = 100;
export const BODY_MIN_CHARS = 20;

const HEADER_RE = /^([a-z]+)(?:\(([a-z0-9][a-z0-9/_-]*)\))?(!)?: (.*)$/;
const TRAILER_RE = /^([A-Za-z][A-Za-z0-9-]*): (.+)$/;
const AUTOMATIC_RE = /^(Merge (branch|pull request|remote-tracking branch|tag) |Revert ")/;

/** خط‌های توضیح (`# …`) که گیت در ویرایشگر می‌گذارد حذف می‌شوند؛ پایان خطوط یکسان می‌شود. */
export function cleanMessage(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((l) => !l.startsWith("#"))
    .join("\n")
    .replace(/\s+$/, "");
}

export function parseCommitMessage(raw: string): ParsedMessage {
  const text = cleanMessage(raw);
  const lines = text.split("\n");
  const header = (lines[0] ?? "").trimEnd();
  const automatic = AUTOMATIC_RE.test(header);
  const m = HEADER_RE.exec(header);
  const rest = lines.slice(1);
  const blankAfterHeader = rest.length === 0 || (rest[0] ?? "") === "";

  // پاراگراف آخر اگر همه‌اش `Key: value` باشد = trailer
  const paragraphs = rest.join("\n").split(/\n{2,}/).map((p) => p.replace(/^\n+|\n+$/g, "")).filter((p) => p !== "");
  const last = paragraphs[paragraphs.length - 1];
  const trailers: Record<string, string> = {};
  let bodyParagraphs = paragraphs;
  if (last !== undefined && last.split("\n").every((l) => TRAILER_RE.test(l))) {
    for (const l of last.split("\n")) {
      const t = TRAILER_RE.exec(l);
      if (t && t[1] !== undefined && t[2] !== undefined) trailers[t[1]] = t[2].trim();
    }
    bodyParagraphs = paragraphs.slice(0, -1);
  }
  return {
    type: m?.[1] ?? null,
    scope: m?.[2] ?? null,
    subject: m?.[4] ?? header,
    header,
    body: bodyParagraphs.join("\n\n"),
    trailers,
    blankAfterHeader,
    automatic,
  };
}

export const TRAILER_KEYS = ["Risk-Tag", "Test-Change-Approved", "Gate-Floor-Lowered", "Multi-Module"] as const;
const REASON_MIN = 10;

export function checkCommitMessage(raw: string): readonly Violation[] {
  const out: Violation[] = [];
  if (cleanMessage(raw).trim() === "") return [viol("message-empty", "پیام کامیت خالی است.")];
  const p = parseCommitMessage(raw);
  if (p.automatic) return out; // Merge/Revert خودکارِ گیت
  if (p.type === null) {
    out.push(viol("header-format", `سرایند باید «type(scope): subject» باشد (type از: ${COMMIT_TYPES.join("، ")})؛ دریافت شد: «${p.header}»`));
  } else if (!(COMMIT_TYPES as readonly string[]).includes(p.type)) {
    out.push(viol("header-type", `نوع «${p.type}» مجاز نیست؛ مجاز: ${COMMIT_TYPES.join("، ")}`));
  }
  if (p.header.length > HEADER_MAX) out.push(viol("header-length", `سرایند ${p.header.length} نویسه است؛ سقف ${HEADER_MAX}.`));
  if (p.type !== null) {
    if (/[.。]$/.test(p.subject.trim())) out.push(viol("subject-period", "موضوع نباید با نقطه تمام شود."));
  }
  if (/^(wip|fixup!|squash!|amend!)\b/i.test(p.subject.trim()) || /^(wip|fixup!|squash!|amend!)/i.test(p.header)) {
    out.push(viol("no-wip", "کامیت WIP/fixup/squash ممنوع است؛ کار نیمه‌کاره کامیت نمی‌شود (قاعدهٔ G2)."));
  }
  if (!p.blankAfterHeader) out.push(viol("blank-after-header", "بین سرایند و بدنه باید یک خط خالی باشد."));
  if (p.type !== null && BODY_REQUIRED_TYPES.includes(p.type) && p.body.replace(/\s+/g, "").length < BODY_MIN_CHARS) {
    out.push(viol("body-required", `برای «${p.type}» بدنه لازم است (دست‌کم ${BODY_MIN_CHARS} نویسه): چرا این تغییر؟`));
  }
  for (const [key, value] of Object.entries(p.trailers)) {
    if (key === "Risk-Tag") {
      if (checkTagName(value) !== null || !value.startsWith("pre-risk/")) out.push(viol("trailer-risk-tag", `Risk-Tag باید نام تگ «pre-risk/…» معتبر باشد؛ دریافت شد: «${value}»`));
    } else if (key === "Test-Change-Approved" || key === "Gate-Floor-Lowered" || key === "Multi-Module") {
      if (value.length < REASON_MIN) out.push(viol("trailer-reason", `${key} باید دلیل دست‌کم ${REASON_MIN} نویسه‌ای داشته باشد.`));
    }
  }
  return out;
}

// ───────────────────────── تگ‌ها ─────────────────────────

const PRE_RISK_RE = /^pre-risk\/(\d{4})(\d{2})(\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const GREEN_RE = /^green\/[a-z0-9]+(?:[-.][a-z0-9]+)*$/;

/** `null` = نام معتبر است. تگ‌ها فقط دو خانواده دارند: `pre-risk/YYYYMMDD-slug` و `green/slug`. */
export function checkTagName(name: string): Violation | null {
  const m = PRE_RISK_RE.exec(name);
  if (m) {
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return viol("tag-date", `تاریخ در نام تگ «${name}» نامعتبر است.`);
    return null;
  }
  if (GREEN_RE.test(name)) return null;
  return viol("tag-name", `نام تگ «${name}» مجاز نیست؛ فقط «pre-risk/YYYYMMDD-slug» یا «green/slug» (حروف کوچک لاتین، عدد، -).`);
}

// ───────────────────────── مسیرهای پرریسک ─────────────────────────

/**
 * ماژول‌هایی که تغییرِ کدشان بازبینی انسانی و نقطهٔ برگشت می‌خواهد (G8)؛ منبعِ واحدِ regexِ `HIGH_RISK`.
 * ناوردا (آزمونِ `tooling/high-risk-registry-sync.test.ts`، ADR-0027): هر ماژولِ `humanReview:true` در registry اینجا هست
 * و هر نامِ این‌جا در registry هست و یا `humanReview:true` دارد یا در `HIGH_RISK_BEYOND_REGISTRY` با دلیل آمده.
 * فقط نامِ ماژول (`[a-z0-9-]`)؛ بی‌escape در regex ساخته می‌شود و آزمون اعتبارِ نام‌ها را می‌سنجد.
 */
export const HIGH_RISK_MODULES: readonly string[] = [
  "jalali-date",
  "legal-calc",
  "finance-calc",
  "legal-kb-schema",
  "legal-kb-store",
  "citation-verifier",
  "shared-types",
  "ledger",
  "identity",
  "api",
  "ocr-pipeline",
  "desktop-db",
  "desktop-finance",
  // ADR-0027: شکافِ registry ⇒ regex (هر ۱۱ ماژولِ humanReview:true که بیرون مانده بودند)
  "metering",
  "settlement",
  "settlement-runtime",
  "settlement-host",
  "ai-orchestrator",
  "doc-templates-core",
  "legal-kb-ingest",
  "eval-set",
  "doc-editing-tools",
  "desktop-shell",
  "desktop-backup",
  "desktop-license",
  "desktop-updater",
];

/** پرریسکِ عمداً محافظه‌کارانه‌تر از registry (`humanReview:false`)؛ هر ورودی دلیل دارد و آزمون کهنه‌شدنش را می‌گیرد. */
export const HIGH_RISK_BEYOND_REGISTRY: Readonly<Record<string, string>> = {
  "shared-types": "قرارداد مشترکِ همهٔ ماژول‌ها (AGENTS بند ۶)؛ تغییرش بی‌تأییدِ معماری ممنوع است.",
  "legal-kb-store": "مهاجرتِ SQL و مسیرِ اعتماد/ممیزیِ دانش (ADR-0004، ADR-0005)؛ خرابیِ قید = استنادِ جعلی.",
};

/**
 * همسو با docs/high-risk-areas.md (آزمونِ همگامی در git-discipline.test.ts).
 * فقط کدِ غیرتست و غیرمستند: افزودن تست یا README به ناحیهٔ پرریسک تگ نمی‌خواهد.
 */
const HIGH_RISK: readonly RegExp[] = [
  new RegExp(`^src/modules/(${HIGH_RISK_MODULES.join("|")})/`),
  /^src\/modules\/registry\.ts$/,
  /^src\/db\//,
  /^drizzle\.config\.json$/,
  /^\.github\/workflows\//,
  /^tooling\/(ci-tests|git-discipline)\.ts$/,
  /^tooling\/git-hooks\//,
  /^vitest\.config\.ts$/,
];

export const isTestPath = (p: string): boolean => /\.test\.ts$/.test(p);
const isDocPath = (p: string): boolean => /\.md$/.test(p) || p.startsWith("docs/");

export function isHighRiskPath(path: string): boolean {
  if (isTestPath(path) || /\.md$/.test(path)) return false;
  return HIGH_RISK.some((re) => re.test(path));
}

export function moduleOf(path: string): string | null {
  const m = /^src\/modules\/([a-z0-9-]+)\//.exec(path);
  return m?.[1] ?? null;
}

/** کامیتِ فقط‌مستند؟ (آزمون/تایپ/لینت نمی‌خواهد.) */
export function isDocsOnly(paths: readonly string[]): boolean {
  return paths.length > 0 && paths.every(isDocPath);
}

// ───────────────────────── محتوای مرحله‌بندی‌شده ─────────────────────────

const FORBIDDEN_PATHS: readonly RegExp[] = [
  /(^|\/)\.env(\.(?!example$)[^/]*)?$/,
  /\.(pem|key|p12|pfx)$/,
  /^test-results\//,
  /^\.next\//,
  /(^|\/)node_modules\//,
  /tsconfig\.tsbuildinfo$/,
  /(^|\/)\.DS_Store$/,
];

const SECRET_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["کلید خصوصی", new RegExp("-----BEGIN (?:[A-Z]+ )?PRIVATE " + "KEY-----")],
  ["توکن گیت‌هاب", new RegExp("\\bgh[pousr]_[A-Za-z0-9]{36,}")],
  ["کلید AWS", new RegExp("\\bAKIA[0-9A-Z]{16}\\b")],
  ["کلید API (sk-)", new RegExp("\\bsk-[A-Za-z0-9]{32,}")],
  // رشتهٔ اتصال با رمز به میزبانی جز لوکال (CI از postgres:postgres@127.0.0.1 استفاده می‌کند و مجاز است)
  ["رشتهٔ اتصال با رمز", new RegExp("postgres(?:ql)?://[^:\\s/@]+:[^@\\s]+@(?!127\\.0\\.0\\.1|localhost|\\[::1\\])[^\\s/]+")],
];

export function findSecrets(lines: readonly string[]): readonly string[] {
  const found = new Set<string>();
  for (const line of lines) for (const [label, re] of SECRET_PATTERNS) if (re.test(line)) found.add(label);
  return [...found];
}

/**
 * فراخوانیِ واقعیِ skip/only: در آغاز عبارت (ابتدای خط یا پس از `{`، `;`، `=>`). روی خطی اعمال می‌شود که
 * `stripLiteralsAndComments` رشته‌ها و توضیح‌هایش را تهی کرده است.
 */
const SKIP_ONLY_RE = /(?:^|[;{}]|=>)\s*(?:(?:it|test|describe|suite)\.(?:only|skip)\b|x(?:it|describe|test)\s*\(|f(?:it|describe)\s*\()/;


/** محتوای رشته‌ها (`"…"`، `'…'`، `` `…` ``) را تهی و توضیح تک‌خطی را حذف می‌کند تا ذکرِ نام در داده/توضیح، فراخوانی حساب نشود. */
export function stripLiteralsAndComments(line: string): string {
  return line.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, "$1$1").replace(/\/\/.*$/, "");
}

export type AddedLines = Readonly<Record<string, readonly string[]>>;

/** بررسی‌های «بهداشت» که به پیام کامیت نیاز ندارند (در pre-commit). */
export function checkStagedHygiene(entries: readonly StagedEntry[], added: AddedLines): readonly Violation[] {
  const out: Violation[] = [];
  for (const e of entries) {
    if (e.status.startsWith("D")) continue;
    if (FORBIDDEN_PATHS.some((re) => re.test(e.path))) out.push(viol("forbidden-path", `فایل «${e.path}» نباید کامیت شود (اسرار/خروجی ساخت/ماشین‌ساخته).`));
  }
  for (const [file, lines] of Object.entries(added)) {
    const secrets = findSecrets(lines);
    if (secrets.length > 0) out.push(viol("secret", `در «${file}» نشانهٔ راز دیده شد (${secrets.join("، ")}). اسرار هرگز در مخزن نمی‌آیند.`));
    if (isTestPath(file) && lines.some((l) => SKIP_ONLY_RE.test(stripLiteralsAndComments(l)))) {
      out.push(viol("no-skip-only", `در «${file}» خط ‎.skip/.only/xit اضافه شده؛ سبز کردنِ تست با کنار گذاشتنش ممنوع است (G3).`));
    }
  }
  return out;
}

export function extractMinPassed(source: string | null): number | null {
  if (source === null) return null;
  const m = /export const MIN_PASSED_TESTS\s*=\s*(\d+)\s*;/.exec(source);
  return m?.[1] === undefined ? null : Number(m[1]);
}

export type PolicyInput = Readonly<{
  entries: readonly StagedEntry[];
  trailers: Trailers;
  /** نتیجهٔ بررسی تگِ Risk-Tag (در لایهٔ اجرا از git پرسیده می‌شود)؛ `null` = trailer نیامده. */
  riskTag: Readonly<{ ok: boolean; reason: string }> | null;
  gateFloor: Readonly<{ before: number | null; after: number | null }>;
}>;

/** بررسی‌هایی که به trailerهای پیام وابسته‌اند (در commit-msg). */
export function checkCommitPolicy(input: PolicyInput): readonly Violation[] {
  const out: Violation[] = [];
  const { entries, trailers } = input;
  const touched = (e: StagedEntry): string[] => (e.oldPath === undefined ? [e.path] : [e.path, e.oldPath]);

  // ۱) قانون آهنین: تست موجود تغییر/حذف/جابه‌جا نمی‌شود، مگر با تأیید صریح
  const changedTests = entries.filter((e) => !e.status.startsWith("A") && !e.status.startsWith("C") && touched(e).some(isTestPath));
  if (changedTests.length > 0 && trailers["Test-Change-Approved"] === undefined) {
    out.push(viol("existing-test-changed", `تست موجود تغییر کرده (${changedTests.map((e) => e.path).slice(0, 5).join("، ")}). قانون آهنین (G4): فقط افزودن مجاز است؛ وگرنه trailer «Test-Change-Approved: <دلیل و تأییدکننده>».`));
  }

  // ۲) ناحیهٔ پرریسک ⇒ تگ پیش از تغییر
  const risky = entries.filter((e) => touched(e).some(isHighRiskPath));
  if (risky.length > 0) {
    if (input.riskTag === null) {
      out.push(viol("risk-tag-missing", `تغییر ناحیهٔ پرریسک (${risky.map((e) => e.path).slice(0, 4).join("، ")}) بدون «Risk-Tag: pre-risk/YYYYMMDD-slug». پیش از تغییر تگ حاشیه‌دار بزنید (G8).`));
    } else if (!input.riskTag.ok) {
      out.push(viol("risk-tag-invalid", `Risk-Tag پذیرفته نشد: ${input.riskTag.reason}`));
    }
  }

  // ۳) کامیت چندماژوله ⇒ دلیل صریح
  const modules = new Set(entries.flatMap(touched).map(moduleOf).filter((x): x is string => x !== null));
  if (modules.size > 1 && trailers["Multi-Module"] === undefined) {
    out.push(viol("multi-module", `کامیت چند ماژول را با هم تغییر می‌دهد (${[...modules].sort().join("، ")}). جدا کنید، یا trailer «Multi-Module: <دلیل>» بگذارید (G7).`));
  }

  // ۴) کفِ دروازهٔ تست پایین نمی‌آید
  const { before, after } = input.gateFloor;
  if (before !== null && after !== null && after < before && trailers["Gate-Floor-Lowered"] === undefined) {
    out.push(viol("gate-floor-lowered", `MIN_PASSED_TESTS از ${before} به ${after} کاهش یافته؛ بدون «Gate-Floor-Lowered: <دلیل>» ممنوع است.`));
  }
  if (after === null && before !== null) out.push(viol("gate-floor-unreadable", "مقدار MIN_PASSED_TESTS در tooling/ci-tests.ts دیگر خوانده نمی‌شود."));
  return out;
}

// ───────────────────────── پوش ─────────────────────────

export type PushUpdate = Readonly<{ localRef: string; localSha: string; remoteRef: string; remoteSha: string }>;
export type PushGit = Readonly<{
  isAncestor(ancestor: string, descendant: string): boolean;
  objectExists(sha: string): boolean;
  objectType(sha: string): string;
}>;
const ZERO = /^0+$/;

export function parsePushLines(stdin: string): readonly PushUpdate[] {
  return stdin
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((l) => {
      const [localRef = "", localSha = "", remoteRef = "", remoteSha = ""] = l.split(/\s+/);
      return { localRef, localSha, remoteRef, remoteSha };
    });
}

export type PushVerdict = Readonly<{ violations: readonly Violation[]; needsGate: boolean }>;

export function checkPushUpdates(updates: readonly PushUpdate[], git: PushGit): PushVerdict {
  const out: Violation[] = [];
  let needsGate = false;
  for (const u of updates) {
    const isTag = u.remoteRef.startsWith("refs/tags/");
    if (ZERO.test(u.localSha)) {
      out.push(viol("push-delete", `حذف «${u.remoteRef}» از راه دور ممنوع است.`));
      continue;
    }
    if (isTag) {
      const name = u.remoteRef.slice("refs/tags/".length);
      const bad = checkTagName(name);
      if (bad) out.push(bad);
      if (git.objectType(u.localSha) !== "tag") out.push(viol("tag-lightweight", `تگ «${name}» باید حاشیه‌دار (annotated) باشد: git tag -a.`));
      if (!ZERO.test(u.remoteSha) && u.remoteSha !== u.localSha) out.push(viol("tag-move", `تگِ پوش‌شدهٔ «${name}» جابه‌جا نمی‌شود؛ تگ جدید با نام جدید بزنید.`));
      continue;
    }
    needsGate = true;
    if (!ZERO.test(u.remoteSha)) {
      if (!git.objectExists(u.remoteSha)) out.push(viol("push-fetch-first", `«${u.remoteRef}» در راه دور چیزی دارد که محلی ندارید؛ ابتدا fetch کنید.`));
      else if (!git.isAncestor(u.remoteSha, u.localSha)) out.push(viol("push-force", `پوش «${u.remoteRef}» fast-forward نیست (بازنویسی تاریخچهٔ پوش‌شده)؛ ممنوع (G11).`));
    }
  }
  return { violations: out, needsGate };
}

// ───────────────────────── دروازهٔ پیش از پوش و نبودن پایگاه ─────────────────────────

/**
 * کد خروجی `tooling/ci-tests.ts` برای «پایگاه آزمون در دسترس نیست» (نه «تست شکست خورد» که ۱ است).
 * باید با `EXIT_DB_UNAVAILABLE` در ci-tests.ts یکی بماند؛ آزمونِ همگامی در `pre-push-gate.test.ts` این را می‌سنجد.
 * (عمداً import نمی‌کنیم: ci-tests.ts به `pg` و `dotenv` وابسته است و هر هوک را کند می‌کرد.)
 */
export const GATE_EXIT_DB_UNAVAILABLE = 3;

const TRUTHY = /^(1|true|yes)$/i;

/**
 * «سخت‌گیر» = نبودن پایگاه هم مسدودکننده است. در CI و هر محیط خودکار (`CI`، `GITHUB_ACTIONS`) و وقتی کاربر صریحاً
 * `GIT_DISCIPLINE_REQUIRE_DB=1` بگذارد. چرا؟ تسامحِ نبودن پایگاه فقط برای ماشین توسعه‌ای است که دروازهٔ نهایی (CI) پشتش هست؛
 * جایی که خودش دروازهٔ نهایی است نباید هیچ تسامحی داشته باشد (ADR-0006: «سبزِ بی‌اجرا» پذیرفتنی نیست).
 */
export function isStrictGateEnv(env: Readonly<Record<string, string | undefined>>): boolean {
  const on = (k: string): boolean => TRUTHY.test((env[k] ?? "").trim());
  return on("CI") || on("GITHUB_ACTIONS") || on("GIT_DISCIPLINE_REQUIRE_DB");
}

export type GateRun = Readonly<{ status: number | null; signal?: string | null; spawnFailed?: boolean }>;
export type GateOutcome = Readonly<{ kind: "pass" | "warn" | "block"; message: string }>;

/**
 * تصمیم خالصِ هوک `pre-push` دربارهٔ نتیجهٔ دروازه:
 *  - کد ۰ ⇒ می‌گذرد؛
 *  - فقط «پایگاه در دسترس نیست» (کد ۳) و حالت غیرسخت‌گیر ⇒ **هشدار** و پوش آزاد؛
 *  - هر چیز دیگر (تست شکست‌خورده، کف سبز، اجرانشدن اجراگر، سیگنال، کد ناشناخته) ⇒ مسدود.
 * ایمن‌به‌طور پیش‌فرض: فقط یک حالتِ دقیقاً شناخته‌شده تسامح می‌گیرد.
 */
export function decideGateOutcome(run: GateRun, strict: boolean): GateOutcome {
  if (run.spawnFailed !== true && run.status === 0) return { kind: "pass", message: "" };
  if (run.spawnFailed !== true && run.status === GATE_EXIT_DB_UNAVAILABLE) {
    if (strict) {
      return { kind: "block", message: "✖ پایگاه آزمون در دسترس نیست و محیط سخت‌گیر است (CI/GIT_DISCIPLINE_REQUIRE_DB)؛ پوش رد شد. تست‌های پایگاه نباید رد شوند." };
    }
    return {
      kind: "warn",
      message: [
        "⚠ هشدار: پایگاه آزمون در این ماشین در دسترس نیست؛ دروازهٔ تست پیش از پوش اجرا نشد و پوش مجاز است.",
        "  دروازهٔ اصلی CI گیت‌هاب است و تست‌ها همان‌جا روی PostgreSQL واقعی اجرا می‌شوند: پیش از هر اقدام بعدی سبز شدنش را ببینید",
        "  و تا آن زمان تگ green/* نزنید (G9). (شکست واقعی تست همچنان پوش را مسدود می‌کند؛ الزام پایگاه: GIT_DISCIPLINE_REQUIRE_DB=1.)",
      ].join("\n"),
    };
  }
  const how = run.spawnFailed === true ? "اجراگر اجرا نشد" : run.signal ? `با سیگنال ${run.signal} پایان یافت` : `با کد ${String(run.status)} پایان یافت`;
  return { kind: "block", message: `✖ «دروازهٔ صفر-رد پیش از پوش» قرمز است (${how}); پوش رد شد.` };
}

// ───────────────────────── بازهٔ کامیت‌ها در CI (check-range) ─────────────────────────

export type CiRangeEnv = Readonly<{
  eventName: string;
  /** فقط `pull_request`: نوک شاخهٔ مقصد و نوک شاخهٔ PR (نه کامیتِ ادغامِ مجازیِ checkout). */
  prBaseSha: string;
  prHeadSha: string;
  /** فقط `push`: نوک پیشین ref (برای ref تازه صفر است). */
  pushBefore: string;
  sha: string;
  defaultBranch: string;
}>;
export type CiRangeGit = Readonly<{
  commitExists(sha: string): boolean;
  /** نیای مشترک `sha` و نوک شاخهٔ پیش‌فرض؛ `null` اگر نبود. */
  mergeBaseWithDefault(sha: string, defaultBranch: string): string | null;
}>;
export type CiRangePlan = Readonly<{ ok: true; range: string; note: string } | { ok: false; message: string }>;

const FULL_SHA = /^[0-9a-f]{40}$/i;

/**
 * کدام بازه در CI سنجیده شود؟ (خالص؛ git از بیرون می‌آید)
 *  - `pull_request`: `base..headِ PR` — با نوک PR، نه کامیت ادغامِ مجازیِ «Merge X into Y» که قالب ندارد؛
 *  - `push` با `before` شناخته‌شده: `before..sha`؛
 *  - ref تازه (تگ/شاخه)، `before` ناموجود (force-push) یا اجرای دستی: از نیای مشترک با شاخهٔ پیش‌فرض تا `sha`
 *    (پوش تگ روی کامیتی که روی main هست = بازهٔ تهی)، و اگر نیای مشترکی نبود فقط خودِ کامیت (`sha^!`).
 * شکست بلند و روشن به‌جای «سبزِ بی‌بررسی»: کامیتِ پایهٔ PR در کلون نباشد (نبودنِ `fetch-depth: 0`) = خطا.
 */
export function planCiRange(env: CiRangeEnv, git: CiRangeGit): CiRangePlan {
  if (!FULL_SHA.test(env.sha)) return { ok: false, message: "SHA کامیت (CI_SHA/GITHUB_SHA) نامعتبر یا خالی است." };
  if (env.eventName === "pull_request") {
    if (!FULL_SHA.test(env.prBaseSha) || !FULL_SHA.test(env.prHeadSha)) return { ok: false, message: "SHAهای پایه/سرِ PR در رویداد pull_request نیامده است." };
    if (!git.commitExists(env.prBaseSha) || !git.commitExists(env.prHeadSha)) {
      return { ok: false, message: "کامیت پایهٔ PR در کلون نیست؛ checkout باید با «fetch-depth: 0» باشد (وگرنه بازه سنجیده نمی‌شود)." };
    }
    return { ok: true, range: `${env.prBaseSha}..${env.prHeadSha}`, note: "کامیت‌های PR" };
  }
  if (env.eventName === "push" && FULL_SHA.test(env.pushBefore) && !ZERO.test(env.pushBefore) && git.commitExists(env.pushBefore)) {
    return { ok: true, range: `${env.pushBefore}..${env.sha}`, note: "کامیت‌های تازهٔ این پوش" };
  }
  const base = env.defaultBranch === "" ? null : git.mergeBaseWithDefault(env.sha, env.defaultBranch);
  if (base !== null && FULL_SHA.test(base)) return { ok: true, range: `${base}..${env.sha}`, note: `ref تازه/اجرای دستی: نسبت به شاخهٔ ${env.defaultBranch}` };
  return { ok: true, range: `${env.sha}^!`, note: "پایهٔ مقایسه پیدا نشد؛ فقط خودِ کامیت" };
}

// ───────────────────────── تجزیهٔ خروجی git (خالص) ─────────────────────────

/** خروجی `git diff --name-status -z` */
export function parseNameStatusZ(out: string): readonly StagedEntry[] {
  const parts = out.split("\0");
  const entries: StagedEntry[] = [];
  let i = 0;
  while (i < parts.length) {
    const status = parts[i];
    if (status === undefined || status === "") break;
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = parts[i + 1];
      const path = parts[i + 2];
      if (oldPath === undefined || path === undefined) break;
      entries.push({ status, path, oldPath });
      i += 3;
    } else {
      const path = parts[i + 1];
      if (path === undefined) break;
      entries.push({ status, path });
      i += 2;
    }
  }
  return entries;
}

/** خروجی `git diff -U0`: خط‌های افزوده‌شده به‌ازای هر فایل. */
export function parseAddedLines(diff: string): AddedLines {
  const result: Record<string, string[]> = {};
  let current: string | null = null;
  for (const line of diff.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("+++ ")) {
      current = line.startsWith("+++ b/") ? line.slice(6) : null;
      if (current !== null) result[current] = result[current] ?? [];
    } else if (line.startsWith("--- ")) {
      continue;
    } else if (line.startsWith("+") && current !== null) {
      (result[current] as string[]).push(line.slice(1));
    }
  }
  return result;
}

export function formatViolations(title: string, vs: readonly Violation[]): string {
  return [`✖ ${title}`, ...vs.map((x) => `  • [${x.rule}] ${x.message}`)].join("\n");
}

// ───────────────────────── لایهٔ اجرا ─────────────────────────

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SELF_DIR, "..");

function git(args: readonly string[], input?: string): { ok: boolean; out: string } {
  const r = spawnSync("git", ["-c", "core.quotepath=false", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...(input === undefined ? {} : { input }) });
  return { ok: r.status === 0, out: r.stdout ?? "" };
}

function stagedEntries(): readonly StagedEntry[] {
  return parseNameStatusZ(git(["diff", "--cached", "--name-status", "-z", "-M"]).out);
}

function riskTagCheck(trailers: Trailers): PolicyInput["riskTag"] {
  const tag = trailers["Risk-Tag"];
  if (tag === undefined) return null;
  const bad = checkTagName(tag);
  if (bad || !tag.startsWith("pre-risk/")) return { ok: false, reason: `نام تگ نامعتبر است: ${tag}` };
  const ref = `refs/tags/${tag}`;
  if (!git(["rev-parse", "-q", "--verify", ref]).ok) return { ok: false, reason: `تگ «${tag}» وجود ندارد؛ پیش از تغییر بسازید: git tag -a ${tag} -m "…"` };
  if (git(["cat-file", "-t", ref]).out.trim() !== "tag") return { ok: false, reason: `تگ «${tag}» حاشیه‌دار نیست (git tag -a).` };
  const head = git(["rev-parse", "-q", "--verify", "HEAD"]);
  if (head.ok && !git(["merge-base", "--is-ancestor", `${ref}^{commit}`, "HEAD"]).ok) return { ok: false, reason: `تگ «${tag}» پیشینِ HEAD نیست؛ تگِ پیش از تغییر باید روی همین شاخه باشد.` };
  return { ok: true, reason: "" };
}

function fail(text: string): never {
  process.stderr.write(`${text}\n`);
  process.exit(1);
}

function runStep(label: string, args: readonly string[]): void {
  process.stdout.write(`▶ ${label}\n`);
  const r = spawnSync(process.execPath, [...args], { cwd: REPO_ROOT, stdio: "inherit", env: process.env });
  if (r.status !== 0) fail(`✖ «${label}» قرمز است؛ کامیت رد شد (G2: بدون سبز بودن همه‌چیز، کامیت نیست).`);
}

function cmdCommitMsg(file: string | undefined): void {
  if (file === undefined) fail("استفاده: commit-msg <فایل پیام>");
  const raw = readFileSync(file, "utf8");
  const msg = checkCommitMessage(raw);
  if (msg.length > 0) fail(formatViolations("پیام کامیت پذیرفته نشد", msg));
  const parsed = parseCommitMessage(raw);
  if (parsed.automatic) return;
  const entries = stagedEntries();
  const floorTouched = entries.some((e) => e.path === "tooling/ci-tests.ts");
  const before = floorTouched ? extractMinPassed(git(["show", "HEAD:tooling/ci-tests.ts"]).out || null) : null;
  const after = floorTouched ? extractMinPassed(git(["show", ":tooling/ci-tests.ts"]).out || null) : null;
  const policy = checkCommitPolicy({ entries, trailers: parsed.trailers, riskTag: riskTagCheck(parsed.trailers), gateFloor: { before, after } });
  if (policy.length > 0) fail(formatViolations("سیاست کامیت پذیرفته نشد", policy));
}

function cmdPreCommit(): void {
  const entries = stagedEntries();
  if (entries.length === 0) return;
  const added = parseAddedLines(git(["diff", "--cached", "-U0", "--no-color", "--no-ext-diff"]).out);
  const hygiene = checkStagedHygiene(entries, added);
  if (hygiene.length > 0) fail(formatViolations("محتوای مرحله‌بندی‌شده پذیرفته نشد", hygiene));
  if (isDocsOnly(entries.flatMap((e) => (e.oldPath === undefined ? [e.path] : [e.path, e.oldPath])))) {
    process.stdout.write("ℹ کامیت فقط مستند است؛ دروازهٔ تست لازم نیست.\n");
    return;
  }
  const dirty = git(["diff", "--name-only", "-z"]).out; // تغییرِ مرحله‌بندی‌نشده: آنچه تست می‌شود با آنچه کامیت می‌شود فرق دارد
  if (dirty !== "") process.stderr.write("⚠ تغییرات مرحله‌بندی‌نشده هم هست؛ تست روی درخت کاری اجرا می‌شود. برای اطمینان: git stash --keep-index.\n");
  runStep("typecheck (tsc --noEmit)", [resolve(REPO_ROOT, "node_modules/typescript/bin/tsc"), "--noEmit"]);
  runStep("lint (eslint .)", [resolve(REPO_ROOT, "node_modules/eslint/bin/eslint.js"), "."]);
  runStep("دروازهٔ صفر-رد (tooling/ci-tests.ts)", ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", resolve(SELF_DIR, "ci-tests.ts")]);
}

function cmdPrePush(): void {
  const updates = parsePushLines(readFileSync(0, "utf8"));
  const verdict = checkPushUpdates(updates, {
    isAncestor: (a, d) => git(["merge-base", "--is-ancestor", a, d]).ok,
    objectExists: (sha) => git(["cat-file", "-e", `${sha}^{object}`]).ok,
    objectType: (sha) => git(["cat-file", "-t", sha]).out.trim(),
  });
  if (verdict.violations.length > 0) fail(formatViolations("پوش پذیرفته نشد", verdict.violations));
  if (git(["status", "--porcelain", "--untracked-files=no"]).out.trim() !== "") fail("✖ درخت کاری تمیز نیست؛ آنچه پوش می‌شود با آنچه تست می‌شود فرق دارد. ابتدا کامیت یا stash کنید.");
  if (verdict.needsGate) runPushGate();
}

function runPushGate(): void {
  process.stdout.write("▶ دروازهٔ صفر-رد پیش از پوش\n");
  const r = spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", resolve(SELF_DIR, "ci-tests.ts")], { cwd: REPO_ROOT, stdio: "inherit", env: process.env });
  const outcome = decideGateOutcome({ status: r.status, signal: r.signal, spawnFailed: r.error !== undefined }, isStrictGateEnv(process.env));
  if (outcome.kind === "block") fail(outcome.message);
  if (outcome.kind === "warn") process.stderr.write(`${outcome.message}\n`);
}

function cmdCheckRange(range: string | undefined): void {
  if (range === undefined) fail("استفاده: check-range <base>..<head>");
  const log = git(["log", "--reverse", "--format=%H%x00%B%x01", range]);
  if (!log.ok) fail(`بازهٔ «${range}» خوانده نشد.`);
  const all: string[] = [];
  for (const chunk of log.out.split("\x01")) {
    const [sha, ...msg] = chunk.replace(/^\n+/, "").split("\0");
    if (sha === undefined || sha === "") continue;
    const vs = checkCommitMessage(msg.join("\0"));
    if (vs.length > 0) all.push(formatViolations(`کامیت ${sha.slice(0, 7)}`, vs));
  }
  if (all.length > 0) fail(all.join("\n"));
  process.stdout.write("✔ پیام همهٔ کامیت‌های بازه با قالب می‌خواند.\n");
}

function cmdCiRange(): void {
  const e = process.env;
  const env: CiRangeEnv = {
    eventName: e["CI_EVENT_NAME"] ?? "",
    prBaseSha: e["CI_PR_BASE_SHA"] ?? "",
    prHeadSha: e["CI_PR_HEAD_SHA"] ?? "",
    pushBefore: e["CI_PUSH_BEFORE"] ?? "",
    sha: e["CI_SHA"] ?? "",
    defaultBranch: e["CI_DEFAULT_BRANCH"] ?? "",
  };
  const plan = planCiRange(env, {
    commitExists: (sha) => git(["cat-file", "-e", `${sha}^{commit}`]).ok,
    mergeBaseWithDefault: (sha, branch) => {
      for (const ref of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`]) {
        if (!git(["rev-parse", "-q", "--verify", `${ref}^{commit}`]).ok) continue;
        const mb = git(["merge-base", sha, ref]);
        if (mb.ok && mb.out.trim() !== "") return mb.out.trim();
      }
      return null;
    },
  });
  if (!plan.ok) fail(`✖ ${plan.message}`);
  process.stdout.write(`▶ check-range ${plan.range} (${plan.note})\n`);
  cmdCheckRange(plan.range);
}

function cmdInstall(): void {
  if (!git(["config", "core.hooksPath", "tooling/git-hooks"]).ok) fail("نصب هوک‌ها شکست خورد (داخل مخزن گیت نیستید؟).");
  process.stdout.write("✔ core.hooksPath = tooling/git-hooks (هوک‌های commit-msg، pre-commit، pre-push فعال شدند).\n");
}

function cmdDoctor(): void {
  const path = git(["config", "--get", "core.hooksPath"]).out.trim();
  if (path !== "tooling/git-hooks") fail("✖ هوک‌ها نصب نیستند. اجرا کنید: node tooling/git-discipline.ts install");
  process.stdout.write("✔ هوک‌های انضباط گیت نصب‌اند.\n");
}

function main(argv: readonly string[]): void {
  const [cmd, arg] = argv;
  switch (cmd) {
    case "commit-msg": return cmdCommitMsg(arg);
    case "pre-commit": return cmdPreCommit();
    case "pre-push": return cmdPrePush();
    case "check-range": return cmdCheckRange(arg);
    case "ci-range": return cmdCiRange();
    case "check-tag": {
      if (arg === undefined) fail("استفاده: check-tag <نام>");
      const bad = checkTagName(arg);
      if (bad) fail(formatViolations("نام تگ", [bad]));
      process.stdout.write("✔ نام تگ معتبر است.\n");
      return;
    }
    case "install": return cmdInstall();
    case "doctor": return cmdDoctor();
    default: fail("دستورها: install | doctor | commit-msg <file> | pre-commit | pre-push | check-range <a..b> | ci-range | check-tag <name>");
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) main(process.argv.slice(2));

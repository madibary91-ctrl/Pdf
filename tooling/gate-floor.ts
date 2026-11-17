/**
 * «چنگکِ پویای کفِ دروازه» (gate-floor ratchet) — ADR-0012.
 *
 * مسئله: `MIN_PASSED_TESTS` (در `tooling/ci-tests.ts`) را یک تستِ موجود با عددِ سنجاق‌شده (`toBe(735)`) قفل کرده بود؛
 * پس هر بار که کف بالا می‌رفت، یک تستِ موجود هم باید دست می‌خورد (قانون آهنین G4 + trailer).
 *
 * راه‌حل: «آخرین مقدار تأییدشده» دیگر عدد دستی نیست؛ **از تاریخچهٔ گیت** خوانده می‌شود = کفِ آخرین کامیتی که
 * `tooling/ci-tests.ts` را عوض کرده است (آن کامیت از هوک `commit-msg` گذشته است). قاعده:
 *   ۱. کفِ درخت کاری هرگز کمتر از آخرین مقدار تأییدشده نیست؛
 *   ۲. در کل تاریخچه هیچ کامیتی کف را پایین نبرده، مگر با trailer `Gate-Floor-Lowered: <دلیل>`؛
 *   ۳. خوانا نبودنِ کف پس از آنکه خوانا بوده، خودش شکست است.
 * نتیجه: بالا بردن کف فقط یک ویرایش در `ci-tests.ts` است و هیچ تستی را عوض نمی‌کند.
 *
 * این فایل همان بررسیِ `commit-msg` را در سمت CI هم اجرا می‌کند (هوک‌های محلی با `--no-verify` دورزدنی‌اند).
 * بخش خالص (`checkFloorHistory`، `approvedFloor`، `requiredFloor`، `evaluateFloor`) بدون I/O است؛ فقط `readFloorHistory` با `git` کار می‌کند.
 */
import { spawnSync } from "node:child_process";
import { extractMinPassed, parseCommitMessage } from "./git-discipline";

/** یک نقطه از تاریخچهٔ کف: کامیتی که `ci-tests.ts` را عوض کرده (قدیم → جدید). */
export type FloorSample = Readonly<{
  /** شناسهٔ کامیت (برای پیام خطا). */
  id: string;
  /** `null` = مقدار در آن کامیت خوانده نشد. */
  floor: number | null;
  /** کامیت trailer `Gate-Floor-Lowered` دارد (کاهشِ صریح و دلیل‌دار). */
  loweringApproved: boolean;
}>;

/**
 * کفِ جایگزین وقتی هیچ تاریخچه‌ای در دسترس نیست (کلون کم‌عمق/دایرکتوری بی‌گیت).
 * این عدد فقط «حداقل ایمنی» است؛ پایین آوردنش ممنوع است (G3).
 */
export const FLOOR_FALLBACK = 735;

const isFloor = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

/** خالص: مشکلات تاریخچه (فهرست خالی = سالم). نمونه‌ها باید از قدیم به جدید باشند. */
export function checkFloorHistory(samples: readonly FloorSample[]): readonly string[] {
  const problems: string[] = [];
  let previous: number | null = null;
  for (const s of samples) {
    if (s.floor === null) {
      if (previous !== null) problems.push(`${s.id}: مقدار MIN_PASSED_TESTS دیگر خوانده نمی‌شود (پیش‌تر ${previous} بود).`);
      continue;
    }
    if (!isFloor(s.floor)) {
      problems.push(`${s.id}: MIN_PASSED_TESTS باید عدد صحیح نامنفی باشد (${s.floor}).`);
      continue;
    }
    if (previous !== null && s.floor < previous && !s.loweringApproved) {
      problems.push(`${s.id}: کف از ${previous} به ${s.floor} کاهش یافته بدون «Gate-Floor-Lowered».`);
    }
    previous = s.floor;
  }
  return problems;
}

/** خالص: آخرین مقدار تأییدشده = کفِ آخرین نمونهٔ خوانا؛ بدون نمونه ⇒ `null`. */
export function approvedFloor(samples: readonly FloorSample[]): number | null {
  for (let i = samples.length - 1; i >= 0; i--) {
    const f = samples[i]?.floor;
    if (isFloor(f)) return f;
  }
  return null;
}

/** خالص: کفی که درخت کاری باید دست‌کم داشته باشد (تاریخچه، وگرنه `FLOOR_FALLBACK`). */
export function requiredFloor(samples: readonly FloorSample[]): number {
  return Math.max(approvedFloor(samples) ?? 0, FLOOR_FALLBACK);
}

/** خالص: ارزیابی کفِ درخت کاری در برابر تاریخچه؛ خالی = پذیرفته. */
export function evaluateFloor(current: number, samples: readonly FloorSample[]): readonly string[] {
  const out = [...checkFloorHistory(samples)];
  const need = requiredFloor(samples);
  if (!isFloor(current)) out.push(`کف فعلی (${current}) عدد صحیح نامنفی نیست.`);
  else if (current < need) out.push(`کف فعلی (${current}) از آخرین مقدار تأییدشده (${need}) کمتر است؛ کف فقط بالا می‌رود (G3).`);
  return out;
}

// ───────────────────────────── لایهٔ نازکِ git ─────────────────────────────

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  return env;
}

function git(root: string, args: readonly string[]): string | null {
  const r = spawnSync("git", [...args], { cwd: root, encoding: "utf8", env: cleanEnv(), maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 && typeof r.stdout === "string" ? r.stdout : null;
}

const CI_TESTS_PATH = "tooling/ci-tests.ts";

/**
 * تاریخچهٔ کف از گیت (قدیم ← جدید). `null` = گیت/مخزن در دسترس نیست (بی‌گیت ≠ «تاریخچهٔ خالی»).
 * `--follow` عمداً نیست: جابه‌جایی فایل باید دیده شود (کف «خوانا نبود») نه پنهان.
 */
export function readFloorHistory(root: string): readonly FloorSample[] | null {
  const listing = git(root, ["log", "--reverse", "--format=%H", "--", CI_TESTS_PATH]);
  if (listing === null) return null;
  const samples: FloorSample[] = [];
  for (const sha of listing.split("\n").filter((l) => /^[0-9a-f]{40}$/.test(l))) {
    const source = git(root, ["show", `${sha}:${CI_TESTS_PATH}`]);
    const message = git(root, ["log", "-1", "--format=%B", sha]) ?? "";
    samples.push({
      id: sha.slice(0, 7),
      floor: extractMinPassed(source),
      loweringApproved: parseCommitMessage(message).trailers["Gate-Floor-Lowered"] !== undefined,
    });
  }
  return samples;
}

/** آزمون «چنگکِ پویای کفِ دروازه» (ADR-0012): منطق خالص، مخزن موقتِ واقعی گیت، و تاریخچهٔ واقعیِ همین مخزن. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { MIN_PASSED_TESTS } from "./ci-tests";
import { FLOOR_FALLBACK, approvedFloor, checkFloorHistory, evaluateFloor, readFloorHistory, requiredFloor, type FloorSample } from "./gate-floor";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const s = (id: string, floor: number | null, loweringApproved = false): FloorSample => ({ id, floor, loweringApproved });

describe("tooling: چنگک پویای کف — منطق خالص", () => {
  it("تاریخچهٔ صعودی/ثابت سالم است و تاریخچهٔ خالی هم", () => {
    expect(checkFloorHistory([])).toEqual([]);
    expect(checkFloorHistory([s("a", 603), s("b", 735), s("c", 735), s("d", 900)])).toEqual([]);
  });

  it("کاهش بدون trailer مشکل است، با trailer پذیرفته می‌شود، و مقایسهٔ بعدی با مقدار کاهش‌یافته است", () => {
    const bad = checkFloorHistory([s("a", 735), s("b", 734)]);
    expect(bad).toHaveLength(1);
    expect(bad[0]).toContain("b");
    expect(checkFloorHistory([s("a", 735), s("b", 500, true)])).toEqual([]);
    // پس از کاهشِ مجاز به ۵۰۰، رفتن به ۴۹۹ بدون trailer دوباره مشکل است
    expect(checkFloorHistory([s("a", 735), s("b", 500, true), s("c", 499)])).toHaveLength(1);
    expect(checkFloorHistory([s("a", 735), s("b", 500, true), s("c", 600)])).toEqual([]);
  });

  it("خوانا نبودن پس از خوانا بودن مشکل است؛ نخواندنِ اولیه یا پس از آن بی‌اثر روی مقایسهٔ بعدی نیست", () => {
    expect(checkFloorHistory([s("a", null), s("b", 735)])).toEqual([]);
    expect(checkFloorHistory([s("a", 735), s("b", null)])).toHaveLength(1);
    // پس از یک «نخواندن»، کفِ پیشین هنوز مرجع است
    expect(checkFloorHistory([s("a", 735), s("b", null), s("c", 700)])).toHaveLength(2);
  });

  it("مقدار نامعتبر (اعشاری، منفی، NaN) مشکل است", () => {
    for (const bad of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(checkFloorHistory([s("x", bad)]), String(bad)).toHaveLength(1);
    }
  });

  it("آخرین مقدار تأییدشده = کفِ آخرین نمونهٔ خوانا", () => {
    expect(approvedFloor([])).toBeNull();
    expect(approvedFloor([s("a", null)])).toBeNull();
    expect(approvedFloor([s("a", 603), s("b", 735)])).toBe(735);
    expect(approvedFloor([s("a", 603), s("b", 735), s("c", null)])).toBe(735);
    expect(approvedFloor([s("a", 735), s("b", 500, true)])).toBe(500);
    expect(approvedFloor([s("a", 0)])).toBe(0);
  });

  it("کفِ لازم: تاریخچهٔ بلندتر برنده است و بدون تاریخچه کفِ جایگزین", () => {
    expect(requiredFloor([])).toBe(FLOOR_FALLBACK);
    expect(requiredFloor([s("a", 10)])).toBe(FLOOR_FALLBACK);
    expect(requiredFloor([s("a", 823)])).toBe(Math.max(823, FLOOR_FALLBACK));
    expect(requiredFloor([s("a", 823)])).toBeGreaterThanOrEqual(823);
  });

  it("بالا بردن کف بدون هیچ ویرایشی در تست‌ها پذیرفته می‌شود؛ پایین‌تر از تأییدشده یا برابرِ آن مرز دقیق دارد", () => {
    const h = [s("a", 735), s("b", 823)];
    expect(evaluateFloor(823, h)).toEqual([]);
    expect(evaluateFloor(824, h)).toEqual([]);
    expect(evaluateFloor(5000, h)).toEqual([]);
    const low = evaluateFloor(822, h);
    expect(low).toHaveLength(1);
    expect(low[0]).toContain("823");
    expect(evaluateFloor(0, [])).toHaveLength(1);
    expect(evaluateFloor(FLOOR_FALLBACK, [])).toEqual([]);
  });

  it("مشکلِ تاریخچه و کفِ فعلی هم‌زمان گزارش می‌شوند و کف نامعتبر رد می‌شود", () => {
    expect(evaluateFloor(100, [s("a", 735), s("b", 700)])).toHaveLength(2);
    expect(evaluateFloor(Number.NaN, [s("a", 735)]).length).toBeGreaterThan(0);
    expect(evaluateFloor(800.5, [s("a", 735)]).length).toBeGreaterThan(0);
  });
});

describe("tooling: چنگک پویای کف — مخزن موقتِ واقعی", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function env(): NodeJS.ProcessEnv {
    const e: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1" };
    for (const k of Object.keys(e)) if (k.startsWith("GIT_") && k !== "GIT_CONFIG_NOSYSTEM") delete e[k];
    return e;
  }
  function run(cwd: string, args: string[]): void {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", env: env() });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  }
  function repo(): string {
    const d = mkdtempSync(join(tmpdir(), "gate-floor-"));
    dirs.push(d);
    run(d, ["init", "-q"]);
    run(d, ["config", "user.name", "t"]);
    run(d, ["config", "user.email", "t@example.invalid"]);
    run(d, ["config", "commit.gpgsign", "false"]);
    run(d, ["config", "core.hooksPath", "/dev/null"]);
    mkdirSync(join(d, "tooling"));
    return d;
  }
  function commitFloor(d: string, body: string, message: string): void {
    writeFileSync(join(d, "tooling/ci-tests.ts"), body);
    run(d, ["add", "-A"]);
    run(d, ["commit", "-q", "-m", message]);
  }
  const src = (n: number | string): string => `// x\nexport const MIN_PASSED_TESTS = ${n};\n`;

  it("تاریخچه به ترتیب قدیم→جدید، با trailerِ کاهش و بدونِ کامیت‌های بی‌ربط", () => {
    const d = repo();
    commitFloor(d, src(603), "chore(ci): a");
    writeFileSync(join(d, "other.txt"), "x");
    run(d, ["add", "-A"]);
    run(d, ["commit", "-q", "-m", "docs(ci): unrelated"]);
    commitFloor(d, src(735), "chore(ci): b");
    commitFloor(d, src(500), "chore(ci): c\n\nGate-Floor-Lowered: حذف تست‌های منسوخ با تأیید مالک");
    const h = readFloorHistory(d);
    expect(h).not.toBeNull();
    expect((h ?? []).map((x) => [x.floor, x.loweringApproved])).toEqual([[603, false], [735, false], [500, true]]);
    expect(checkFloorHistory(h ?? [])).toEqual([]);
    expect(approvedFloor(h ?? [])).toBe(500);
  });

  it("کاهشِ بی‌trailer در مخزن واقعی و خوانا نبودن کف دیده می‌شود", () => {
    const d = repo();
    commitFloor(d, src(735), "chore(ci): a");
    commitFloor(d, src(700), "chore(ci): b");
    expect(checkFloorHistory(readFloorHistory(d) ?? [])).toHaveLength(1);
    commitFloor(d, "export const MIN_PASSED_TESTS = Number(process.env.X);\n", "chore(ci): c");
    const h = readFloorHistory(d) ?? [];
    expect(h.map((x) => x.floor)).toEqual([735, 700, null]);
    expect(checkFloorHistory(h).length).toBeGreaterThanOrEqual(2);
  });

  it("مخزنِ بدونِ کامیت روی فایل ⇒ تاریخچهٔ خالی؛ پوشهٔ بی‌گیت ⇒ null", () => {
    const d = repo();
    writeFileSync(join(d, "a.txt"), "x");
    run(d, ["add", "-A"]);
    run(d, ["commit", "-q", "-m", "chore(ci): a"]);
    expect(readFloorHistory(d)).toEqual([]);
    const plain = mkdtempSync(join(tmpdir(), "gate-floor-nogit-"));
    dirs.push(plain);
    // اگر tmpdir خودش داخل یک مخزن باشد این پیش‌فرض نادرست است؛ در آن صورت گیت نتیجهٔ دیگری می‌دهد، پس صریحاً می‌سنجیم.
    const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: plain, env: env(), encoding: "utf8" });
    expect(inside.status !== 0 ? readFloorHistory(plain) === null : true).toBe(true);
  });
});

describe("tooling: چنگک پویای کف — همین مخزن", () => {
  it("تاریخچهٔ واقعیِ کف سالم است و کفِ فعلی از آخرین مقدار تأییدشده کمتر نیست (بدون عدد سنجاق‌شده)", () => {
    const history = readFloorHistory(ROOT);
    if (history === null) {
      // بدون گیت (مثلاً tarball) فقط کفِ جایگزین سنجیده می‌شود؛ در CI نبودنِ گیت خودش شکست است.
      expect(process.env["CI"], "در CI باید مخزن گیت در دسترس باشد").not.toBe("true");
      expect(evaluateFloor(MIN_PASSED_TESTS, [])).toEqual([]);
      return;
    }
    expect(evaluateFloor(MIN_PASSED_TESTS, history)).toEqual([]);
  });
});

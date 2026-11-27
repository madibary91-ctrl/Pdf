/**
 * نگهبانِ یکپارچگیِ مصنوعاتِ تحویل (برش ۰۰۷۸؛ ADR-0079). منطقِ **خالص** است: فایل نمی‌خواند؛ فهرستِ `{ path, text }` می‌گیرد و
 * فهرستِ نقض برمی‌گرداند. خواندنِ دیسک کارِ آزمونِ زنده است (`artifact-integrity.repo.test.ts`).
 *
 * ریشه (واقعی، دوبار): `docs/tasks/0074-…` در `1b123ec` و `docs/tasks/0015-…` در `a697691` **خالی (۰ بایت)** کامیت شدند، بی‌آنکه
 * هیچ آزمونی بفهمد (`docs-path-refs` فقط مسیرها را می‌سنجد). فایلِ خالی شکستِ بی‌صدا است: مستندِ تصمیم/تحویل «هست» ولی چیزی نمی‌گوید.
 * این نگهبان آنچه را **ماشین می‌تواند بسنجد** قفل می‌کند، نه کیفیتِ محتوا را:
 *   ۱) هیچ فایلِ مستند خالی/فقط‌فاصله نیست و هیچ فایلِ منبع/آزمون/پیکربندیِ شناخته‌شده ۰ بایت نیست؛
 *   ۲) نویسهٔ خراب (U+FFFD، BOM، NUL) و نشانگرِ تعارضِ ادغام (`<<<<<<<`/`>>>>>>>` در متنِ عادی) نیست؛
 *   ۳) در سه سریِ شماره‌دار (`docs/tasks|handoffs|adr`): نامِ `NNNN-slug.md`، شمارهٔ یکتا و **بی‌شکاف** از ۰۰۰۱، سرتیترِ `# …` در خطِ اول،
 *      حداقلِ اندازه (کوتاه‌شدگی)، خطِ پایانی، و همخوانیِ شمارهٔ نام با سرتیترِ یادداشتِ تحویل (`۰۰۷۷`) و ADR (`ADR-0078`).
 */

export type ArtifactFile = Readonly<{ path: string; text: string }>;
export type SizedFile = Readonly<{ path: string; bytes: number }>;

export type ViolationCode =
  | "EMPTY"
  | "TOO_SHORT"
  | "BAD_ENCODING"
  | "CONFLICT_MARKER"
  | "NO_H1"
  | "NO_FINAL_NEWLINE"
  | "BAD_NAME"
  | "DUPLICATE_NUMBER"
  | "NUMBER_GAP"
  | "HEADING_NUMBER_MISMATCH"
  | "ALLOWLIST_NO_REASON";

export type Violation = Readonly<{ code: ViolationCode; path: string; detail: string }>;

/** سه سریِ شماره‌دار. فایل‌های آن‌ها تاریخچه‌اند و ویرایش‌ناپذیر؛ از این رو سخت‌گیریِ ساختاری فقط اینجاست. */
export const SERIES_DIRS: readonly string[] = ["docs/tasks", "docs/handoffs", "docs/adr"];

/** کوچک‌ترین سندِ واقعیِ موجود ≈ ۱٫۱ کیلوبایت است؛ زیرِ این حد یعنی بریده‌شده یا جایگذار (stub). */
export const MIN_SERIES_BYTES = 256;

/** فایل‌های ۰ بایتیِ مجاز: مسیر ← دلیل. عمداً خالی است؛ افزودنِ مدخل = تصمیمِ آگاهانه با دلیل. */
export const EMPTY_FILE_ALLOWLIST: Readonly<Record<string, string>> = Object.freeze({});

const NUMBERED = /^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const TEMPLATE = /^_[A-Z]+\.md$/;
const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

const toPosix = (p: string): string => p.replace(/\\/g, "/");
const byteLength = (s: string): number => new TextEncoder().encode(s).length;
const pad4 = (n: number): string => String(n).padStart(4, "0");
export const toPersianDigits = (s: string): string => s.replace(/\d/g, (d) => PERSIAN_DIGITS.charAt(Number(d)));
const viol = (code: ViolationCode, path: string, detail: string): Violation => ({ code, path, detail });
const byPathThenCode = (a: Violation, b: Violation): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0;

export function seriesOf(path: string): { dir: string; name: string } | null {
  const p = toPosix(path);
  for (const dir of SERIES_DIRS) {
    if (p.startsWith(`${dir}/`)) {
      const name = p.slice(dir.length + 1);
      if (!name.includes("/")) return { dir, name };
    }
  }
  return null;
}

/**
 * نشانگرِ تعارضِ ادغام در متنِ عادی (بلوکِ کدِ حصاری نادیده است: مستندی که خودِ نشانگر را نقل می‌کند ایراد نیست).
 * شکست‌بسته: حصارِ **نبسته** نباید بقیهٔ فایل را از دید پنهان کند؛ در آن حالت فایل بی‌توجه به حصار بررسی می‌شود.
 */
export function hasConflictMarker(text: string): boolean {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const isMarker = (l: string): boolean => /^(?:<{7}|>{7})(?: |$)/.test(l);
  let inFence = false;
  let found = false;
  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && isMarker(line)) found = true;
  }
  if (found) return true;
  return inFence && lines.some((l) => isMarker(l));
}

function encodingProblem(text: string): string | null {
  if (text.charCodeAt(0) === 0xfeff) return "BOM در آغاز فایل";
  if (text.includes("\ufffd")) return "نویسهٔ جایگزین U+FFFD (کدگذاریِ خراب)";
  if (text.includes("\u0000")) return "نویسهٔ NUL";
  return null;
}

function checkSeriesMember(file: ArtifactFile, dir: string, name: string): Violation[] {
  const out: Violation[] = [];
  const m = NUMBERED.exec(name);
  if (!TEMPLATE.test(name) && (m === null || Number(m[1]) === 0)) {
    out.push(viol("BAD_NAME", file.path, "نام باید «NNNN-slug.md» با شمارهٔ ≥ ۰۰۰۱ و slugِ لاتینِ کوچک باشد (یا قالبِ «_NAME.md»)."));
    return out;
  }
  if (byteLength(file.text) < MIN_SERIES_BYTES) out.push(viol("TOO_SHORT", file.path, `کمتر از ${MIN_SERIES_BYTES} بایت؛ بریده یا جایگذار است.`));
  const first = file.text.split("\n")[0] ?? ""; // «\r» پایانیِ CRLF در هیچ‌کدام از سنجش‌های زیر اثر ندارد
  if (!/^# \S/.test(first)) out.push(viol("NO_H1", file.path, "خطِ اولِ فایل باید سرتیترِ «# عنوان» باشد."));
  if (!file.text.endsWith("\n")) out.push(viol("NO_FINAL_NEWLINE", file.path, "فایل با خطِ پایانی تمام نمی‌شود (نشانهٔ بریدگی)."));
  if (m !== null) {
    const n4 = m[1] ?? "";
    if (dir === "docs/handoffs" && !first.includes(toPersianDigits(n4))) {
      out.push(viol("HEADING_NUMBER_MISMATCH", file.path, `سرتیتر باید شمارهٔ «${toPersianDigits(n4)}» را داشته باشد.`));
    }
    if (dir === "docs/adr" && !new RegExp(`^# ADR[-\\u2011]${n4}(?!\\d)`).test(first)) {
      out.push(viol("HEADING_NUMBER_MISMATCH", file.path, `سرتیتر باید با «# ADR-${n4}» شروع شود.`));
    }
  }
  return out;
}

/** بررسیِ فایل‌های مستند. خروجی بر پایهٔ (مسیر، کد) مرتب است و به ترتیبِ ورودی بستگی ندارد. */
export function checkDocFiles(files: readonly ArtifactFile[]): Violation[] {
  const out: Violation[] = [];
  const numbers = new Map<string, Map<number, string[]>>();
  for (const dir of SERIES_DIRS) numbers.set(dir, new Map());

  for (const raw of files) {
    const file: ArtifactFile = { path: toPosix(raw.path), text: raw.text };
    const series = seriesOf(file.path);
    // شمارهٔ هر فایلِ سری (حتی خالی) «اشغال» است: فایلِ خالی شکافِ دروغین نمی‌سازد، فقط خودش EMPTY می‌شود.
    const m = series === null ? null : NUMBERED.exec(series.name);
    if (series !== null && m !== null && Number(m[1]) > 0) {
      const byNum = numbers.get(series.dir);
      const n = Number(m[1]);
      if (byNum !== undefined) byNum.set(n, [...(byNum.get(n) ?? []), file.path]);
    }
    if (file.text.trim().length === 0) {
      out.push(viol("EMPTY", file.path, byteLength(file.text) === 0 ? "فایل ۰ بایت است." : "فایل فقط فاصله/خطِ خالی دارد."));
      continue;
    }
    const enc = encodingProblem(file.text);
    if (enc !== null) out.push(viol("BAD_ENCODING", file.path, enc));
    if (hasConflictMarker(file.text)) out.push(viol("CONFLICT_MARKER", file.path, "نشانگرِ تعارضِ ادغام در متن مانده است."));
    if (series !== null) out.push(...checkSeriesMember(file, series.dir, series.name));
  }

  for (const [dir, byNum] of numbers) {
    if (byNum.size === 0) continue;
    for (const [n, paths] of byNum) {
      if (paths.length > 1) out.push(viol("DUPLICATE_NUMBER", dir, `شمارهٔ ${pad4(n)} در ${paths.length} فایل تکرار شده: ${[...paths].sort().join("، ")}`));
    }
    const max = Math.max(...byNum.keys());
    const missing: string[] = [];
    for (let i = 1; i <= max; i++) if (!byNum.has(i)) missing.push(pad4(i));
    if (missing.length > 0) out.push(viol("NUMBER_GAP", dir, `شمارهٔ جاافتاده: ${missing.join("، ")} (سری باید از ۰۰۰۱ تا ${pad4(max)} پیوسته باشد).`));
  }
  return out.sort(byPathThenCode);
}

/** فایل‌های ۰ بایتیِ غیرمجاز (منبع/آزمون/پیکربندی/مستند). `allow` پیش‌فرض = فهرستِ خالیِ عمدی. */
export function findEmptyFiles(files: readonly SizedFile[], allow: Readonly<Record<string, string>> = EMPTY_FILE_ALLOWLIST): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    const p = toPosix(f.path);
    if (f.bytes === 0 && !Object.prototype.hasOwnProperty.call(allow, p)) out.push(viol("EMPTY", p, "فایل ۰ بایت است."));
  }
  return out.sort(byPathThenCode);
}

/** هر مدخلِ `allow` باید دلیلِ غیرخالی داشته باشد (مدخلِ بی‌دلیل = نقض). */
export function checkAllowlist(allow: Readonly<Record<string, string>>): Violation[] {
  return Object.entries(allow)
    .filter(([, why]) => typeof why !== "string" || why.trim().length === 0)
    .map(([p]) => viol("ALLOWLIST_NO_REASON", p, "مدخلِ allowlist بی‌دلیل است."))
    .sort(byPathThenCode);
}

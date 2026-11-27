/**
 * پویشگرِ دیسک برای `artifact-integrity` (ADR-0079): فقط **خواندنِ** درخت و ساختنِ ورودیِ منطقِ خالص. هیچ تصمیمی اینجا نیست.
 * پیوندهای نمادین دنبال نمی‌شوند (حلقه/خروج از ریشه)؛ پوشه‌های تولیدی/وابستگی پویش نمی‌شوند.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactFile, SizedFile } from "./artifact-integrity";

export const SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git", ".next", "dist", "test-results", "coverage"]);

/** پسوندهایی که فایلِ ۰ بایتی‌شان خطاست (کد، آزمون، پیکربندی، مستند). */
export const CHECKED_EXTENSIONS = /\.(?:ts|tsx|mts|mjs|cjs|js|py|md|json|sql|yml|yaml|sh|css)$/;

function walk(root: string, rel: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true });
  } catch {
    return; // پوشهٔ ناموجود = چیزی برای پویش نیست
  }
  for (const e of entries) {
    const childRel = rel === "" ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(root, childRel, out);
    } else if (e.isFile()) {
      out.push(childRel);
    }
  }
}

/** همهٔ مسیرهای فایل زیرِ `root` (مسیر نسبیِ POSIX، مرتب). */
export function listFiles(root: string, start = ""): string[] {
  const out: string[] = [];
  walk(root, start, out);
  return out.sort();
}

/** مستنداتی که نگهبان می‌خواند: `docs/**\/*.md`، `AGENTS.md` و README هر ماژول. */
export function collectDocFiles(root: string): ArtifactFile[] {
  const wanted = listFiles(root).filter(
    (p) => (p.startsWith("docs/") && p.endsWith(".md")) || p === "AGENTS.md" || /^src\/modules\/[^/]+\/README\.md$/.test(p),
  );
  return wanted.map((path) => ({ path, text: readFileSync(join(root, path), "utf8") }));
}

/** اندازهٔ فایل‌های کد/پیکربندی/مستند در ریشه (فقط سطحِ ریشه) و `src`، `tooling`، `docs`، `public`، `.github`. */
export function collectSizedFiles(root: string): SizedFile[] {
  const all = listFiles(root).filter((p) => CHECKED_EXTENSIONS.test(p));
  const inScope = all.filter((p) => !p.includes("/") || /^(?:src|tooling|docs|public|\.github)\//.test(p));
  return inScope.map((path) => ({ path, bytes: statSync(join(root, path)).size }));
}

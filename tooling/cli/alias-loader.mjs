/**
 * حلقهٔ resolveِ Node برای اجرای مستقیمِ TypeScriptِ مخزن (ADR-0034): `@/…` ← `src/…` و importِ نسبیِ بی‌پسوند ← `.ts` یا `index.ts`.
 * چرا؟ Node ≥ 22.18 خودش نوع‌ها را حذف می‌کند ولی نه نام‌مستعارِ `@/` را می‌شناسد و نه پسوندِ `.ts` را حدس می‌زند.
 * بدون وابستگیِ تازه (AGENTS بند ۸): نه `tsx` و نه تکیه بر `vite-node`ِ تراگذرِ `vitest`.
 * فقط فایل‌های خودِ مخزن را بازنویسی می‌کند؛ بسته‌های `node_modules` و `node:` دست‌نخورده می‌مانند.
 */
import { statSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** نخستین فایلِ موجود از «خودِ مسیر»، «مسیر+.ts» و «مسیر/index.ts»؛ وگرنه null. */
export function candidateFor(base) {
  for (const p of [base, `${base}.ts`, join(base, "index.ts")]) if (p.endsWith(".ts") && isFile(p)) return p;
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  let base = null;
  if (specifier.startsWith("@/")) {
    base = resolvePath(SRC, specifier.slice(2));
  } else if ((specifier.startsWith("./") || specifier.startsWith("../")) && typeof context.parentURL === "string") {
    const parent = context.parentURL;
    if (parent.startsWith("file://") && parent.endsWith(".ts") && !parent.includes("/node_modules/")) base = resolvePath(dirname(fileURLToPath(parent)), specifier);
  }
  if (base !== null) {
    const found = candidateFor(base);
    if (found !== null) return nextResolve(pathToFileURL(found).href, context);
  }
  return nextResolve(specifier, context);
}

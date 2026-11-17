/**
 * بررسی خودکار مرزهای ماژول‌ها (قواعد ۲، ۳ و ۵ راهنما) — تابع خالص روی فهرست فایل‌ها.
 * اجرای واقعی روی مخزن در tooling/boundaries.test.ts است و جزو CI حساب می‌شود.
 */
import type { ModuleInfo } from "../src/modules/registry";

export type SourceFile = Readonly<{ path: string; content: string }>;
export type Violation = Readonly<{ file: string; rule: string; detail: string }>;

const IMPORT_RE = /(?:import|export)\s[^"'`;]*?\sfrom\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;

export function extractImports(content: string): string[] {
  const out: string[] = [];
  for (const match of content.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2] ?? match[3];
    if (spec) out.push(spec);
  }
  return out;
}

const MODULE_IMPORT = /^@\/modules\/([^/]+)(\/.*)?$/;

/** وابستگی‌هایی که ماژول «خالص» اجازه ندارد (I/O و فریم‌ورک). */
const FORBIDDEN_FOR_PURE = [/^node:/, /^(fs|path|os|child_process|http|https|net|crypto)$/, /^next(\/|$)/, /^react(-dom)?(\/|$)/, /^pg$/, /^drizzle-orm(\/|$)/, /^@\/db(\/|$)/, /^@\/app(\/|$)/];

function moduleOfPath(path: string): string | null {
  const m = /^src\/modules\/([^/]+)\//.exec(path.replace(/\\/g, "/"));
  return m ? (m[1] ?? null) : null;
}

export function checkRegistry(modules: readonly ModuleInfo[]): Violation[] {
  const v: Violation[] = [];
  const byName = new Map(modules.map((x) => [x.name, x]));
  if (byName.size !== modules.length) v.push({ file: "registry", rule: "unique-name", detail: "نام ماژول تکراری است." });
  for (const mod of modules) {
    for (const dep of mod.dependsOn) {
      const d = byName.get(dep);
      if (!d) v.push({ file: mod.name, rule: "unknown-dependency", detail: `وابستگی ناشناخته: ${dep}` });
      else if (d.layer > mod.layer) {
        v.push({ file: mod.name, rule: "upward-dependency", detail: `${mod.name}(لایه ${mod.layer}) به ${dep}(لایه ${d.layer}) وابسته است.` });
      }
    }
  }
  // چرخه‌ها: DFS
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (name: string, stack: string[]): void => {
    if (state.get(name) === 2) return;
    if (state.get(name) === 1) {
      v.push({ file: name, rule: "cycle", detail: `وابستگی دایره‌ای: ${[...stack, name].join(" → ")}` });
      return;
    }
    state.set(name, 1);
    for (const dep of byName.get(name)?.dependsOn ?? []) visit(dep, [...stack, name]);
    state.set(name, 2);
  };
  for (const mod of modules) visit(mod.name, []);
  return v;
}

export function checkBoundaries(files: readonly SourceFile[], modules: readonly ModuleInfo[]): Violation[] {
  const violations: Violation[] = [];
  const byName = new Map(modules.map((x) => [x.name, x]));

  for (const file of files) {
    const path = file.path.replace(/\\/g, "/");
    const owner = moduleOfPath(path);
    const imports = extractImports(file.content);

    for (const spec of imports) {
      const target = MODULE_IMPORT.exec(spec);

      if (target) {
        const targetName = target[1] as string;
        // قاعدهٔ ۳: فقط رابط عمومی (index)
        if (target[2] && target[2] !== "/index") {
          if (!(owner && owner === targetName)) {
            violations.push({ file: path, rule: "deep-import", detail: `import عمیق از ماژول دیگر: ${spec} (فقط @/modules/${targetName})` });
          }
          continue;
        }
        if (!owner || owner === targetName) continue;
        const me = byName.get(owner);
        const dep = byName.get(targetName);
        if (!dep) {
          violations.push({ file: path, rule: "unknown-module", detail: `ماژول ناشناخته: ${targetName}` });
        } else if (me && !me.dependsOn.includes(targetName)) {
          violations.push({ file: path, rule: "undeclared-dependency", detail: `${owner} به ${targetName} وابسته است ولی در registry اعلام نشده.` });
        }
        continue;
      }

      if (!owner) continue;

      // نسبی: باید داخل همین ماژول بماند
      if (spec.startsWith(".")) {
        const depth = spec.split("/").filter((s) => s === "..").length;
        const parts = path.split("/").length - 4; // تعداد زیرپوشه‌ها زیر ریشهٔ ماژول
        if (depth > parts) {
          violations.push({ file: path, rule: "escapes-module", detail: `import نسبی از ماژول بیرون می‌زند: ${spec}` });
        }
        continue;
      }

      // قاعدهٔ ۴: ماژول خالص I/O ندارد
      if (byName.get(owner)?.pure && FORBIDDEN_FOR_PURE.some((re) => re.test(spec))) {
        violations.push({ file: path, rule: "impure-import", detail: `ماژول خالص «${owner}» نباید ${spec} را import کند.` });
      }
      // مسیر مستقیم src/... بدون alias
      if (/^src\//.test(spec)) {
        violations.push({ file: path, rule: "bad-path", detail: `از alias «@/» استفاده کنید: ${spec}` });
      }
    }
  }
  return violations;
}

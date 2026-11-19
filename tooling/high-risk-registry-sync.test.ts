/**
 * ADR-0027 (برش م۳‑ه): همسوییِ ماشین‌خوانِ «مسیرهای پرریسک» (git-discipline.ts) با registry.ts و docs/high-risk-areas.md.
 *
 * دو بخش: (الف) حالتِ واقعیِ مخزن هیچ ناهمخوانی ندارد؛ (ب) خودِ بازرسی روی سناریوهای ساختگی آزموده می‌شود
 * تا «سبزِ بی‌اثر» نباشد (بازرسی‌ای که هیچ‌وقت قرمز نشود ارزشی ندارد).
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MODULES, type ModuleInfo } from "../src/modules/registry";
import { HIGH_RISK_BEYOND_REGISTRY, HIGH_RISK_MODULES, isHighRiskPath } from "./git-discipline";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOC = readFileSync(join(ROOT, "docs/high-risk-areas.md"), "utf8");
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

type Audit = Readonly<{
  modules: readonly Pick<ModuleInfo, "name" | "humanReview">[];
  riskModules: readonly string[];
  beyond: Readonly<Record<string, string>>;
  doc: string;
  isRisk: (path: string) => boolean;
}>;

/** نام‌های «تکه‌های بک‌تیک» سند: هر ماژول با `src/modules/<name>/…` یا نامِ بازِ `<name>` / `<name>/` ذکر می‌شود. */
function documentedModules(doc: string, names: readonly string[]): ReadonlySet<string> {
  const spans = [...doc.matchAll(/`([^`\n]+)`/g)].map((m) => (m[1] as string).trim());
  const out = new Set<string>();
  for (const name of names) {
    if (spans.some((s) => s === name || s === `${name}/` || s.startsWith(`src/modules/${name}/`))) out.add(name);
  }
  return out;
}

/** فهرستِ ناهمخوانی‌ها؛ خالی = همسو. هر پیام یک ناورداست. */
export function auditHighRiskCoverage(a: Audit): string[] {
  const problems: string[] = [];
  const byName = new Map(a.modules.map((x) => [x.name, x] as const));
  const reviewed = a.modules.filter((x) => x.humanReview).map((x) => x.name);

  for (const n of a.riskModules) if (!NAME_RE.test(n)) problems.push(`نام نامعتبر در HIGH_RISK_MODULES: «${n}»`);
  const seen = new Set<string>();
  for (const n of a.riskModules) {
    if (seen.has(n)) problems.push(`نام تکراری در HIGH_RISK_MODULES: «${n}»`);
    seen.add(n);
  }
  // registry ⇒ regex
  for (const n of reviewed) {
    if (!a.isRisk(`src/modules/${n}/index.ts`)) problems.push(`ماژولِ humanReview «${n}» پرریسک نیست (HIGH_RISK_MODULES را کامل کنید).`);
  }
  // regex ⇒ registry
  for (const n of a.riskModules) {
    const info = byName.get(n);
    if (info === undefined) problems.push(`«${n}» در HIGH_RISK_MODULES است ولی در registry نیست (شبح/غلط املایی).`);
    else if (!info.humanReview && !(n in a.beyond)) problems.push(`«${n}» humanReview:false است و استثنای دلیل‌دار هم ندارد.`);
  }
  // استثناها
  for (const [n, why] of Object.entries(a.beyond)) {
    if (why.trim().length < 10) problems.push(`استثنای «${n}» دلیلِ کافی ندارد.`);
    if (!a.riskModules.includes(n)) problems.push(`استثنای «${n}» در HIGH_RISK_MODULES نیست (کهنه).`);
    const info = byName.get(n);
    if (info !== undefined && info.humanReview) problems.push(`استثنای «${n}» کهنه است: registry خودش humanReview:true دارد.`);
  }
  // registry ⇒ سند
  const documented = documentedModules(a.doc, reviewed);
  for (const n of reviewed) if (!documented.has(n)) problems.push(`ماژولِ humanReview «${n}» در docs/high-risk-areas.md ذکر نشده است.`);
  return problems;
}

const REAL: Audit = { modules: MODULES, riskModules: HIGH_RISK_MODULES, beyond: HIGH_RISK_BEYOND_REGISTRY, doc: DOC, isRisk: isHighRiskPath };

describe("همسوییِ پرریسک با registry — حالتِ واقعیِ مخزن", () => {
  it("هیچ ناهمخوانی میان registry، HIGH_RISK و سند نیست", () => {
    expect(auditHighRiskCoverage(REAL)).toEqual([]);
  });

  it("هر ماژولِ humanReview (ساخته‌شده یا برنامه‌ریزی‌شده) برای کد پرریسک است، برای README و آزمونش نه", () => {
    const reviewed = MODULES.filter((m) => m.humanReview);
    expect(reviewed.length).toBeGreaterThanOrEqual(10);
    for (const m of reviewed) {
      expect(isHighRiskPath(`src/modules/${m.name}/index.ts`), m.name).toBe(true);
      expect(isHighRiskPath(`src/modules/${m.name}/pg/migrations.ts`), m.name).toBe(true);
      expect(isHighRiskPath(`src/modules/${m.name}/README.md`), m.name).toBe(false);
      expect(isHighRiskPath(`src/modules/${m.name}/x.test.ts`), m.name).toBe(false);
      expect(isHighRiskPath(`src/modules/${m.name}-extra/index.ts`), `${m.name}-extra`).toBe(false);
      expect(isHighRiskPath(`src/modules/x${m.name}/index.ts`), `x${m.name}`).toBe(false);
    }
  });

  it("شکافِ تاریخیِ ۰۰۲۶: settlement، metering و ai-orchestrator (پول و خط لولهٔ پاسخ) پرریسک‌اند", () => {
    for (const p of [
      "src/modules/settlement/pg/migrations.ts",
      "src/modules/settlement/pg/store.ts",
      "src/modules/settlement/sweep-loop.ts",
      "src/modules/settlement/outbox-contract.ts",
      "src/modules/metering/metered-gateway.ts",
      "src/modules/ai-orchestrator/index.ts",
    ]) expect(isHighRiskPath(p), p).toBe(true);
    for (const p of [
      "src/modules/settlement/sweep-loop.test.ts",
      "src/modules/settlement/pg/dead-ack.pg.test.ts",
      "src/modules/settlement/README.md",
      "src/modules/metering/README.md",
    ]) expect(isHighRiskPath(p), p).toBe(false);
  });

  it("ماژول‌های بدون بازبینیِ انسانی پرریسک نیستند (مگر استثنای صریح)", () => {
    for (const m of MODULES.filter((x) => !x.humanReview && !(x.name in HIGH_RISK_BEYOND_REGISTRY))) {
      expect(isHighRiskPath(`src/modules/${m.name}/index.ts`), m.name).toBe(false);
    }
    for (const n of ["persian-text", "retrieval", "ai-gateway", "ui-rtl", "calc-tools"]) {
      expect(isHighRiskPath(`src/modules/${n}/index.ts`), n).toBe(false);
    }
  });

  it("استثناهای صریح همان دو مورد مستندند و هر دو واقعاً پرریسک‌اند", () => {
    expect(Object.keys(HIGH_RISK_BEYOND_REGISTRY).sort()).toEqual(["legal-kb-store", "shared-types"]);
    for (const n of Object.keys(HIGH_RISK_BEYOND_REGISTRY)) expect(isHighRiskPath(`src/modules/${n}/index.ts`), n).toBe(true);
  });

  it("مسیرهای غیرماژولیِ پرریسک و شاهدهای پیشین بی‌تغییرند", () => {
    for (const p of ["src/modules/registry.ts", "src/db/schema.ts", "drizzle.config.json", ".github/workflows/ci.yml", "tooling/ci-tests.ts", "tooling/git-discipline.ts", "tooling/git-hooks/pre-push", "vitest.config.ts"]) {
      expect(isHighRiskPath(p), p).toBe(true);
    }
    for (const p of ["tooling/boundaries.ts", "src/app/page.tsx", "docs/adr/0027-high-risk-registry-sync.md", "AGENTS.md", "src/modules/registryx.ts"]) {
      expect(isHighRiskPath(p), p).toBe(false);
    }
  });

  it("regex به ابتدای مسیرِ مخزن لنگر است (پوشهٔ هم‌نامِ بیرون از src/modules پرریسک نیست)", () => {
    for (const p of ["vendor/src/modules/settlement/a.ts", "x/src/modules/ledger/a.ts", "src/other/modules/settlement/a.ts", "src/modules/settlement"]) {
      expect(isHighRiskPath(p), p).toBe(false);
    }
  });

  it("registry نامِ ماژول را تکرار نمی‌کند و نام‌های HIGH_RISK_MODULES همه در registry جاری‌اند", () => {
    const names = MODULES.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of HIGH_RISK_MODULES) expect(names, n).toContain(n);
  });
});

describe("خودِ بازرسی قرمز می‌شود (آزمونِ آزمون)", () => {
  const MOD = [
    { name: "alpha", humanReview: true },
    { name: "beta", humanReview: false },
    { name: "gamma", humanReview: true },
  ] as const;
  const DOC_OK = "| `src/modules/alpha/` | x |\n| `gamma` , `src/modules/delta/` | y |";
  const mk = (over: Partial<Audit> = {}): Audit => {
    const riskModules = over.riskModules ?? ["alpha", "gamma", "beta"];
    return {
      modules: MOD,
      riskModules,
      beyond: { beta: "قرارداد مشترک؛ عمداً محافظه‌کارانه" },
      doc: DOC_OK,
      isRisk: (p) => riskModules.some((n) => p.startsWith(`src/modules/${n}/`)),
      ...over,
    };
  };

  it("حالتِ سالمِ ساختگی سبز است (شاهدِ نبودنِ مثبتِ کاذب)", () => {
    expect(auditHighRiskCoverage(mk())).toEqual([]);
  });

  it("ماژولِ humanReview که از HIGH_RISK افتاده", () => {
    const p = auditHighRiskCoverage(mk({ riskModules: ["alpha", "beta"] }));
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("«gamma» پرریسک نیست");
  });

  it("نامِ شبح (غلط املایی) در HIGH_RISK_MODULES", () => {
    const p = auditHighRiskCoverage(mk({ riskModules: ["alpha", "gamma", "beta", "gamna"] }));
    expect(p.some((x) => x.includes("«gamna»") && x.includes("در registry نیست"))).toBe(true);
  });

  it("ماژولِ humanReview:false بی‌استثنا در HIGH_RISK_MODULES", () => {
    const p = auditHighRiskCoverage(mk({ beyond: {} }));
    expect(p).toEqual(["«beta» humanReview:false است و استثنای دلیل‌دار هم ندارد."]);
  });

  it("استثنای کهنه: ماژول humanReview:true شده", () => {
    const p = auditHighRiskCoverage(mk({ beyond: { beta: "یک دلیل به‌اندازهٔ کافی", alpha: "یک دلیل به‌اندازهٔ کافی" } }));
    expect(p).toEqual(["استثنای «alpha» کهنه است: registry خودش humanReview:true دارد."]);
  });

  it("استثنای بی‌دلیل یا بیرون از فهرست", () => {
    expect(auditHighRiskCoverage(mk({ beyond: { beta: "  کوتاه " } }))).toEqual(["استثنای «beta» دلیلِ کافی ندارد."]);
    const p = auditHighRiskCoverage(mk({ beyond: { beta: "یک دلیل به‌اندازهٔ کافی", zeta: "یک دلیل به‌اندازهٔ کافی" } }));
    expect(p).toEqual(["استثنای «zeta» در HIGH_RISK_MODULES نیست (کهنه)."]);
  });

  it("هر سه شکلِ مجازِ ذکر در سند پذیرفته می‌شود: مسیر، نامِ باز، نام با اسلش", () => {
    expect(auditHighRiskCoverage(mk({ doc: "`src/modules/alpha/index.ts` و `gamma/`" }))).toEqual([]);
    expect(auditHighRiskCoverage(mk({ doc: "`alpha` `gamma`" }))).toEqual([]);
    expect(auditHighRiskCoverage(mk({ doc: "`src/modules/alpha/` `src/modules/gamma/pg/x.ts`" }))).toEqual([]);
  });

  it("ماژولِ humanReview بی‌ردیف در سند؛ ذکرِ زیررشته یا هم‌پیشوند ردیف حساب نمی‌شود", () => {
    const p = auditHighRiskCoverage(mk({ doc: "| `src/modules/alpha/` | x |\n| `gamma-extra` `src/modules/gamma-2/` `xgamma` gamma | y |" }));
    expect(p).toEqual(["ماژولِ humanReview «gamma» در docs/high-risk-areas.md ذکر نشده است."]);
  });

  it("نام نامعتبر یا تکراری", () => {
    expect(auditHighRiskCoverage(mk({ riskModules: ["alpha", "gamma", "beta", "Bad_Name"] })).some((x) => x.includes("نام نامعتبر"))).toBe(true);
    expect(auditHighRiskCoverage(mk({ riskModules: ["alpha", "gamma", "beta", "alpha"] }))).toEqual(["نام تکراری در HIGH_RISK_MODULES: «alpha»"]);
  });

  it("ماژولِ جدیدِ humanReview در registry، بدون ویرایشِ بقیه ⇒ سه ناورداست قرمز می‌شود", () => {
    const p = auditHighRiskCoverage(mk({ modules: [...MOD, { name: "omega", humanReview: true }] }));
    expect(p).toHaveLength(2);
    expect(p.some((x) => x.includes("«omega» پرریسک نیست"))).toBe(true);
    expect(p.some((x) => x.includes("«omega»") && x.includes("docs/high-risk-areas.md"))).toBe(true);
  });
});

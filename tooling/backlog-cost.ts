/**
 * تحلیلِ هزینهٔ خواندنِ دوره‌ایِ پایشِ پسماند (م۳‑ه‑۴‑الف‑۲‑۳، ADR-0044) — **خالص**: بی‌پایگاه، بی‌ساعت، بی‌process.
 *
 * چرا؟ `settlement-backlog-watch` هر `intervalMs` (پیش‌فرض ۳۰ ثانیه) یک بار `outbox.listUnacknowledgedDead` را روی استخرِ مشترکِ برنامه
 * می‌خواند. این خواندن ضدپیوندِ «مرده‌ها» با جدولِ تأییدهاست؛ رکوردِ تأییدشده هرگز حذف نمی‌شود (ADR-0025)، پس اگر هزینه با شمارِ
 * مرده‌های *تأییدشده* رشد کند، پایشِ روشن با گذشتِ زمان کند می‌شود. این فایل منطقِ «سنجیدن» را نگه می‌دارد تا بی‌پایگاه آزموده شود:
 *  - `summarizePlan`: خروجیِ `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` را به شمارنده‌های بسته تبدیل می‌کند (ورودی ناقابل‌اعتماد).
 *  - `summarizeSamples`: میانه/p95 با رتبهٔ نزدیک‌ترین (نه درون‌یابی؛ p95 هرگز از بدترین نمونهٔ دیده‌شده بیشتر نمی‌شود).
 *  - `fitLinear` / `horizonRows`: رشدِ زمان بر شمارِ مرده‌های تأییدشده و «تا چند ردیف تا رسیدن به بودجه».
 *  - `judgeCost`: حکم (`ok|warn|fail`) با کدهای بسته؛ آستانه‌ها سیاستِ عملیاتیِ پیشنهادی‌اند، نه عددِ مرجعِ مالی.
 *  - `parseCostArgs`: آرگومانِ CLI، شکست‌بسته؛ مقدارِ آرگومان هرگز در خطا پژواک نمی‌شود (known-pitfalls).
 * هیچ‌چیز نمی‌پرتابد؛ خطا همیشه `{ ok:false, error:{ code } }` با کدِ بسته است.
 * (سینتکسِ قابل‌حذف فقط: بدون enum/namespace/parameter-property؛ چون CLI با Node مستقیم اجرا می‌شود.)
 */

export type CostResult<T, C extends string> = { ok: true; value: T } | { ok: false; error: { code: C } };

const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });
const err = <C extends string>(code: C): { ok: false; error: { code: C } } => ({ ok: false, error: { code } });

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

// ───────────────────────── طرحِ اجرا (EXPLAIN) ─────────────────────────

export const OUTBOX_TABLE = "settlement_outbox";
export const ACK_TABLE = "settlement_dead_ack";

export type PlanSummary = Readonly<{
  executionMs: number;
  planningMs: number;
  sharedHitBlocks: number;
  sharedReadBlocks: number;
  /** ردیف‌هایی که اسکنِ outbox دیده است ((ردیفِ برگشتی + ردیفِ فیلترشده) × تکرار)؛ ردیفِ فیلترشده هم می‌شمارد. */
  outboxRowsScanned: number;
  /** ردیف‌هایی که اسکن/جست‌وجو روی جدولِ تأیید دیده است (همان فرمول). */
  ackRowsTouched: number;
  /** ردیف‌های خروجیِ ریشه. */
  returnedRows: number;
  /** نوعِ گره‌ها به ترتیبِ پیمایشِ عمقی (برای تشخیصِ Seq Scan، Sort، نوعِ join). */
  nodeTypes: readonly string[];
  /** نامِ ایندکس‌های استفاده‌شده، یکتا و مرتب. */
  indexes: readonly string[];
  seqScanOnOutbox: boolean;
  sortNode: boolean;
}>;

export type PlanError = "BAD_PLAN";

type PlanNode = Record<string, unknown>;

const MAX_NODES = 10_000;
const MAX_DEPTH = 200;

/** گره‌های طرح را عمقی می‌پیماید؛ شکلِ ناآشنا یا بسیار بزرگ ⇒ `null`. */
function collectNodes(root: unknown): PlanNode[] | null {
  const out: PlanNode[] = [];
  const stack: { node: unknown; depth: number }[] = [{ node: root, depth: 0 }];
  while (stack.length > 0) {
    const cur = stack.pop() as { node: unknown; depth: number };
    if (!isRecord(cur.node) || cur.depth > MAX_DEPTH || out.length >= MAX_NODES) return null;
    out.push(cur.node);
    const plans = cur.node["Plans"];
    if (plans !== undefined) {
      if (!Array.isArray(plans)) return null;
      // برعکس می‌گذاریم تا ترتیبِ خروجی پیش‌ترتیبِ چپ‌به‌راست باشد.
      for (let i = plans.length - 1; i >= 0; i--) stack.push({ node: plans[i], depth: cur.depth + 1 });
    }
  }
  return out;
}

/** فیلدِ عددیِ اختیاری: نبودن = ۰؛ وجودِ نامعتبر = `null`. */
const optionalCount = (n: PlanNode, key: string): number | null => {
  const v = n[key];
  if (v === undefined) return 0;
  return isNum(v) ? v : null;
};

/**
 * خروجیِ `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` (آرایهٔ تک‌عضوی) ⇒ شمارنده‌ها. هر انحرافِ شکلی (فیلدِ ضروریِ ناموجود، عددِ منفی/نامتناهی،
 * گرهِ غیرِ شیء) ⇒ `BAD_PLAN`؛ هرگز عددِ ساختگی نمی‌دهد.
 */
export function summarizePlan(raw: unknown): CostResult<PlanSummary, PlanError> {
  const top = Array.isArray(raw) && raw.length === 1 ? raw[0] : raw;
  if (!isRecord(top) || !isRecord(top["Plan"])) return err("BAD_PLAN");
  const executionMs = top["Execution Time"];
  const planningMs = top["Planning Time"];
  if (!isNum(executionMs) || !isNum(planningMs)) return err("BAD_PLAN");
  const rootPlan = top["Plan"];
  const nodes = collectNodes(rootPlan);
  if (nodes === null) return err("BAD_PLAN");
  const hit = optionalCount(rootPlan, "Shared Hit Blocks");
  const read = optionalCount(rootPlan, "Shared Read Blocks");
  const returned = rootPlan["Actual Rows"];
  if (hit === null || read === null || !isNum(returned)) return err("BAD_PLAN");

  let outboxRows = 0;
  let ackRows = 0;
  let seq = false;
  let sort = false;
  const types: string[] = [];
  const indexes = new Set<string>();
  for (const n of nodes) {
    const type = n["Node Type"];
    if (typeof type !== "string" || type === "") return err("BAD_PLAN");
    types.push(type);
    if (/\bSort\b/.test(type)) sort = true;
    const relation = n["Relation Name"];
    if (typeof relation !== "string") continue; // گرهٔ غیرِ اسکنِ جدول
    const rows = n["Actual Rows"];
    const loops = n["Actual Loops"];
    if (!isNum(rows) || !isNum(loops)) return err("BAD_PLAN");
    const removed = optionalCount(n, "Rows Removed by Filter");
    if (removed === null) return err("BAD_PLAN");
    const index = n["Index Name"];
    if (typeof index === "string") indexes.add(index);
    if (relation === OUTBOX_TABLE) {
      outboxRows += (rows + removed) * loops;
      if (type === "Seq Scan") seq = true;
    } else if (relation === ACK_TABLE) {
      ackRows += (rows + removed) * loops;
    }
  }
  return ok(
    Object.freeze({
      executionMs,
      planningMs,
      sharedHitBlocks: hit,
      sharedReadBlocks: read,
      outboxRowsScanned: outboxRows,
      ackRowsTouched: ackRows,
      returnedRows: returned,
      nodeTypes: Object.freeze(types),
      indexes: Object.freeze([...indexes].sort()),
      seqScanOnOutbox: seq,
      sortNode: sort,
    }),
  );
}

/** «ضریبِ تقویت»: چند ردیفِ outbox خوانده شد به ازای هر ردیفِ برگشتی (مخرجِ حداقل ۱؛ برگشتِ تهی هم بی‌تقسیمِ صفر سنجیده می‌شود). */
export const scanAmplification = (p: Pick<PlanSummary, "outboxRowsScanned" | "returnedRows">): number => p.outboxRowsScanned / Math.max(1, p.returnedRows);

// ───────────────────────── نمونه‌های زمان ─────────────────────────

export type SampleStats = Readonly<{ n: number; minMs: number; medianMs: number; p95Ms: number; maxMs: number }>;

/** رتبهٔ نزدیک‌ترین: `x[ceil(0.95·n)-1]`؛ پس p95 هرگز از میانه کمتر و از بیشینه بیشتر نیست. میانهٔ تعدادِ زوج = میانگینِ دو عضوِ میانی. */
export function summarizeSamples(samples: readonly unknown[]): CostResult<SampleStats, "NO_SAMPLES" | "BAD_SAMPLE"> {
  if (!Array.isArray(samples) || samples.length === 0) return err("NO_SAMPLES");
  if (!samples.every(isNum)) return err("BAD_SAMPLE");
  const x = [...(samples as number[])].sort((a, b) => a - b);
  const n = x.length;
  const at = (i: number): number => x[i] as number;
  const median = n % 2 === 1 ? at((n - 1) / 2) : (at(n / 2 - 1) + at(n / 2)) / 2;
  return ok(Object.freeze({ n, minMs: at(0), medianMs: median, p95Ms: at(Math.ceil(0.95 * n) - 1), maxMs: at(n - 1) }));
}

// ───────────────────────── برازشِ خطی ─────────────────────────

export type LinearFit = Readonly<{ slope: number; intercept: number; r2: number }>;

/** کمترین مربعات روی (x, y). دست‌کم دو x متفاوت لازم است؛ `r2` وقتی y ثابت است ۱ (برازشِ کامل) گزارش می‌شود. */
export function fitLinear(points: readonly Readonly<{ x: number; y: number }>[]): CostResult<LinearFit, "TOO_FEW_POINTS" | "BAD_POINT"> {
  if (!Array.isArray(points)) return err("TOO_FEW_POINTS");
  for (const p of points) if (!isRecord(p) || !isNum(p["x"]) || !isNum(p["y"])) return err("BAD_POINT");
  if (new Set(points.map((p) => p.x)).size < 2) return err("TOO_FEW_POINTS");
  const n = points.length;
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of points) {
    sxx += (p.x - mx) ** 2;
    sxy += (p.x - mx) * (p.y - my);
    syy += (p.y - my) ** 2;
  }
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  return ok(Object.freeze({ slope, intercept, r2 }));
}

/** کوچک‌ترین شمارِ ردیفی که مدلِ خطی در آن به `budgetMs` می‌رسد؛ شیبِ غیرمثبت ⇒ `null` (رشدِ نامحدود/بی‌شیب)؛ بودجهٔ زیرِ عرضِ از مبدأ ⇒ ۰. */
export function horizonRows(fit: LinearFit, budgetMs: number): number | null {
  if (!isNum(budgetMs) || !isRecord(fit) || typeof fit.slope !== "number" || typeof fit.intercept !== "number" || !(fit.slope > 0)) return null;
  const rows = (budgetMs - fit.intercept) / fit.slope;
  return Number.isFinite(rows) ? Math.max(0, Math.floor(rows)) : null;
}

// ───────────────────────── حکم ─────────────────────────

export type CostBudget = Readonly<{ timeoutMs: number; intervalMs: number }>;

/** آستانه‌های حکم (پیشنهادِ عملیاتیِ ADR-0044؛ قفل در آزمون). */
export const COST_POLICY = Object.freeze({
  /** p95 ≥ این کسر از `timeoutMs` ⇒ `READ_NEAR_TIMEOUT` (warn). */
  nearTimeoutFraction: 0.5,
  /** میانهٔ خواندن ÷ `intervalMs` ≥ این ⇒ `DUTY_CYCLE_HIGH` (warn): پایش نباید بیش از ۵٪ از وقتِ یک اتصال را بگیرد. */
  dutyCycleWarn: 0.05,
  /** ضریبِ تقویتِ اسکن ≥ این ⇒ `WIDE_SCAN` (warn)، به شرطِ دست‌کم `wideScanMinRows` ردیفِ اسکن‌شده (در مقیاسِ کوچک ناپایدار است). */
  wideScanAmplification: 100,
  wideScanMinRows: 10_000,
  /** اسکنِ outbox بیش از `deadRows × (1+این) + slack` ردیف دیده ⇒ ردیف‌های done/open هم خوانده شده‌اند (`NON_DEAD_ROWS_SCANNED`، warn). */
  nonDeadTolerance: 0.05,
  nonDeadSlack: 10,
});

export type CostReason = "READ_EXCEEDS_TIMEOUT" | "READ_NEAR_TIMEOUT" | "DUTY_CYCLE_HIGH" | "WIDE_SCAN" | "NON_DEAD_ROWS_SCANNED";
export type CostStatus = "ok" | "warn" | "fail";

/** `deadRows` = شمارِ همهٔ ردیف‌های dead (تأییدشده + تأییدنشده) در سناریو؛ مبنای «ردیفِ غیرِ dead اسکن شد؟». */
export type ScenarioMeasure = Readonly<{ label: string; deadRows: number; stats: SampleStats; plan: PlanSummary }>;
export type ScenarioVerdict = Readonly<{ label: string; status: CostStatus; reasons: readonly CostReason[] }>;
export type CostVerdict = Readonly<{ status: CostStatus; scenarios: readonly ScenarioVerdict[] }>;

const RANK: Readonly<Record<CostStatus, number>> = { ok: 0, warn: 1, fail: 2 };
const worse = (a: CostStatus, b: CostStatus): CostStatus => (RANK[a] >= RANK[b] ? a : b);

const validMeasure = (m: unknown): m is ScenarioMeasure => {
  if (!isRecord(m) || typeof m["label"] !== "string" || !isNum(m["deadRows"]) || !isRecord(m["stats"]) || !isRecord(m["plan"])) return false;
  const st = m["stats"];
  const pl = m["plan"];
  return isNum(st["medianMs"]) && isNum(st["p95Ms"]) && isNum(pl["outboxRowsScanned"]) && isNum(pl["returnedRows"]);
};

/** حکم برای هر سناریو و حکمِ کل = بدترین. بودجهٔ نامعتبر ⇒ `BAD_BUDGET`؛ اندازهٔ خراب ⇒ `BAD_MEASURE` (حکمِ ساختگی نمی‌دهد، نمی‌پرتابد). */
export function judgeCost(measures: readonly ScenarioMeasure[], budget: CostBudget): CostResult<CostVerdict, "BAD_BUDGET" | "BAD_MEASURE"> {
  if (!isRecord(budget) || !isNum(budget.timeoutMs) || budget.timeoutMs <= 0 || !isNum(budget.intervalMs) || budget.intervalMs <= 0) return err("BAD_BUDGET");
  if (!Array.isArray(measures) || !measures.every(validMeasure)) return err("BAD_MEASURE");
  const P = COST_POLICY;
  let overall: CostStatus = "ok";
  const scenarios: ScenarioVerdict[] = measures.map((m) => {
    const reasons: CostReason[] = [];
    let status: CostStatus = "ok";
    const add = (r: CostReason, s: CostStatus): void => {
      reasons.push(r);
      status = worse(status, s);
    };
    if (m.stats.p95Ms >= budget.timeoutMs) add("READ_EXCEEDS_TIMEOUT", "fail");
    else if (m.stats.p95Ms >= budget.timeoutMs * P.nearTimeoutFraction) add("READ_NEAR_TIMEOUT", "warn");
    if (m.stats.medianMs / budget.intervalMs >= P.dutyCycleWarn) add("DUTY_CYCLE_HIGH", "warn");
    if (m.plan.outboxRowsScanned >= P.wideScanMinRows && scanAmplification(m.plan) >= P.wideScanAmplification) add("WIDE_SCAN", "warn");
    if (m.plan.outboxRowsScanned > m.deadRows * (1 + P.nonDeadTolerance) + P.nonDeadSlack) add("NON_DEAD_ROWS_SCANNED", "warn");
    overall = worse(overall, status);
    return Object.freeze({ label: m.label, status, reasons: Object.freeze(reasons) });
  });
  return ok(Object.freeze({ status: overall, scenarios: Object.freeze(scenarios) }));
}

// ───────────────────────── آرگومان‌های CLI ─────────────────────────

export type CostArgs = Readonly<{
  /** شمارِ مرده‌های «تأییدشده» در هر سناریو (اکیداً صعودی). */
  scales: readonly number[];
  /** شمارِ مرده‌های تأییدنشدهٔ تازه‌تر (بدترین حالت: تأییدشده‌ها پیش از آن‌ها در ترتیبِ خواندن می‌آیند). */
  unacked: number;
  /** ردیف‌های done که باید در جدول باشند (اثباتِ بی‌اثری‌شان). */
  done: number;
  limit: number;
  repeats: number;
  timeoutMs: number;
  intervalMs: number;
  format: "json" | "text";
}>;

export type CostArgError = Readonly<{ code: "UNKNOWN_FLAG" | "BAD_VALUE" | "POSITIONAL" | "DUPLICATE_FLAG" | "NOT_INCREASING" | "TOO_LARGE"; flag: string | null }>;

export const COST_LIMITS = Object.freeze({ maxRows: 5_000_000, maxScales: 8, maxRepeats: 100, maxLimit: 100_000, maxTimeoutMs: 600_000, maxIntervalMs: 86_400_000 });
export const COST_DEFAULTS = Object.freeze({ scales: Object.freeze([1_000, 10_000, 100_000]), unacked: 3, done: 0, limit: 1_000, repeats: 7, timeoutMs: 5_000, intervalMs: 30_000, format: "json" as const });

const FLAGS: readonly string[] = ["scales", "unacked", "done", "limit", "repeats", "timeout-ms", "interval-ms", "format"];
const FLAG_RE = /^--([a-z][a-z-]{0,20})(?:=([\s\S]*))?$/;
const INT_RE = /^[0-9]{1,9}$/; // رقمِ لاتینِ بدونِ علامت (ارقامِ فارسی/عربی عمداً رد می‌شوند)

const bad = (code: CostArgError["code"], flag: string | null): { ok: false; error: CostArgError } => ({ ok: false, error: Object.freeze({ code, flag }) });

/**
 * `--scales=1000,10000 --unacked=3 --done=0 --limit=1000 --repeats=7 --timeout-ms=5000 --interval-ms=30000 --format=json|text`.
 * فقط نامِ فلگِ شبیهِ فلگ در خطا می‌آید؛ آرگومانِ موضعی (که ممکن است رشتهٔ اتصال باشد) هرگز پژواک نمی‌شود.
 */
export function parseCostArgs(argv: readonly string[]): { ok: true; value: CostArgs } | { ok: false; error: CostArgError } {
  if (!Array.isArray(argv)) return bad("POSITIONAL", null);
  const seen = new Map<string, string>();
  for (const a of argv) {
    if (typeof a !== "string") return bad("POSITIONAL", null);
    const m = FLAG_RE.exec(a);
    if (m === null) return bad("POSITIONAL", null);
    const name = m[1] as string;
    if (!FLAGS.includes(name)) return bad("UNKNOWN_FLAG", name);
    if (m[2] === undefined) return bad("BAD_VALUE", name);
    if (seen.has(name)) return bad("DUPLICATE_FLAG", name);
    seen.set(name, m[2]);
  }
  const intFlag = (name: string, dflt: number, min: number, max: number): number | null => {
    const raw = seen.get(name);
    if (raw === undefined) return dflt;
    if (!INT_RE.test(raw)) return null;
    const n = Number(raw);
    return n >= min && n <= max ? n : null;
  };
  const L = COST_LIMITS;
  const D = COST_DEFAULTS;
  let scales: number[] = [...D.scales];
  const rawScales = seen.get("scales");
  if (rawScales !== undefined) {
    const parts = rawScales.split(",");
    if (parts.length > L.maxScales) return bad("TOO_LARGE", "scales");
    scales = [];
    for (const p of parts) {
      if (!INT_RE.test(p)) return bad("BAD_VALUE", "scales");
      const n = Number(p);
      if (n < 1) return bad("BAD_VALUE", "scales");
      if (n > L.maxRows) return bad("TOO_LARGE", "scales");
      scales.push(n);
    }
    for (let i = 1; i < scales.length; i++) if ((scales[i] as number) <= (scales[i - 1] as number)) return bad("NOT_INCREASING", "scales");
  }
  const unacked = intFlag("unacked", D.unacked, 0, L.maxRows);
  if (unacked === null) return bad("BAD_VALUE", "unacked");
  const done = intFlag("done", D.done, 0, L.maxRows);
  if (done === null) return bad("BAD_VALUE", "done");
  const limit = intFlag("limit", D.limit, 1, L.maxLimit);
  if (limit === null) return bad("BAD_VALUE", "limit");
  const repeats = intFlag("repeats", D.repeats, 1, L.maxRepeats);
  if (repeats === null) return bad("BAD_VALUE", "repeats");
  const timeoutMs = intFlag("timeout-ms", D.timeoutMs, 1, L.maxTimeoutMs);
  if (timeoutMs === null) return bad("BAD_VALUE", "timeout-ms");
  const intervalMs = intFlag("interval-ms", D.intervalMs, 1, L.maxIntervalMs);
  if (intervalMs === null) return bad("BAD_VALUE", "interval-ms");
  const fmt = seen.get("format") ?? D.format;
  if (fmt !== "json" && fmt !== "text") return bad("BAD_VALUE", "format");
  // سقفِ کلِ ردیف‌های ساخته‌شده در بزرگ‌ترین سناریو (دیسکِ یک‌بارمصرف را نمی‌ترکانیم).
  if (Math.max(...scales) + unacked + done > L.maxRows) return bad("TOO_LARGE", "scales");
  return { ok: true, value: Object.freeze({ scales: Object.freeze(scales), unacked, done, limit, repeats, timeoutMs, intervalMs, format: fmt }) };
}

// ───────────────────────── گزارش ─────────────────────────

export type MeasuredScenario = Readonly<{ label: string; ackedDead: number; stats: SampleStats; plan: PlanSummary }>;

export type CostReport = Readonly<{
  version: 1;
  server: string;
  args: Omit<CostArgs, "format">;
  scenarios: readonly MeasuredScenario[];
  /** برازشِ خطیِ p95 بر شمارِ مرده‌های تأییدشده؛ `null` اگر کمتر از دو مقیاسِ متفاوت. */
  fit: LinearFit | null;
  /** شمارِ مرده‌های تأییدشده که مدلِ خطی در آن p95 را به `timeoutMs` می‌رساند؛ `null` = رشدِ بی‌شیب/نامعلوم. */
  horizonToTimeoutAckedRows: number | null;
  /** همان برای نیمِ مهلت (آستانهٔ `READ_NEAR_TIMEOUT`). */
  horizonToNearTimeoutAckedRows: number | null;
  verdict: CostVerdict;
}>;

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/** گزارش را از سناریوهای سنجیده‌شده می‌سازد. برازش روی p95 است (مهلتِ پایش با بدترینِ نمونه‌ها سنجیده می‌شود، نه میانه). */
export function buildReport(input: Readonly<{ server: string; args: CostArgs; scenarios: readonly MeasuredScenario[] }>): CostResult<CostReport, "BAD_BUDGET" | "BAD_MEASURE"> {
  const { args, scenarios } = input;
  const verdict = judgeCost(
    scenarios.map((s) => ({ label: s.label, deadRows: s.ackedDead + args.unacked, stats: s.stats, plan: s.plan })),
    { timeoutMs: args.timeoutMs, intervalMs: args.intervalMs },
  );
  if (!verdict.ok) return verdict;
  const f = fitLinear(scenarios.map((s) => ({ x: s.ackedDead, y: s.stats.p95Ms })));
  const fit = f.ok ? f.value : null;
  const rest = { scales: args.scales, unacked: args.unacked, done: args.done, limit: args.limit, repeats: args.repeats, timeoutMs: args.timeoutMs, intervalMs: args.intervalMs };
  return ok(
    Object.freeze({
      version: 1 as const,
      server: input.server,
      args: Object.freeze(rest),
      scenarios: Object.freeze([...scenarios]),
      fit,
      horizonToTimeoutAckedRows: fit === null ? null : horizonRows(fit, args.timeoutMs),
      horizonToNearTimeoutAckedRows: fit === null ? null : horizonRows(fit, args.timeoutMs * COST_POLICY.nearTimeoutFraction),
      verdict: verdict.value,
    }),
  );
}

/** نمایشِ انسانی (جدولِ ساده). فقط شمارنده‌ها؛ هیچ شناسه/رشتهٔ اتصالی ندارد. */
export function renderText(report: CostReport): string {
  const lines: string[] = [];
  lines.push(`backlog-cost v${report.version} · ${report.server}`);
  lines.push(`limit=${report.args.limit} repeats=${report.args.repeats} timeoutMs=${report.args.timeoutMs} intervalMs=${report.args.intervalMs} unacked=${report.args.unacked} done=${report.args.done}`);
  lines.push("acked-dead  median(ms)  p95(ms)   outbox-rows-scanned  ack-rows  buffers(hit)  verdict");
  for (const s of report.scenarios) {
    const v = report.verdict.scenarios.find((x) => x.label === s.label);
    lines.push(
      [
        String(s.ackedDead).padEnd(11),
        String(r3(s.stats.medianMs)).padEnd(11),
        String(r3(s.stats.p95Ms)).padEnd(9),
        String(s.plan.outboxRowsScanned).padEnd(20),
        String(s.plan.ackRowsTouched).padEnd(9),
        String(s.plan.sharedHitBlocks).padEnd(13),
        `${v?.status ?? "?"}${v !== undefined && v.reasons.length > 0 ? ` (${v.reasons.join(",")})` : ""}`,
      ].join(" "),
    );
  }
  if (report.fit !== null) {
    lines.push(`fit(p95) = ${r3(report.fit.intercept)}ms + ${r3(report.fit.slope * 1000)}ms per 1000 acked · r2=${r3(report.fit.r2)}`);
    lines.push(`horizon: near-timeout at ~${report.horizonToNearTimeoutAckedRows ?? "n/a"} acked, timeout at ~${report.horizonToTimeoutAckedRows ?? "n/a"} acked`);
  }
  lines.push(`overall: ${report.verdict.status}`);
  return `${lines.join("\n")}\n`;
}

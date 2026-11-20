/**
 * tooling/backlog-cost (ADR-0044) — آزمون‌های واحدِ تحلیلِ خالصِ هزینهٔ پایشِ پسماند، بی‌پایگاه.
 * طرح‌های نمونه از خروجیِ واقعیِ PostgreSQL ۱۵ (`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`) گرفته و فقط به فیلدهای مصرفی کوتاه شده‌اند.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COST_DEFAULTS,
  COST_LIMITS,
  COST_POLICY,
  buildReport,
  fitLinear,
  horizonRows,
  judgeCost,
  parseCostArgs,
  renderText,
  scanAmplification,
  summarizePlan,
  summarizeSamples,
} from "./backlog-cost";
import type { PlanSummary, SampleStats, ScenarioMeasure } from "./backlog-cost";

/** طرحِ واقعی: حلقهٔ تو در توی ضدپیوند، ایندکسِ جزئیِ dead و جست‌وجوی کلیدِ اصلیِ جدولِ تأیید (۱۰۰ هزار مرده‌ٔ تأییدشده، ۳ تأییدنشده). */
const NESTED_LOOP = [
  {
    Plan: {
      "Node Type": "Limit",
      "Actual Rows": 3,
      "Actual Loops": 1,
      "Shared Hit Blocks": 299409,
      "Shared Read Blocks": 2906,
      Plans: [
        {
          "Node Type": "Nested Loop",
          "Join Type": "Anti",
          "Actual Rows": 3,
          "Actual Loops": 1,
          "Shared Hit Blocks": 299409,
          "Shared Read Blocks": 2906,
          Plans: [
            { "Node Type": "Index Scan", "Relation Name": "settlement_outbox", "Index Name": "settlement_outbox_dead_idx", "Actual Rows": 100000, "Actual Loops": 1 },
            { "Node Type": "Index Only Scan", "Relation Name": "settlement_dead_ack", "Index Name": "settlement_dead_ack_pk", "Actual Rows": 1, "Actual Loops": 100000 },
          ],
        },
      ],
    },
    "Planning Time": 4.842,
    "Execution Time": 296.734,
  },
];

/** طرحِ موازی با درهم‌سازی: Seq Scan روی outbox با فیلتر، میانگینِ ردیف در هر کارگر × ۲ تکرار. */
const HASH_PARALLEL = [
  {
    Plan: {
      "Node Type": "Limit",
      "Actual Rows": 3,
      "Actual Loops": 1,
      "Shared Hit Blocks": 5000,
      Plans: [
        {
          "Node Type": "Gather Merge",
          "Actual Rows": 3,
          "Actual Loops": 1,
          Plans: [
            {
              "Node Type": "Sort",
              "Actual Rows": 2,
              "Actual Loops": 2,
              Plans: [
                {
                  "Node Type": "Hash Join",
                  "Join Type": "Anti",
                  "Actual Rows": 2,
                  "Actual Loops": 2,
                  Plans: [
                    { "Node Type": "Parallel Seq Scan", "Relation Name": "settlement_outbox", "Actual Rows": 5, "Rows Removed by Filter": 99995, "Actual Loops": 2 },
                    { "Node Type": "Hash", "Actual Rows": 100000, "Actual Loops": 2, Plans: [{ "Node Type": "Seq Scan", "Relation Name": "settlement_dead_ack", "Actual Rows": 99997, "Actual Loops": 2 }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    "Planning Time": 0.9,
    "Execution Time": 69.344,
  },
];

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("backlog-cost · summarizePlan", () => {
  it("حلقهٔ تو در توی واقعی: ردیف‌های اسکن‌شده، جست‌وجوهای تأیید، بافرها، ایندکس‌ها و نبودنِ Sort/Seq Scan", () => {
    const r = summarizePlan(NESTED_LOOP);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      executionMs: 296.734,
      planningMs: 4.842,
      sharedHitBlocks: 299409,
      sharedReadBlocks: 2906,
      outboxRowsScanned: 100000,
      ackRowsTouched: 100000,
      returnedRows: 3,
      seqScanOnOutbox: false,
      sortNode: false,
    });
    expect(r.value.nodeTypes).toEqual(["Limit", "Nested Loop", "Index Scan", "Index Only Scan"]);
    expect(r.value.indexes).toEqual(["settlement_dead_ack_pk", "settlement_outbox_dead_idx"]);
  });

  it("طرحِ موازی: (ردیف + فیلترشده) × تکرار؛ Seq Scan و Sort شناخته می‌شوند؛ نبودنِ فیلدِ بافر = ۰", () => {
    const r = summarizePlan(HASH_PARALLEL);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.outboxRowsScanned).toBe((5 + 99995) * 2);
    expect(r.value.ackRowsTouched).toBe(99997 * 2);
    expect(r.value.sortNode).toBe(true);
    expect(r.value.sharedReadBlocks).toBe(0);
    // «Parallel Seq Scan» نوعِ دقیقِ «Seq Scan» نیست؛ فقط Seq Scanِ ساده پرچم می‌شود (نوعِ موازی را nodeTypes نشان می‌دهد).
    expect(r.value.nodeTypes).toContain("Parallel Seq Scan");
  });

  it("ردیف‌های فیلترشدهٔ جدولِ تأیید هم در ackRowsTouched می‌آید (× تکرار)", () => {
    const p = clone(HASH_PARALLEL);
    const hash = (p[0] as any).Plan.Plans[0].Plans[0].Plans[0].Plans[1];
    const ackScan = hash.Plans[0];
    ackScan["Rows Removed by Filter"] = 50;
    const r = summarizePlan(p);
    expect(r.ok && r.value.ackRowsTouched).toBe((99997 + 50) * 2);
  });

  it("Seq Scanِ ساده روی outbox پرچم می‌خورد، روی جدولِ دیگر نه", () => {
    const p = clone(NESTED_LOOP);
    const scan = (p[0] as { Plan: { Plans: { Plans: Record<string, unknown>[] }[] } }).Plan.Plans[0]!.Plans;
    scan[0]!["Node Type"] = "Seq Scan";
    const r = summarizePlan(p);
    expect(r.ok && r.value.seqScanOnOutbox).toBe(true);
    scan[0]!["Relation Name"] = "other_table";
    const r2 = summarizePlan(p);
    expect(r2.ok && r2.value.seqScanOnOutbox).toBe(false);
    expect(r2.ok && r2.value.outboxRowsScanned).toBe(0);
  });

  it("آرایهٔ تک‌عضوی و شیءِ خالی هر دو پذیرفته؛ خروجی منجمد است", () => {
    const a = summarizePlan(NESTED_LOOP);
    const b = summarizePlan(NESTED_LOOP[0]);
    expect(a).toEqual(b);
    if (a.ok) {
      expect(Object.isFrozen(a.value)).toBe(true);
      expect(Object.isFrozen(a.value.nodeTypes)).toBe(true);
      expect(Object.isFrozen(a.value.indexes)).toBe(true);
    }
  });

  it.each([
    ["null", null],
    ["رشته", "x"],
    ["آرایهٔ تهی", []],
    ["آرایهٔ دوعضوی", [NESTED_LOOP[0], NESTED_LOOP[0]]],
    ["بی‌Plan", [{ "Planning Time": 1, "Execution Time": 1 }]],
    ["Plan رشته", [{ Plan: "x", "Planning Time": 1, "Execution Time": 1 }]],
  ])("شکلِ ناآشنا (%s) ⇒ BAD_PLAN", (_n, raw) => {
    expect(summarizePlan(raw)).toEqual({ ok: false, error: { code: "BAD_PLAN" } });
  });

  it.each([
    ["Execution Time نبود", (p: any) => delete p[0]["Execution Time"]],
    ["Planning Time منفی", (p: any) => (p[0]["Planning Time"] = -1)],
    ["Execution Time نامتناهی", (p: any) => (p[0]["Execution Time"] = Infinity)],
    ["Execution Time رشته", (p: any) => (p[0]["Execution Time"] = "5")],
    ["Actual Rows ریشه نبود", (p: any) => delete p[0].Plan["Actual Rows"]],
    ["بافر منفی", (p: any) => (p[0].Plan["Shared Hit Blocks"] = -5)],
    ["بافر NaN", (p: any) => (p[0].Plan["Shared Read Blocks"] = NaN)],
    ["Plans آرایه نیست", (p: any) => (p[0].Plan.Plans = {})],
    ["زیرگره شیء نیست", (p: any) => (p[0].Plan.Plans = [1])],
    ["Node Type نبود", (p: any) => delete p[0].Plan.Plans[0]["Node Type"]],
    ["Node Type تهی", (p: any) => (p[0].Plan.Plans[0]["Node Type"] = "")],
    ["اسکنِ جدول بی‌Actual Loops", (p: any) => delete p[0].Plan.Plans[0].Plans[0]["Actual Loops"]],
    ["اسکنِ جدول بی‌Actual Rows", (p: any) => delete p[0].Plan.Plans[0].Plans[0]["Actual Rows"]],
    ["Rows Removed منفی", (p: any) => (p[0].Plan.Plans[0].Plans[0]["Rows Removed by Filter"] = -1)],
  ])("%s ⇒ BAD_PLAN (عددِ ساختگی نمی‌دهد)", (_n, mutate) => {
    const p = clone(NESTED_LOOP);
    mutate(p);
    expect(summarizePlan(p)).toEqual({ ok: false, error: { code: "BAD_PLAN" } });
  });

  it("عمقِ بیش از ۲۰۰ و تعدادِ گرهِ بیش از ۱۰٬۰۰۰ ⇒ BAD_PLAN (بی‌سرریزِ پشته)", () => {
    let deep: Record<string, unknown> = { "Node Type": "Result", "Actual Rows": 0, "Actual Loops": 1 };
    for (let i = 0; i < 300; i++) deep = { "Node Type": "Result", "Actual Rows": 0, "Actual Loops": 1, Plans: [deep] };
    expect(summarizePlan([{ Plan: deep, "Planning Time": 1, "Execution Time": 1 }])).toEqual({ ok: false, error: { code: "BAD_PLAN" } });
    const wideOf = (children: number) => [{ Plan: { "Node Type": "Append", "Actual Rows": 0, "Actual Loops": 1, Plans: Array.from({ length: children }, () => ({ "Node Type": "Result", "Actual Rows": 0, "Actual Loops": 1 })) }, "Planning Time": 1, "Execution Time": 1 }];
    expect(summarizePlan(wideOf(10_001))).toEqual({ ok: false, error: { code: "BAD_PLAN" } });
    expect(summarizePlan(wideOf(10_000))).toEqual({ ok: false, error: { code: "BAD_PLAN" } }); // ریشه + ۱۰۰۰۰ = ۱۰۰۰۱ گره
    expect(summarizePlan(wideOf(9_999)).ok).toBe(true); // دقیقاً ۱۰٬۰۰۰ گره پذیرفته است
  });

  it("عمقِ ۲۰۰ دقیقاً پذیرفته و ۲۰۱ رد می‌شود (مرزِ اکیدِ >)", () => {
    const chain = (wraps: number) => {
      let deep: Record<string, unknown> = { "Node Type": "Result", "Actual Rows": 0, "Actual Loops": 1 };
      for (let i = 0; i < wraps; i++) deep = { "Node Type": "Result", "Actual Rows": 0, "Actual Loops": 1, Plans: [deep] };
      return summarizePlan([{ Plan: deep, "Planning Time": 1, "Execution Time": 1 }]);
    };
    expect(chain(200).ok).toBe(true);
    expect(chain(201)).toEqual({ ok: false, error: { code: "BAD_PLAN" } });
  });

  it("scanAmplification: مخرجِ حداقل ۱ و نسبتِ درست", () => {
    expect(scanAmplification({ outboxRowsScanned: 100003, returnedRows: 3 })).toBeCloseTo(33334.33, 1);
    expect(scanAmplification({ outboxRowsScanned: 50, returnedRows: 0 })).toBe(50);
    expect(scanAmplification({ outboxRowsScanned: 0, returnedRows: 0 })).toBe(0);
  });
});

describe("backlog-cost · summarizeSamples", () => {
  const stats = (xs: unknown[]) => {
    const r = summarizeSamples(xs);
    if (!r.ok) throw new Error(r.error.code);
    return r.value;
  };
  it("تعدادِ فرد: میانه عضوِ میانی؛ p95 با رتبهٔ نزدیک‌ترین", () => {
    expect(stats([5, 1, 3])).toEqual({ n: 3, minMs: 1, medianMs: 3, p95Ms: 5, maxMs: 5 });
  });
  it("تعدادِ زوج: میانهٔ دو عضوِ میانی", () => {
    expect(stats([4, 1, 2, 3]).medianMs).toBe(2.5);
  });
  it("یک نمونه: همه برابر", () => {
    expect(stats([7])).toEqual({ n: 1, minMs: 7, medianMs: 7, p95Ms: 7, maxMs: 7 });
  });
  it("۲۰ نمونه: p95 = عضوِ نوزدهم (ceil(0.95·20)=19)، نه بیستم؛ ۲۱ نمونه: عضوِ بیستم", () => {
    const xs = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(stats(xs).p95Ms).toBe(19);
    expect(stats([...xs, 21]).p95Ms).toBe(20);
  });
  it("ورودیِ ورودی را تغییر نمی‌دهد", () => {
    const xs = [3, 1, 2];
    stats(xs);
    expect(xs).toEqual([3, 1, 2]);
  });
  it.each([[[]], ["x"], [null]])("تهی/غیرِ آرایه %j ⇒ NO_SAMPLES", (xs) => {
    expect(summarizeSamples(xs as never)).toEqual({ ok: false, error: { code: "NO_SAMPLES" } });
  });
  it.each([[[1, -1]], [[1, NaN]], [[1, Infinity]], [[1, "2"]], [[1, null]]])("نمونهٔ نامعتبر %j ⇒ BAD_SAMPLE", (xs) => {
    expect(summarizeSamples(xs)).toEqual({ ok: false, error: { code: "BAD_SAMPLE" } });
  });
});

describe("backlog-cost · fitLinear / horizonRows", () => {
  it("خطِ دقیق: شیب و عرض از مبدأ بازیابی می‌شود و r2=1", () => {
    const r = fitLinear([1, 2, 3, 4].map((x) => ({ x, y: 2 * x + 5 })));
    expect(r.ok && r.value.slope).toBeCloseTo(2, 10);
    expect(r.ok && r.value.intercept).toBeCloseTo(5, 10);
    expect(r.ok && r.value.r2).toBeCloseTo(1, 10);
  });
  it("y ثابت: شیبِ صفر و r2=۱ (برازشِ کامل، نه NaN)", () => {
    const r = fitLinear([{ x: 1, y: 3 }, { x: 2, y: 3 }]);
    expect(r).toEqual({ ok: true, value: { slope: 0, intercept: 3, r2: 1 } });
  });
  it("دادهٔ پرنوفه: r2 زیر ۱", () => {
    const r = fitLinear([{ x: 1, y: 1 }, { x: 2, y: 5 }, { x: 3, y: 2 }, { x: 4, y: 6 }]);
    expect(r.ok && r.value.r2 < 1 && r.value.r2 > 0).toBe(true);
  });
  it("کمتر از دو x متفاوت ⇒ TOO_FEW_POINTS؛ نقطهٔ بد ⇒ BAD_POINT", () => {
    expect(fitLinear([])).toEqual({ ok: false, error: { code: "TOO_FEW_POINTS" } });
    expect(fitLinear([{ x: 1, y: 1 }])).toEqual({ ok: false, error: { code: "TOO_FEW_POINTS" } });
    expect(fitLinear([{ x: 1, y: 1 }, { x: 1, y: 2 }])).toEqual({ ok: false, error: { code: "TOO_FEW_POINTS" } });
    expect(fitLinear([{ x: 1, y: 1 }, { x: NaN, y: 2 }])).toEqual({ ok: false, error: { code: "BAD_POINT" } });
    expect(fitLinear([{ x: 1, y: 1 }, { x: 2, y: -2 }])).toEqual({ ok: false, error: { code: "BAD_POINT" } });
    expect(fitLinear([{ x: 1, y: 1 }, null as never])).toEqual({ ok: false, error: { code: "BAD_POINT" } });
    expect(fitLinear(null as never)).toEqual({ ok: false, error: { code: "TOO_FEW_POINTS" } });
  });
  it("horizonRows: وارونِ خط، گرد به پایین؛ شیبِ غیرمثبت ⇒ null؛ بودجهٔ زیرِ عرض از مبدأ ⇒ ۰", () => {
    expect(horizonRows({ slope: 2, intercept: 5, r2: 1 }, 25)).toBe(10);
    expect(horizonRows({ slope: 2, intercept: 5, r2: 1 }, 26)).toBe(10); // 10.5 ↓
    expect(horizonRows({ slope: 2, intercept: 50, r2: 1 }, 25)).toBe(0);
    expect(horizonRows({ slope: 0, intercept: 5, r2: 1 }, 25)).toBeNull();
    expect(horizonRows({ slope: -1, intercept: 5, r2: 1 }, 25)).toBeNull();
    expect(horizonRows({ slope: 2, intercept: 5, r2: 1 }, NaN)).toBeNull();
    expect(horizonRows({ slope: 2, intercept: 5, r2: 1 }, -1)).toBeNull();
  });
});

const stat = (p95: number, median = p95): SampleStats => ({ n: 7, minMs: median, medianMs: median, p95Ms: p95, maxMs: p95 });
const plan = (over: Partial<PlanSummary> = {}): PlanSummary => ({
  executionMs: 1,
  planningMs: 1,
  sharedHitBlocks: 1,
  sharedReadBlocks: 0,
  outboxRowsScanned: 100,
  ackRowsTouched: 100,
  returnedRows: 3,
  nodeTypes: ["Limit"],
  indexes: [],
  seqScanOnOutbox: false,
  sortNode: false,
  ...over,
});
const measure = (over: Partial<ScenarioMeasure> = {}): ScenarioMeasure => ({ label: "s", deadRows: 103, stats: stat(10), plan: plan(), ...over });
const B = { timeoutMs: 5000, intervalMs: 30000 };
const judged = (m: ScenarioMeasure, b = B) => {
  const r = judgeCost([m], b);
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
};

describe("backlog-cost · judgeCost", () => {
  it("سیاستِ قفل‌شده", () => {
    expect(COST_POLICY).toEqual({ nearTimeoutFraction: 0.5, dutyCycleWarn: 0.05, wideScanAmplification: 100, wideScanMinRows: 10_000, nonDeadTolerance: 0.05, nonDeadSlack: 10 });
    expect(Object.isFrozen(COST_POLICY)).toBe(true);
  });
  it("سناریوی سالم ⇒ ok بی‌دلیل", () => {
    expect(judged(measure())).toEqual({ status: "ok", scenarios: [{ label: "s", status: "ok", reasons: [] }] });
  });
  it("مرزِ مهلت: p95 = timeout ⇒ fail؛ یکی کمتر ⇒ فقط warn(NEAR)", () => {
    expect(judged(measure({ stats: stat(5000, 1) })).scenarios[0]).toEqual({ label: "s", status: "fail", reasons: ["READ_EXCEEDS_TIMEOUT"] });
    expect(judged(measure({ stats: stat(4999.9, 1) })).scenarios[0]).toEqual({ label: "s", status: "warn", reasons: ["READ_NEAR_TIMEOUT"] });
  });
  it("مرزِ نیمِ مهلت: p95 = ۲۵۰۰ ⇒ warn؛ ۲۴۹۹٫۹ ⇒ ok", () => {
    expect(judged(measure({ stats: stat(2500, 1) })).status).toBe("warn");
    expect(judged(measure({ stats: stat(2499.9, 1) })).status).toBe("ok");
  });
  it("مرزِ چرخهٔ کار: میانه/بازه = ۵٪ ⇒ warn (۱۵۰۰ از ۳۰۰۰۰)؛ ۱۴۹۹ ⇒ ok", () => {
    const r = judged(measure({ stats: stat(1500, 1500) }));
    expect(r.scenarios[0]?.reasons).toEqual(["DUTY_CYCLE_HIGH"]);
    expect(judged(measure({ stats: stat(1499, 1499) })).status).toBe("ok");
  });
  it("تقویتِ اسکن: فقط با دست‌کم ۱۰٬۰۰۰ ردیفِ اسکن‌شده و ضریبِ ≥۱۰۰", () => {
    const wide = (rows: number, returned: number) => judged(measure({ deadRows: rows, plan: plan({ outboxRowsScanned: rows, returnedRows: returned }) })).scenarios[0]?.reasons;
    expect(wide(10_000, 100)).toEqual(["WIDE_SCAN"]); // ضریب ۱۰۰ دقیقاً
    expect(wide(10_000, 101)).toEqual([]); // ضریب ≈ ۹۹٫۰۱
    expect(wide(9_999, 1)).toEqual([]); // زیرِ حدِ ردیف
  });
  it("ردیفِ غیرِ dead اسکن شده: بالاتر از deadRows×1.05+10 ⇒ NON_DEAD_ROWS_SCANNED؛ در خودِ مرز نه", () => {
    const r = (scanned: number) => judged(measure({ deadRows: 1000, plan: plan({ outboxRowsScanned: scanned }) })).scenarios[0]?.reasons;
    expect(r(1060)).toEqual([]); // 1000×1.05+10 = 1060
    expect(r(1061)).toEqual(["NON_DEAD_ROWS_SCANNED"]);
    expect(r(300_003)).toEqual(["WIDE_SCAN", "NON_DEAD_ROWS_SCANNED"]); // ترتیبِ ثابتِ دلیل‌ها
  });
  it("حکمِ کل بدترینِ سناریوهاست و ترتیب حفظ می‌شود", () => {
    const r = judgeCost([measure({ label: "a" }), measure({ label: "b", stats: stat(6000) }), measure({ label: "c", stats: stat(3000, 1) })], B);
    expect(r.ok && r.value.status).toBe("fail");
    expect(r.ok && r.value.scenarios.map((s) => `${s.label}:${s.status}`)).toEqual(["a:ok", "b:fail", "c:warn"]);
    expect(judgeCost([], B)).toEqual({ ok: true, value: { status: "ok", scenarios: [] } });
  });
  it("دلیل‌های چندگانه هم‌زمان؛ fail بر warn غلبه دارد", () => {
    const r = judged(measure({ deadRows: 10, stats: stat(6000, 2000), plan: plan({ outboxRowsScanned: 20_000, returnedRows: 1 }) }));
    expect(r.status).toBe("fail");
    expect(r.scenarios[0]?.reasons).toEqual(["READ_EXCEEDS_TIMEOUT", "DUTY_CYCLE_HIGH", "WIDE_SCAN", "NON_DEAD_ROWS_SCANNED"]);
  });
  it.each([[{ timeoutMs: 0, intervalMs: 1 }], [{ timeoutMs: 1, intervalMs: 0 }], [{ timeoutMs: -1, intervalMs: 1 }], [{ timeoutMs: NaN, intervalMs: 1 }], [{ timeoutMs: 1 }], [null]])("بودجهٔ نامعتبر %j ⇒ BAD_BUDGET", (b) => {
    expect(judgeCost([measure()], b as never)).toEqual({ ok: false, error: { code: "BAD_BUDGET" } });
  });
});

describe("backlog-cost · parseCostArgs", () => {
  const ok = (argv: string[]) => {
    const r = parseCostArgs(argv);
    if (!r.ok) throw new Error(`${r.error.code}:${r.error.flag}`);
    return r.value;
  };
  it("پیش‌فرض‌ها (هم‌ارزِ پیش‌فرضِ پایشِ ADR-0042: limit=۱۰۰۰، timeout=۵ث، interval=۳۰ث) و منجمد", () => {
    const v = ok([]);
    expect(v).toEqual({ scales: [1000, 10000, 100000], unacked: 3, done: 0, limit: 1000, repeats: 7, timeoutMs: 5000, intervalMs: 30000, format: "json" });
    expect(Object.isFrozen(v)).toBe(true);
    expect(Object.isFrozen(v.scales)).toBe(true);
    expect(COST_DEFAULTS.limit).toBe(1000);
  });
  it("همهٔ فلگ‌ها", () => {
    expect(ok(["--scales=5,50", "--unacked=0", "--done=9", "--limit=2", "--repeats=1", "--timeout-ms=7", "--interval-ms=8", "--format=text"])).toEqual({
      scales: [5, 50],
      unacked: 0,
      done: 9,
      limit: 2,
      repeats: 1,
      timeoutMs: 7,
      intervalMs: 8,
      format: "text",
    });
  });
  it("مقدارِ پیش‌فرضِ مقیاس‌ها مستقل از اجرا (تغییرِ نتیجه روی پیش‌فرضِ مشترک اثر نمی‌گذارد)", () => {
    const a = ok([]);
    expect(a.scales).not.toBe(COST_DEFAULTS.scales);
  });
  it.each([
    [["--nope=1"], "UNKNOWN_FLAG", "nope"],
    [["--scales"], "BAD_VALUE", "scales"],
    [["--scales="], "BAD_VALUE", "scales"],
    [["--scales=1,,2"], "BAD_VALUE", "scales"],
    [["--scales=0"], "BAD_VALUE", "scales"],
    [["--scales=-1"], "BAD_VALUE", "scales"],
    [["--scales=1.5"], "BAD_VALUE", "scales"],
    [["--scales=۱۰۰"], "BAD_VALUE", "scales"],
    [["--scales=10,10"], "NOT_INCREASING", "scales"],
    [["--scales=10,5"], "NOT_INCREASING", "scales"],
    [["--scales=5000001"], "TOO_LARGE", "scales"],
    [["--scales=1234567890"], "BAD_VALUE", "scales"], // ده رقم: سقفِ نُه‌رقمیِ INT_RE (جلوگیری از اعدادِ غیرِ امن)
    [["--limit=1234567890"], "BAD_VALUE", "limit"],
    [["--scales=1,2,3,4,5,6,7,8,9"], "TOO_LARGE", "scales"],
    [["--scales=4999999", "--unacked=2"], "TOO_LARGE", "scales"],
    [["--scales=100", "--done=5000000"], "TOO_LARGE", "scales"],
    [["--unacked=x"], "BAD_VALUE", "unacked"],
    [["--done=-1"], "BAD_VALUE", "done"],
    [["--limit=0"], "BAD_VALUE", "limit"],
    [["--limit=100001"], "BAD_VALUE", "limit"],
    [["--repeats=0"], "BAD_VALUE", "repeats"],
    [["--repeats=101"], "BAD_VALUE", "repeats"],
    [["--timeout-ms=0"], "BAD_VALUE", "timeout-ms"],
    [["--timeout-ms=600001"], "BAD_VALUE", "timeout-ms"],
    [["--interval-ms=0"], "BAD_VALUE", "interval-ms"],
    [["--interval-ms=86400001"], "BAD_VALUE", "interval-ms"],
    [["--format=yaml"], "BAD_VALUE", "format"],
    [["--limit=1", "--limit=2"], "DUPLICATE_FLAG", "limit"],
  ])("%j ⇒ %s (%s)", (argv, code, flag) => {
    expect(parseCostArgs(argv)).toEqual({ ok: false, error: { code, flag } });
  });
  it("سقفِ ردیف دقیقاً مجاز است (۵٬۰۰۰٬۰۰۰ با unacked=0 و done=0)، یک بیشتر رد", () => {
    expect(ok(["--scales=5000000", "--unacked=0", "--done=0"]).scales).toEqual([5_000_000]);
    expect(parseCostArgs(["--scales=5000000", "--unacked=1", "--done=0"])).toEqual({ ok: false, error: { code: "TOO_LARGE", flag: "scales" } });
    expect(parseCostArgs(["--scales=1", "--unacked=5000000", "--done=1"])).toEqual({ ok: false, error: { code: "TOO_LARGE", flag: "scales" } });
  });
  it("مرزهای مجاز پذیرفته می‌شوند", () => {
    expect(ok([`--scales=${COST_LIMITS.maxRows - 3}`, "--unacked=3", "--done=0"]).scales).toEqual([COST_LIMITS.maxRows - 3]);
    expect(ok(["--limit=100000", "--repeats=100", "--timeout-ms=600000", "--interval-ms=86400000"]).repeats).toBe(100);
    expect(ok(["--scales=1,2,3,4,5,6,7,8"]).scales).toHaveLength(8);
  });
  it("آرگومانِ موضعی (مثلاً رشتهٔ اتصال) هرگز پژواک نمی‌شود، و فلگِ ناشناخته فقط نامش را می‌دهد نه مقدارش", () => {
    const secret = ["postgres", "://u:", "pw", "@h/db"].join("");
    for (const argv of [[secret], ["--unknown=" + secret], ["--limit=" + secret], ["--format=" + secret], [`--scales=${secret}`]]) {
      const r = parseCostArgs(argv);
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain("pw");
      expect(JSON.stringify(r)).not.toContain("postgres");
    }
    expect(parseCostArgs([secret])).toEqual({ ok: false, error: { code: "POSITIONAL", flag: null } });
  });
  it("ورودیِ غیرِ آرایه/غیرِ رشته ⇒ POSITIONAL بی‌پرتاب", () => {
    expect(parseCostArgs(null as never)).toEqual({ ok: false, error: { code: "POSITIONAL", flag: null } });
    expect(parseCostArgs([1 as never])).toEqual({ ok: false, error: { code: "POSITIONAL", flag: null } });
  });
  it("مقدارِ چندخطی با فلگِ معتبر رد می‌شود، نه POSITIONAL مبهم (و پژواک نمی‌شود)", () => {
    expect(parseCostArgs(["--limit=1\n2"])).toEqual({ ok: false, error: { code: "BAD_VALUE", flag: "limit" } });
  });
});

describe("backlog-cost · buildReport / renderText", () => {
  const args = ok0();
  function ok0() {
    const r = parseCostArgs([]);
    if (!r.ok) throw new Error("args");
    return r.value;
  }
  const sc = (acked: number, p95: number, scanned = acked + 3) => ({ label: `acked=${acked}`, ackedDead: acked, stats: stat(p95, p95 / 2), plan: plan({ outboxRowsScanned: scanned, ackRowsTouched: acked, returnedRows: 3 }) });
  it("برازش روی p95 و افق‌ها؛ deadRows = مرده‌های تأییدشده + تأییدنشده", () => {
    const r = buildReport({ server: "postgresql 15.19", args, scenarios: [sc(1000, 3), sc(10000, 12), sc(100000, 102)] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.version).toBe(1);
    expect(r.value.fit?.slope).toBeCloseTo(0.001, 4);
    expect(r.value.horizonToTimeoutAckedRows).toBeGreaterThan(4_000_000);
    expect(r.value.horizonToNearTimeoutAckedRows).toBeLessThan(r.value.horizonToTimeoutAckedRows as number);
    expect(r.value.verdict.status).toBe("warn"); // WIDE_SCAN در ۱۰k و ۱۰۰k
    expect(r.value.args).not.toHaveProperty("format");
    expect(Object.isFrozen(r.value)).toBe(true);
  });
  it("deadRows شاملِ تأییدنشده‌هاست: ۱۰۰٬۰۰۰ تأییدنشدهٔ خوانده‌شده ردیفِ «غیرِ dead» حساب نمی‌شود", () => {
    const many = { ...args, scales: [1000], unacked: 100_000 };
    const r = buildReport({ server: "s", args: many, scenarios: [sc(1000, 3, 101_000)] });
    expect(r.ok && r.value.verdict.scenarios[0]?.reasons).not.toContain("NON_DEAD_ROWS_SCANNED");
    const extra = buildReport({ server: "s", args: many, scenarios: [sc(1000, 3, 160_000)] });
    expect(extra.ok && extra.value.verdict.scenarios[0]?.reasons).toContain("NON_DEAD_ROWS_SCANNED");
  });
  it("افق‌ها دقیقاً از مدلِ خطی و از timeoutMs (نه intervalMs) می‌آیند: y = ۰٫۰۰۱x + ۲", () => {
    const r = buildReport({ server: "s", args: { ...args, timeoutMs: 5000, intervalMs: 999_999 }, scenarios: [sc(1000, 3), sc(10000, 12), sc(100000, 102)] });
    if (!r.ok) throw new Error("report");
    expect(Math.abs((r.value.horizonToTimeoutAckedRows as number) - 4_998_000)).toBeLessThanOrEqual(1);
    expect(Math.abs((r.value.horizonToNearTimeoutAckedRows as number) - 2_498_000)).toBeLessThanOrEqual(1);
  });
  it("یک مقیاس ⇒ برازش و افق null", () => {
    const r = buildReport({ server: "s", args: { ...args, scales: [1000] }, scenarios: [sc(1000, 3)] });
    expect(r.ok && r.value.fit).toBeNull();
    expect(r.ok && r.value.horizonToTimeoutAckedRows).toBeNull();
  });
  it("هزینهٔ ثابت (شیب ≤ ۰) ⇒ افقِ null (نامحدود)", () => {
    const r = buildReport({ server: "s", args, scenarios: [sc(1000, 3), sc(10000, 3)] });
    expect(r.ok && r.value.fit?.slope).toBe(0);
    expect(r.ok && r.value.horizonToTimeoutAckedRows).toBeNull();
  });
  it("بودجهٔ ناممکن در args ⇒ BAD_BUDGET", () => {
    expect(buildReport({ server: "s", args: { ...args, timeoutMs: 0 }, scenarios: [sc(1000, 3)] })).toEqual({ ok: false, error: { code: "BAD_BUDGET" } });
  });
  it("renderText: سرایند، یک خط به‌ازای هر سناریو، برازش، افق و حکمِ کل؛ بی‌رشتهٔ اتصال", () => {
    const r = buildReport({ server: "postgresql 15.19", args, scenarios: [sc(1000, 3, 1003), sc(100000, 102, 100003)] });
    if (!r.ok) throw new Error("report");
    const text = renderText(r.value);
    const lines = text.trimEnd().split("\n");
    expect(lines[0]).toBe("backlog-cost v1 · postgresql 15.19");
    expect(lines[1]).toBe("limit=1000 repeats=7 timeoutMs=5000 intervalMs=30000 unacked=3 done=0");
    expect(lines[2]).toMatch(/^acked-dead\s+median\(ms\)\s+p95\(ms\)/);
    expect(lines[3]).toMatch(/^1000\s+1\.5\s+3\s+1003\s+1000\s+1\s+ok$/);
    expect(lines[4]).toMatch(/^100000\s+51\s+102\s+100003\s+100000\s+1\s+warn \(WIDE_SCAN\)$/);
    expect(lines[5]).toMatch(/^fit\(p95\) = .*ms per 1000 acked · r2=/);
    expect(lines[6]).toMatch(/^horizon: near-timeout at ~\d+ acked, timeout at ~\d+ acked$/);
    expect(lines[7]).toBe("overall: warn");
    expect(text.endsWith("\n")).toBe(true);
  });
  it("renderText بی‌برازش: خطِ fit/horizon نمی‌آید", () => {
    const r = buildReport({ server: "s", args: { ...args, scales: [1000] }, scenarios: [sc(1000, 3)] });
    if (!r.ok) throw new Error("report");
    expect(renderText(r.value)).not.toContain("fit(p95)");
    expect(renderText(r.value)).not.toContain("horizon");
  });
});

describe("backlog-cost · نگهبانِ منبع (خلوص)", () => {
  const src = readFileSync(join(__dirname, "backlog-cost.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  it("بی‌import، بی‌process/ساعت/تصادفی/فایل/شبکه؛ بی‌ساختارِ غیرِ قابل‌حذف (enum/namespace)", () => {
    expect(src).not.toMatch(/^\s*import\s/m);
    for (const banned of [/\bprocess\b/, /Date\.now|new Date\(/, /Math\.random/, /performance\./, /\brequire\(/, /\bfetch\(/, /\bsetTimeout\b/, /^\s*(export\s+)?(const\s+)?enum\s/m, /^\s*(export\s+)?namespace\s/m]) {
      expect(src).not.toMatch(banned);
    }
  });
});

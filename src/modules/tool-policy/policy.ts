/**
 * پیش‌فرض‌های کد، کرانِ فیلدها (از ماژول‌های پایین‌دست؛ نه نسخهٔ دوم) و نسبت‌های زمانی (ADR-0067).
 * **هیچ‌یک عددِ حقوقی یا قیمت نیست**؛ همه آستانهٔ مهندسی‌اند و در `docs/adr/0067-tool-policy.md` با دلیل آمده‌اند.
 */
import { LIMITS } from "@/modules/ledger";
import { CALL_DEADLINE_LIMITS } from "@/modules/tool-call-deadline";
import { MAX_CARDS_CEILING } from "@/modules/calc-answer-cards";
import { CONFIG_LIMITS } from "@/modules/metering";
import { LOOP_LIMITS } from "@/modules/tool-loop";
import { RUNNER_LIMITS } from "@/modules/tool-runner";
import type { ToolPolicy } from "./types";

/** نسبت‌های تأییدشدهٔ مالک (ADR-0067 بند ۱): `maxCallMs ≈ ۴۰٪ graceMs` و `ttl = ۴×graceMs`. اعدادِ صحیح؛ بی‌اعشار. */
export const POLICY_RATIOS = Object.freeze({ callSharePercent: 40, ttlFactor: 4 });

/** کرانِ سیاستی (نه فنی): کف و حاشیهٔ تسویه. سخت‌گیرانه‌تر از آن‌چه `checkTimingRelations` می‌خواهد. */
export const POLICY_LIMITS = Object.freeze({
  /** `graceMs` کمتر از این حاشیهٔ کافی برای تسویهٔ پس از سقفِ تماس نمی‌گذارد. */
  minGraceMs: 30_000,
  /** `maxCallMs` حداکثر نیمِ `graceMs` است ⇒ حاشیهٔ تسویه دست‌کم برابرِ خودِ سقفِ تماس. */
  maxCallShareDenominator: 2,
  maxOutputTokens: 65_536,
  maxModelNameChars: 64,
});

export const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export type IntSpec = Readonly<{ kind: "int"; lo: number; hi: number }>;
export type EnumSpec = Readonly<{ kind: "enum"; values: readonly string[] }>;
export type NameSpec = Readonly<{ kind: "name" }>;
export type FieldSpec = IntSpec | EnumSpec | NameSpec;

const int = (lo: number, hi: number): IntSpec => Object.freeze({ kind: "int" as const, lo, hi });

/** منبعِ حقیقتِ شکلِ سیاست: بخش‌ها و کلیدها به ترتیبِ ثابت (ترتیبِ گزارشِ مشکل‌ها). */
export const POLICY_SCHEMA: Readonly<Record<keyof ToolPolicy, Readonly<Record<string, FieldSpec>>>> = Object.freeze({
  loop: Object.freeze({
    maxSteps: int(1, LOOP_LIMITS.maxSteps),
    maxToolCalls: int(1, LOOP_LIMITS.maxToolCalls),
    maxIdenticalCalls: int(1, LOOP_LIMITS.maxIdenticalCalls),
    truncationRetries: int(0, LOOP_LIMITS.maxTruncationRetries),
  }),
  run: Object.freeze({
    totalTimeoutMs: int(RUNNER_LIMITS.minTotalTimeoutMs, RUNNER_LIMITS.maxTotalTimeoutMs),
    toolTimeoutMs: int(RUNNER_LIMITS.minToolTimeoutMs, RUNNER_LIMITS.maxToolTimeoutMs),
    maxResultChars: int(RUNNER_LIMITS.minResultChars, RUNNER_LIMITS.maxResultChars),
  }),
  answer: Object.freeze({
    maxCards: int(1, MAX_CARDS_CEILING),
    maxOutputTokens: int(1, POLICY_LIMITS.maxOutputTokens),
  }),
  model: Object.freeze({
    name: Object.freeze({ kind: "name" as const }),
    timeoutMs: int(CALL_DEADLINE_LIMITS.minMs, CALL_DEADLINE_LIMITS.maxMs),
  }),
  timing: Object.freeze({
    graceMs: int(1, LIMITS.MAX_TTL_MS / 2),
    maxCallMs: int(CALL_DEADLINE_LIMITS.minMs, CALL_DEADLINE_LIMITS.maxMs),
    reservationTtlMs: int(LIMITS.MIN_TTL_MS, LIMITS.MAX_TTL_MS),
  }),
  metering: Object.freeze({
    perMessageOverheadTokens: int(0, CONFIG_LIMITS.maxOverheadTokens),
    onUnknownCost: Object.freeze({ kind: "enum" as const, values: Object.freeze(["forfeit", "release"]) }),
  }),
});

export const SECTION_ORDER: readonly (keyof ToolPolicy)[] = Object.freeze(["loop", "run", "answer", "model", "timing", "metering"] as const);

/**
 * پیش‌فرض‌های کد (ADR-0067 بند ۲). زمان: `graceMs = ۹۰ s` ⇒ `maxCallMs = ۳۶ s` (۴۰٪) ⇒ `ttl = ۳۶۰ s` (۴×) و مهلتِ خودِ دروازه `۳۰ s < ۳۶ s`
 * تا زمان‌سنجِ دروازه (که هزینه را گزارش می‌دهد) معمولاً پیش از سقفِ سخت برنده شود. `forfeit`: هزینهٔ نامعلوم هرگز رایگان نمی‌شود.
 */
export const DEFAULT_TOOL_POLICY: ToolPolicy = Object.freeze({
  loop: Object.freeze({ maxSteps: 8, maxToolCalls: 16, maxIdenticalCalls: 2, truncationRetries: 1 }),
  run: Object.freeze({ totalTimeoutMs: 180_000, toolTimeoutMs: 5_000, maxResultChars: 4_000 }),
  answer: Object.freeze({ maxCards: 5, maxOutputTokens: 1_024 }),
  model: Object.freeze({ name: "calc-answer", timeoutMs: 30_000 }),
  timing: Object.freeze({ graceMs: 90_000, maxCallMs: 36_000, reservationTtlMs: 360_000 }),
  metering: Object.freeze({ perMessageOverheadTokens: 16, onUnknownCost: "forfeit" as const }),
});

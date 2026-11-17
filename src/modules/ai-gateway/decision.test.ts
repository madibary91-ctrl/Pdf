import { describe, expect, it } from "vitest";
import { decideNext } from "./index";
import type { DecisionInput } from "./index";
import { resolvePolicy } from "./resilience-policy";
import type { ResolvedPolicy } from "./resilience-types";
import { BASE_POLICY } from "./resilience-kit";

const NAMES = new Set(["m1", "m2", "m3"]);
function pol(over: Record<string, unknown> = {}): ResolvedPolicy {
  const r = resolvePolicy({ ...BASE_POLICY, ...over }, NAMES);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}
function di(over: Partial<DecisionInput> = {}, policyOver: Record<string, unknown> = {}): DecisionInput {
  return {
    code: "PROVIDER_UNAVAILABLE",
    retryable: true,
    retryAfterMs: null,
    position: 0,
    chainLength: 1,
    modelAttempt: 1,
    callsMade: 1,
    remainingMs: 100_000,
    policy: pol(policyOver),
    jitterUnit: () => 1,
    ...over,
  };
}
const retry = (waitMs: number) => ({ kind: "retry", waitMs });
const stop = (reason: string) => ({ kind: "stop", reason });
const NEXT = { kind: "next_model" };

describe("decideNext · خطاهای بی‌تلاش", () => {
  it("ABORTED همیشه می‌ایستد (حتی با بودجهٔ پر یا جایگزین موجود)", () => {
    expect(decideNext(di({ code: "ABORTED", retryable: false, chainLength: 2 }))).toEqual(stop("aborted"));
    expect(decideNext(di({ code: "ABORTED", callsMade: 99 }))).toEqual(stop("aborted"));
  });
  it.each(["INVALID_REQUEST", "UNKNOWN_MODEL", "INVALID_CONFIG", "INTERNAL_ERROR"] as const)("%s بر مدل اصلی ⇒ non_retryable (جایگزین هم ندارد)", (code) => {
    expect(decideNext(di({ code, retryable: false, chainLength: 3 }))).toEqual(stop("non_retryable"));
  });
  it("UNKNOWN_MODEL/INTERNAL_ERROR بر جایگزین هم می‌ایستد (فقط INVALID_REQUEST رد می‌شود)", () => {
    for (const code of ["UNKNOWN_MODEL", "INTERNAL_ERROR", "INVALID_CONFIG"] as const) {
      expect(decideNext(di({ code, retryable: false, position: 1, chainLength: 3 }))).toEqual(stop("non_retryable"));
    }
  });
  it("علتِ توقفِ خطاهای بی‌تلاش با پر بودن بودجه عوض نمی‌شود: non_retryable، نه budget_exhausted", () => {
    for (const code of ["INVALID_REQUEST", "UNKNOWN_MODEL", "INVALID_CONFIG", "INTERNAL_ERROR"] as const) {
      expect(decideNext(di({ code, retryable: false, callsMade: 99 })), code).toEqual(stop("non_retryable"));
    }
  });
  it("INVALID_REQUEST بر جایگزین ⇒ رد بی‌هزینه و رفتن به بعدی؛ آخرین ⇒ chain_exhausted؛ بودجه مانعش نیست", () => {
    expect(decideNext(di({ code: "INVALID_REQUEST", retryable: false, position: 1, chainLength: 3 }))).toEqual(NEXT);
    expect(decideNext(di({ code: "INVALID_REQUEST", retryable: false, position: 2, chainLength: 3 }))).toEqual(stop("chain_exhausted"));
    expect(decideNext(di({ code: "INVALID_REQUEST", retryable: false, position: 1, chainLength: 3, callsMade: 6 }))).toEqual(NEXT);
  });
});

describe("decideNext · تلاش دوباره", () => {
  it("backoff نمایی در هر تلاش؛ در سقفِ هر مدل می‌ایستد", () => {
    expect(decideNext(di({ modelAttempt: 1 }))).toEqual(retry(100));
    expect(decideNext(di({ modelAttempt: 2 }))).toEqual(retry(200));
    expect(decideNext(di({ modelAttempt: 3 }))).toEqual(stop("attempts_exhausted"));
  });
  it("دو کلید: هم در retryOn هم retryable هسته؛ هر یک نباشد تلاش نیست", () => {
    expect(decideNext(di({ retryable: false }))).toEqual(stop("non_retryable"));
    expect(decideNext(di({}, { retryOn: ["PROVIDER_RATE_LIMITED"] }))).toEqual(stop("non_retryable"));
    expect(decideNext(di({ code: "PROVIDER_RATE_LIMITED" }, { retryOn: ["PROVIDER_RATE_LIMITED"] }))).toEqual(retry(100));
  });
  it("بدون تلاش دوباره (maxAttemptsPerModel=1): اولین شکست نهایی است", () => {
    expect(decideNext(di({}, { maxAttemptsPerModel: 1, retryOn: [] }))).toEqual(stop("non_retryable"));
    expect(decideNext(di({}, { maxAttemptsPerModel: 1 }))).toEqual(stop("attempts_exhausted"));
  });
  it("کدهای غیرقابل‌تلاش (AUTH، REJECTED، BAD_RESPONSE، PROVIDER_ERROR) هرگز تلاش نمی‌شوند", () => {
    for (const code of ["PROVIDER_AUTH", "PROVIDER_REJECTED", "PROVIDER_BAD_RESPONSE", "PROVIDER_ERROR"] as const) {
      expect(decideNext(di({ code, retryable: false }, { fallbackOn: [] }))).toEqual(stop("non_retryable"));
    }
  });
});

describe("decideNext · بودجهٔ کل و زمان", () => {
  it("callsMade به سقف رسید ⇒ budget_exhausted (پیش از تلاش دوباره و جایگزین)؛ یکی کمتر ⇒ ادامه", () => {
    expect(decideNext(di({ callsMade: 6, chainLength: 2 }))).toEqual(stop("budget_exhausted"));
    expect(decideNext(di({ callsMade: 5 }))).toEqual(retry(100));
    expect(decideNext(di({ callsMade: 7 }))).toEqual(stop("budget_exhausted"));
  });
  it("مرز زمان: انتظار + ۱ms باید جا شود", () => {
    expect(decideNext(di({ remainingMs: 101 }))).toEqual(retry(100));
    expect(decideNext(di({ remainingMs: 100 }))).toEqual(stop("deadline"));
    expect(decideNext(di({ remainingMs: 0 }))).toEqual(stop("deadline"));
  });
  it("نخواندنِ زمان ⇒ اگر جایگزین مجاز باشد به آن می‌رود، وگرنه deadline", () => {
    expect(decideNext(di({ remainingMs: 50, chainLength: 2 }))).toEqual(NEXT);
    expect(decideNext(di({ remainingMs: 50, chainLength: 2 }, { fallbackOn: [] }))).toEqual(stop("deadline"));
  });
});

describe("decideNext · retryAfterMs (کف؛ هرگز زودتر)", () => {
  const rl = (extra: Partial<DecisionInput> = {}, over: Record<string, unknown> = {}) => di({ code: "PROVIDER_RATE_LIMITED", ...extra }, over);
  it("بزرگ‌تر از backoff ⇒ خودش؛ کوچک‌تر ⇒ backoff؛ مساوی سقف ⇒ مجاز", () => {
    expect(decideNext(rl({ retryAfterMs: 700 }))).toEqual(retry(700));
    expect(decideNext(rl({ retryAfterMs: 10 }))).toEqual(retry(100));
    expect(decideNext(rl({ retryAfterMs: 0 }))).toEqual(retry(100));
    expect(decideNext(rl({ retryAfterMs: 1000 }))).toEqual(retry(1000));
  });
  it("بیش از maxDelayMs ⇒ بر همین مدل تلاش نمی‌شود: retry_after_too_long، یا جایگزین", () => {
    expect(decideNext(rl({ retryAfterMs: 1001 }))).toEqual(stop("retry_after_too_long"));
    expect(decideNext(rl({ retryAfterMs: 1001, chainLength: 2 }))).toEqual(NEXT);
  });
  it("با jitter کامل و u=۰، کفِ retryAfter همچنان رعایت می‌شود", () => {
    expect(decideNext(rl({ retryAfterMs: 300, jitterUnit: () => 0 }, { backoff: { baseDelayMs: 100, maxDelayMs: 1000, jitter: "full" }, random: { next: () => 0 } }))).toEqual(retry(300));
  });
  it("retryAfter + ۱ باید در زمان باقی‌مانده جا شود", () => {
    expect(decideNext(rl({ retryAfterMs: 700, remainingMs: 701 }))).toEqual(retry(700));
    expect(decideNext(rl({ retryAfterMs: 700, remainingMs: 700 }))).toEqual(stop("deadline"));
  });
});

describe("decideNext · jitter: تصادف فقط وقتی لازم است و فقط یک‌بار مصرف می‌شود", () => {
  const J = (jitter: string) => ({ backoff: { baseDelayMs: 100, maxDelayMs: 1000, jitter }, random: { next: () => 0 } });
  it("none: هرگز صدا زده نمی‌شود", () => {
    let n = 0;
    decideNext(di({ jitterUnit: () => (n++, 0) }));
    expect(n).toBe(0);
  });
  it("full/equal: دقیقاً یک‌بار و مقدارش اعمال می‌شود", () => {
    let n = 0;
    expect(decideNext(di({ jitterUnit: () => (n++, 0.5) }, J("full")))).toEqual(retry(50));
    expect(n).toBe(1);
    n = 0;
    expect(decideNext(di({ jitterUnit: () => (n++, 0.5) }, J("equal")))).toEqual(retry(75));
    expect(n).toBe(1);
  });
  it("وقتی تلاش دوباره‌ای در کار نیست، تصادف مصرف نمی‌شود", () => {
    let n = 0;
    const j = () => (n++, 0.5);
    decideNext(di({ modelAttempt: 3, jitterUnit: j }, J("full")));
    decideNext(di({ code: "PROVIDER_AUTH", retryable: false, jitterUnit: j }, J("full")));
    decideNext(di({ callsMade: 6, jitterUnit: j }, J("full")));
    decideNext(di({ code: "PROVIDER_RATE_LIMITED", retryAfterMs: 5000, jitterUnit: j }, J("full")));
    expect(n).toBe(0);
  });
});

describe("decideNext · جایگزین و علت توقف", () => {
  it("خطاهای غیرقابل‌تلاشِ مجاز در fallbackOn بی‌درنگ به مدل بعدی می‌روند (بدون تلاش دوباره)", () => {
    for (const code of ["PROVIDER_AUTH", "PROVIDER_REJECTED", "PROVIDER_BAD_RESPONSE", "PROVIDER_ERROR"] as const) {
      expect(decideNext(di({ code, retryable: false, chainLength: 2 }))).toEqual(NEXT);
    }
  });
  it("تلاش‌های مدل تمام شد و جایگزین هست ⇒ next_model (نه توقف)", () => {
    expect(decideNext(di({ modelAttempt: 3, chainLength: 2 }))).toEqual(NEXT);
  });
  it("تلاش دوباره بر جایگزینِ بعدی هم به‌دست می‌آید؛ تلاش‌های مدلِ بعدی از نو شمرده می‌شوند", () => {
    expect(decideNext(di({ position: 1, chainLength: 3, modelAttempt: 1 }))).toEqual(retry(100));
  });
  it("کدی که در fallbackOn نیست جایگزین را راه نمی‌اندازد", () => {
    expect(decideNext(di({ code: "PROVIDER_AUTH", retryable: false, chainLength: 2 }, { fallbackOn: ["TIMEOUT"] }))).toEqual(stop("non_retryable"));
  });
  it("علت‌های توقف: جایگزینِ آخر ⇒ chain_exhausted؛ بدون زنجیره ⇒ attempts_exhausted/non_retryable", () => {
    expect(decideNext(di({ code: "PROVIDER_AUTH", retryable: false, position: 1, chainLength: 2 }))).toEqual(stop("chain_exhausted"));
    expect(decideNext(di({ modelAttempt: 3, position: 1, chainLength: 2 }))).toEqual(stop("chain_exhausted"));
    expect(decideNext(di({ code: "PROVIDER_AUTH", retryable: false }))).toEqual(stop("non_retryable"));
    expect(decideNext(di({ modelAttempt: 3 }))).toEqual(stop("attempts_exhausted"));
    // زنجیره هست ولی کد در fallbackOn نیست: chain_exhausted نمی‌گوییم
    expect(decideNext(di({ modelAttempt: 3, position: 1, chainLength: 2 }, { fallbackOn: [] }))).toEqual(stop("attempts_exhausted"));
  });
  it("سقف کل بر جایگزین هم حاکم است", () => {
    expect(decideNext(di({ code: "PROVIDER_AUTH", retryable: false, chainLength: 2, callsMade: 6 }))).toEqual(stop("budget_exhausted"));
  });
});

import { describe, expect, it } from "vitest";
import { decodeToolReply, encodeToolResults, encodeTools, TOOL_LIMITS } from "./index";
import type { ToolWireFormat } from "./index";

/** پایداریِ تصادفیِ رمزگذارِ ابزار (ADR-0054): بذرهای ثابت، بی‌پرتاب، ناورداها و رفت‌وبرگشت. */

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)), pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T };
}
type Rng = ReturnType<typeof rng>;

const FORMATS: readonly ToolWireFormat[] = ["openai-chat", "anthropic-messages"];
const ID_CHARS = "abcXYZ019_.:-";
const randId = (r: Rng) => Array.from({ length: r.int(1, 24) }, () => r.pick([...ID_CHARS])).join("");
const randName = (r: Rng) => Array.from({ length: r.int(1, 30) }, () => r.pick([..."abcdXYZ019_-"])).join("");

/** مقدارِ JSONِ تصادفی (فقط شیءهای ساده، عددِ متناهی، رشتهٔ سالم). */
function randJson(r: Rng, depth = 0): unknown {
  const k = r.int(0, depth > 3 ? 4 : 6);
  switch (k) {
    case 0: return null;
    case 1: return r.next() < 0.5;
    case 2: return r.int(-1000, 1000);
    case 3: return r.pick(["", "الف", "a b", "ریال ۱۰۰", "😀"]);
    case 4: return r.next() * 1e6;
    case 5: return Array.from({ length: r.int(0, 3) }, () => randJson(r, depth + 1));
    default: return Object.fromEntries(Array.from({ length: r.int(0, 3) }, () => [r.pick(["a", "b", "amountRials", "x1", "تاریخ"]), randJson(r, depth + 1)]));
  }
}

const GARBAGE: readonly unknown[] = [undefined, null, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "", "x", "\u0000", "\ud800", [], {}, [[]], { a: 1 }, true, () => 1, Symbol("s"), BigInt(5), new Date(0), new Map()];

/** جهشِ تصادفی روی یک مقدارِ JSON: جایگزینیِ یک گرهٔ تصادفی با آشغال یا حذفِ یک کلید. */
function mutate(r: Rng, v: unknown): unknown {
  const clone = (x: unknown): unknown => (Array.isArray(x) ? x.map(clone) : x !== null && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, clone(y)])) : x);
  const root = clone(v);
  const holders: { o: Record<string, unknown> | unknown[]; k: string | number }[] = [];
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) x.forEach((y, i) => { holders.push({ o: x, k: i }); walk(y); });
    else if (x !== null && typeof x === "object") for (const [k, y] of Object.entries(x)) { holders.push({ o: x as Record<string, unknown>, k }); walk(y); }
  };
  walk(root);
  const n = r.int(1, 3);
  for (let i = 0; i < n && holders.length > 0; i++) {
    const h = r.pick(holders);
    if (r.next() < 0.25 && !Array.isArray(h.o)) delete (h.o as Record<string, unknown>)[h.k as string];
    else (h.o as Record<string | number, unknown>)[h.k] = r.pick(GARBAGE);
  }
  return root;
}

const oaiRaw = (calls: { id: string; name: string; args: string }[], text: string | null, finish: string) => ({
  model: "m",
  choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", content: text, ...(calls.length > 0 ? { tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args } })) } : {}) } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});
const antRaw = (calls: { id: string; name: string; input: unknown }[], text: string, stop: string) => ({
  type: "message",
  role: "assistant",
  model: "m",
  content: [...(text === "" ? [] : [{ type: "text", text }]), ...calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input }))],
  stop_reason: stop,
  usage: { input_tokens: 10, output_tokens: 5 },
});

describe("رمزگشایی: ناورداهای پاسخِ جهش‌یافته (۱۵۰۰ بذر)", () => {
  it("هرگز پرتاب نمی‌کند؛ موفقیت ⇒ ناورداها؛ خطا ⇒ پیامِ کران‌دارِ بی‌نشت", () => {
    let okCount = 0;
    let errCount = 0;
    const seen = new Set<string>();
    for (let seed = 1; seed <= 1500; seed++) {
      const r = rng(seed);
      const format = r.pick(FORMATS);
      const n = r.int(0, 3);
      const ids = Array.from({ length: n }, (_, i) => `${randId(r)}${i}`);
      const base =
        format === "openai-chat"
          ? oaiRaw(ids.map((id) => ({ id, name: randName(r), args: JSON.stringify(randJson(r)) })), r.next() < 0.5 ? null : "متن", n > 0 ? "tool_calls" : "stop")
          : antRaw(ids.map((id) => ({ id, name: randName(r), input: { k: randJson(r) } })), r.next() < 0.5 ? "" : "متن", n > 0 ? "tool_use" : "end_turn");
      const raw = r.next() < 0.15 ? base : mutate(r, base);
      let res: ReturnType<typeof decodeToolReply> | undefined;
      expect(() => { res = decodeToolReply(format, raw); }, `seed ${seed}`).not.toThrow();
      if (res === undefined) continue;
      if (res.ok) {
        okCount++;
        const v = res.value;
        seen.add(`ok:${v.finish}`);
        expect(v.toolCalls.length > 0, `seed ${seed}`).toBe(v.finish === "tool_calls");
        expect(v.toolCalls.length).toBeLessThanOrEqual(TOOL_LIMITS.maxToolCalls);
        expect(new Set(v.toolCalls.map((c) => c.id)).size).toBe(v.toolCalls.length);
        for (const c of v.toolCalls) {
          expect(c.id).toMatch(/^[A-Za-z0-9_.:-]{1,128}$/);
          expect(c.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
          expect(typeof c.argumentsJson).toBe("string");
          expect(c.argumentsJson.length).toBeLessThanOrEqual(TOOL_LIMITS.maxArgumentChars);
        }
        if (format === "anthropic-messages") for (const c of v.toolCalls) expect(() => JSON.parse(c.argumentsJson) as unknown).not.toThrow();
        if (v.usage !== null) {
          expect(Number.isInteger(v.usage.inputTokens) && v.usage.inputTokens >= 0).toBe(true);
          expect(Number.isInteger(v.usage.outputTokens) && v.usage.outputTokens >= 0).toBe(true);
        }
        expect(Object.isFrozen(v) && Object.isFrozen(v.toolCalls) && Object.isFrozen(v.assistantMessage)).toBe(true);
        // هر پاسخِ پذیرفته‌شده را می‌شود با نتیجه پاسخ داد.
        if (v.toolCalls.length > 0) expect(encodeToolResults(format, v.toolCalls, v.toolCalls.map((c) => ({ id: c.id, content: "ok" }))).ok).toBe(true);
      } else {
        errCount++;
        seen.add(`err:${res.error.code}`);
        expect(["BAD_RESPONSE", "TRUNCATED_TOOL_CALL"]).toContain(res.error.code);
        expect(res.error.message.length).toBeLessThan(200);
        expect(res.error.issues.length).toBeLessThanOrEqual(10);
        for (const i of res.error.issues) expect(i.length).toBeLessThan(300);
      }
    }
    // فازینگ واقعاً هر دو سمت را دیده است (نه فقط یک شاخه).
    expect(okCount).toBeGreaterThan(200);
    expect(errCount).toBeGreaterThan(200);
    expect(seen.has("ok:tool_calls") && seen.has("ok:stop") && seen.has("err:BAD_RESPONSE")).toBe(true);
  });
});

describe("رفت‌وبرگشت (۶۰۰ بذر): آنچه مدل می‌فرستد همان است که ابزار می‌بیند", () => {
  it("OpenAI: id/نام/متنِ آرگومان بی‌تغییر؛ Anthropic: JSONِ آرگومان برابر", () => {
    for (let seed = 1; seed <= 600; seed++) {
      const r = rng(seed * 7919);
      const n = r.int(1, 5);
      const ids = Array.from({ length: n }, (_, i) => `${randId(r)}-${i}`);
      const calls = ids.map((id) => ({ id, name: randName(r), input: { k: randJson(r) } as Record<string, unknown> }));
      for (const c of calls) if (r.next() < 0.5) c.input = Object.fromEntries(Object.entries({ amountRials: r.int(0, 10 ** 12), nested: { a: [1, 2, { b: null }] } }));
      const o = decodeToolReply("openai-chat", oaiRaw(calls.map((c) => ({ id: c.id, name: c.name, args: JSON.stringify(c.input) })), null, "tool_calls"));
      expect(o.ok, `seed ${seed}`).toBe(true);
      if (o.ok) calls.forEach((c, i) => expect(o.value.toolCalls[i]).toEqual({ id: c.id, name: c.name, argumentsJson: JSON.stringify(c.input) }));
      const a = decodeToolReply("anthropic-messages", antRaw(calls, "", "tool_use"));
      expect(a.ok, `seed ${seed}`).toBe(true);
      if (a.ok) {
        a.value.toolCalls.forEach((c, i) => {
          expect(c.id).toBe(calls[i]?.id);
          expect(c.name).toBe(calls[i]?.name);
          expect(JSON.parse(c.argumentsJson)).toEqual(calls[i]?.input);
        });
        // پیامِ دستیار همان ورودی را برمی‌گرداند (نه رشته).
        const blocks = (a.value.assistantMessage as { content: { input: unknown }[] }).content;
        blocks.forEach((b, i) => expect(b.input).toEqual(calls[i]?.input));
      }
    }
  });
  it("نتیجه‌ها: برای هر ترتیبِ results همان ترتیبِ calls و هر id یک‌بار", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed + 31337);
      const n = r.int(1, 8);
      const calls = Array.from({ length: n }, (_, i) => ({ id: `id${i}-${randId(r)}`, name: "t", argumentsJson: "{}" }));
      const results = calls.map((c, i) => ({ id: c.id, content: `r${i}`, isError: r.next() < 0.3 }));
      for (let i = results.length - 1; i > 0; i--) { const j = r.int(0, i); [results[i], results[j]] = [results[j]!, results[i]!]; }
      const o = encodeToolResults("openai-chat", calls, results);
      expect(o.ok).toBe(true);
      if (o.ok) expect(o.value.map((m) => (m as { tool_call_id: string }).tool_call_id)).toEqual(calls.map((c) => c.id));
      const a = encodeToolResults("anthropic-messages", calls, results);
      expect(a.ok).toBe(true);
      if (a.ok) {
        expect(a.value).toHaveLength(1);
        expect((a.value[0] as { content: { tool_use_id: string }[] }).content.map((b) => b.tool_use_id)).toEqual(calls.map((c) => c.id));
      }
    }
  });
});

describe("ورودیِ بزرگ و بدجنس: سریع و بی‌پرتاب", () => {
  it("آرایه‌های میلیونی پیش از پیمایش رد می‌شوند", () => {
    const t0 = Date.now();
    const huge = new Array(2_000_000).fill(0);
    expect(decodeToolReply("openai-chat", { choices: [{ finish_reason: "tool_calls", message: { tool_calls: huge } }] }).ok).toBe(false);
    expect(decodeToolReply("anthropic-messages", { content: huge, stop_reason: "tool_use" }).ok).toBe(false);
    expect(encodeTools("openai-chat", huge).ok).toBe(false);
    expect(encodeToolResults("openai-chat", huge, huge).ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
  it("شمای عظیم/ژرفِ ۱۰۰هزارسطحی بدونِ سرریزِ پشته رد می‌شود", () => {
    let deep: Record<string, unknown> = { type: "object" };
    for (let i = 0; i < 100_000; i++) deep = { type: "object", n: deep };
    expect(encodeTools("openai-chat", [{ name: "t", description: "d", parameters: deep }]).ok).toBe(false);
    const wide: Record<string, unknown> = { type: "object" };
    for (let i = 0; i < 200_000; i++) wide[`k${i}`] = i;
    const t0 = Date.now();
    expect(encodeTools("anthropic-messages", [{ name: "t", description: "d", parameters: wide }]).ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
  it("متنِ نتیجهٔ ابزار با ایموجیِ درست پذیرفته و جانشینِ نیمه رد می‌شود", () => {
    const calls = [{ id: "a", name: "t", argumentsJson: "{}" }];
    expect(encodeToolResults("openai-chat", calls, [{ id: "a", content: "😀 ریال" }]).ok).toBe(true);
    expect(encodeToolResults("openai-chat", calls, [{ id: "a", content: "😀".slice(0, 1) }]).ok).toBe(false);
  });
});

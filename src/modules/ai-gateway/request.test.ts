import { describe, expect, it } from "vitest";
import { resolveConfig } from "./config";
import { REQUEST_LIMITS, parseRequest } from "./request";
import type { GatewayError, ParsedRequest } from "./types";
import { PRICE, manualClock, scriptedProvider } from "./test-kit";

const cfg = (() => {
  const r = resolveConfig({
    providers: { p1: scriptedProvider([]) },
    models: {
      m1: { provider: "p1", providerModel: "pm", maxInputChars: 1000, maxOutputTokens: 4096, price: PRICE },
      "vendor/m-2:v1.0": { provider: "p1", providerModel: "pm2", maxInputChars: 50, maxOutputTokens: 10, price: null, timeoutMs: 777 },
    },
    clock: manualClock(),
    defaultTimeoutMs: 9000,
  });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
})();
const parse = (x: unknown) => parseRequest(x, (n) => cfg.models.get(n));
const okv = (x: unknown): ParsedRequest => {
  const r = parse(x);
  if (!r.ok) throw new Error(`${r.error.code} ${JSON.stringify(r.error.issues)}`);
  return r.value;
};
const err = (x: unknown): GatewayError => {
  const r = parse(x);
  if (r.ok) throw new Error(`پذیرفته شد: ${JSON.stringify(x).slice(0, 200)}`);
  return r.error;
};
const base = { model: "m1", messages: [{ role: "user", content: "سلام" }], maxOutputTokens: 100 };
const withMsgs = (messages: unknown) => ({ ...base, messages });

describe("ai-gateway · parseRequest: پیش‌فرض‌ها", () => {
  it("حداقل درخواست معتبر ⇒ دمای ۰، توقف تهی، بدون requestId، مهلت از مدل/پیش‌فرض", () => {
    expect(okv(base)).toEqual({ model: "m1", messages: [{ role: "user", content: "سلام" }], maxOutputTokens: 100, temperature: 0, stopSequences: [], requestId: null, timeoutMs: 9000 });
    expect(okv({ ...base, model: "vendor/m-2:v1.0", maxOutputTokens: 10 }).timeoutMs).toBe(777);
  });

  it("مهلت درخواست بر مدل و پیش‌فرض غلبه می‌کند؛ نتیجه تغییرناپذیر و کپیِ ورودی است", () => {
    const input = { ...base, timeoutMs: 1, stopSequences: ["a"], messages: [{ role: "user", content: "x" }] };
    const r = okv(input);
    expect(r.timeoutMs).toBe(1);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.messages)).toBe(true);
    expect(Object.isFrozen(r.messages[0])).toBe(true);
    expect(Object.isFrozen(r.stopSequences)).toBe(true);
    (input.messages[0] as { content: string }).content = "تغییر";
    input.stopSequences.push("b");
    expect(r.messages[0]?.content).toBe("x");
    expect(r.stopSequences).toEqual(["a"]);
  });

  it("گفتگوی چندنوبتی با system اول معتبر است", () => {
    const r = okv(withMsgs([{ role: "system", content: "قواعد" }, { role: "user", content: "الف" }, { role: "assistant", content: "ب" }, { role: "user", content: "ج" }]));
    expect(r.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  });
});

describe("ai-gateway · parseRequest: مرزها", () => {
  it("maxOutputTokens: الزامی؛ ۱…سقف مدل؛ بیرون از بازه رد (نه کوتاه‌شده)", () => {
    const { maxOutputTokens: _omit, ...without } = base;
    void _omit;
    expect(err(without).issues?.join()).toContain("maxOutputTokens");
    expect(okv({ ...base, maxOutputTokens: 1 }).maxOutputTokens).toBe(1);
    expect(okv({ ...base, maxOutputTokens: 4096 }).maxOutputTokens).toBe(4096);
    for (const v of [0, -1, 4097, 1.5, "5", Number.NaN, Infinity, null]) expect(err({ ...base, maxOutputTokens: v }).code, String(v)).toBe("INVALID_REQUEST");
    expect(err({ ...base, model: "vendor/m-2:v1.0", maxOutputTokens: 11 }).code).toBe("INVALID_REQUEST");
  });

  it("temperature: ۰ و ۲ مجاز؛ بیرون/NaN/غیرعدد رد", () => {
    expect(okv({ ...base, temperature: 0 }).temperature).toBe(0);
    expect(okv({ ...base, temperature: 2 }).temperature).toBe(2);
    expect(okv({ ...base, temperature: 0.25 }).temperature).toBe(0.25);
    for (const v of [-0.001, 2.001, Number.NaN, Infinity, "0", null]) expect(err({ ...base, temperature: v }).code, String(v)).toBe("INVALID_REQUEST");
  });

  it("timeoutMs: ۱ و ۶۰۰٬۰۰۰ مجاز؛ ۰، ۶۰۰٬۰۰۱، اعشاری رد", () => {
    expect(okv({ ...base, timeoutMs: 1 }).timeoutMs).toBe(1);
    expect(okv({ ...base, timeoutMs: 600_000 }).timeoutMs).toBe(600_000);
    for (const v of [0, 600_001, 1.5, -5, "100", null]) expect(err({ ...base, timeoutMs: v }).code, String(v)).toBe("INVALID_REQUEST");
  });

  it("stopSequences: ≤۴ یکتا، هر کدام ۱…۶۴؛ تکراری/تهی/بلند/Unicode خراب رد", () => {
    expect(okv({ ...base, stopSequences: ["a", "b", "c", "d"] }).stopSequences).toHaveLength(4);
    expect(okv({ ...base, stopSequences: ["x".repeat(64)] }).stopSequences).toHaveLength(1);
    for (const v of [["a", "b", "c", "d", "e"], ["a", "a"], [""], ["x".repeat(65)], [1], "a", ["\ud800"], ["a\u0000"], null]) {
      expect(err({ ...base, stopSequences: v }).code, JSON.stringify(v)).toBe("INVALID_REQUEST");
    }
  });

  it("requestId: الگوی امن و ≤۱۲۸؛ فاصله، خط جدید، فارسی، تهی رد", () => {
    expect(okv({ ...base, requestId: "a".repeat(128) }).requestId).toHaveLength(128);
    expect(okv({ ...base, requestId: "Req_1.2:3-x".replace("_", ".") }).requestId).toBe("Req.1.2:3-x");
    for (const v of ["a".repeat(129), "", "a b", "a\nb", "شناسه", "a/b", 5, null]) expect(err({ ...base, requestId: v }).code, String(v)).toBe("INVALID_REQUEST");
  });

  it("messages: ۱…۶۴ پیام؛ تهی/۶۵/غیرآرایه رد", () => {
    const m = (n: number) => Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: "x" }));
    expect(okv(withMsgs(m(1))).messages).toHaveLength(1);
    expect(okv(withMsgs(m(63))).messages).toHaveLength(63);
    // ۶۴ پیام (سقف) با آخرین پیام user معتبر است؛ یکسان‌بودن نقش دو پیام پیاپی منع نشده (جایگزینی نقش‌ها کار ارائه‌دهنده است).
    expect(okv(withMsgs([...m(63), { role: "user", content: "x" }])).messages).toHaveLength(64);
    for (const v of [[], m(65), "x", null, {}, undefined]) expect(err(withMsgs(v)).code, JSON.stringify(v)?.slice(0, 40)).toBe("INVALID_REQUEST");
  });

  it("سقف نویسه: مجموع ≤ سقف مدل (مرز دقیق)، و هر پیام ≤ ۱٬۰۰۰٬۰۰۰", () => {
    const small = (n: number) => ({ model: "vendor/m-2:v1.0", maxOutputTokens: 5, messages: [{ role: "user", content: "a".repeat(n) }] });
    expect(okv(small(50)).messages[0]?.content).toHaveLength(50);
    expect(err(small(51)).issues?.join()).toContain("سقف مدل");
    expect(okv({ ...base, messages: [{ role: "system", content: "s".repeat(500) }, { role: "user", content: "u".repeat(500) }] }).messages).toHaveLength(2);
    expect(err({ ...base, messages: [{ role: "system", content: "s".repeat(500) }, { role: "user", content: "u".repeat(501) }] }).code).toBe("INVALID_REQUEST");
    expect(REQUEST_LIMITS.maxMessageChars).toBe(1_000_000);
  });

  it("سقف هر پیام ۱٬۰۰۰٬۰۰۰ نویسه، مستقل از سقف مدل (مرز دقیق)", () => {
    const big = resolveConfig({
      providers: { p1: scriptedProvider([]) },
      models: { huge: { provider: "p1", providerModel: "pm", maxInputChars: 10_000_000, maxOutputTokens: 10, price: null } },
      clock: manualClock(),
    });
    if (!big.ok) throw new Error("config");
    const run = (n: number) => parseRequest({ model: "huge", maxOutputTokens: 1, messages: [{ role: "user", content: "a".repeat(n) }] }, (m) => big.value.models.get(m));
    expect(run(1_000_000).ok).toBe(true);
    const over = run(1_000_001);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error.issues?.join()).toContain("نویسه بیشتر است");
  });
});

describe("ai-gateway · parseRequest: ساختار پیام‌ها", () => {
  it("نقش‌ها: system فقط اول؛ آخرین باید user؛ نقش ناشناخته/غیرمتن رد", () => {
    expect(err(withMsgs([{ role: "user", content: "a" }, { role: "system", content: "b" }, { role: "user", content: "c" }])).issues?.join()).toContain("system فقط");
    expect(err(withMsgs([{ role: "system", content: "a" }, { role: "system", content: "b" }, { role: "user", content: "c" }])).code).toBe("INVALID_REQUEST");
    expect(err(withMsgs([{ role: "user", content: "a" }, { role: "assistant", content: "b" }])).issues?.join()).toContain("آخرین پیام باید user");
    expect(err(withMsgs([{ role: "system", content: "a" }])).code).toBe("INVALID_REQUEST");
    for (const role of ["tool", "User", "", 1, null, undefined]) expect(err(withMsgs([{ role, content: "a" }])).code, String(role)).toBe("INVALID_REQUEST");
  });

  it("محتوا: تهی/فقط‌فاصله/غیرمتن، NUL و جفت‌جانشینِ تنها رد؛ ایموجی و فارسی معتبر", () => {
    for (const content of ["", "   \n\t", 5, null, undefined, "a\u0000b", "\ud83d", "x\udc00y"]) expect(err(withMsgs([{ role: "user", content }])).code, JSON.stringify(content)).toBe("INVALID_REQUEST");
    expect(okv(withMsgs([{ role: "user", content: "پرسش 😀 با ماده‌ی ۱۰" }])).messages).toHaveLength(1);
  });

  it("کلید اضافی در پیام (name، tool_calls، …) و پیام غیرشیء رد", () => {
    for (const m of [{ role: "user", content: "a", name: "x" }, { role: "user", content: "a", tool_calls: [] }, "x", null, [], 5]) {
      expect(err(withMsgs([m])).code, JSON.stringify(m)).toBe("INVALID_REQUEST");
    }
  });
});

describe("ai-gateway · parseRequest: مدل و ورودی کلی", () => {
  it("مدل ناشناخته ⇒ UNKNOWN_MODEL؛ نام‌های prototype هم ناشناخته‌اند", () => {
    for (const m of ["nope", "M1", "__proto__", "constructor", "toString", "hasOwnProperty", "m1 "]) expect(err({ ...base, model: m }).code, m).toBe("UNKNOWN_MODEL");
    expect(JSON.stringify(err({ ...base, model: "secret-name-xyz" }))).not.toContain("secret-name-xyz");
  });

  it("مدل غیرمتن/تهی/نبود ⇒ INVALID_REQUEST (نه UNKNOWN_MODEL)", () => {
    const { model: _m, ...without } = base;
    void _m;
    for (const x of [without, { ...base, model: "" }, { ...base, model: 5 }, { ...base, model: null }]) expect(err(x).code).toBe("INVALID_REQUEST");
  });

  it("ورودی غیرشیء رد؛ کلید ناشناخته (غلط املایی) رد حتی کنار فیلدهای درست", () => {
    for (const x of [null, undefined, "x", 5, [], true]) expect(err(x).code).toBe("INVALID_REQUEST");
    for (const k of ["temprature", "max_tokens", "stream", "tools", "Model", "stop"]) {
      const e = err({ ...base, [k]: 1 });
      expect(e.code).toBe("INVALID_REQUEST");
      expect(e.issues?.join()).toContain(JSON.stringify(k));
    }
  });

  it("همهٔ مشکل‌ها یک‌جا گزارش می‌شوند", () => {
    const e = err({ model: "m1", messages: [], maxOutputTokens: 0, temperature: 9, timeoutMs: 0, requestId: " ", stopSequences: "x", extra: 1 });
    expect(e.issues?.length).toBeGreaterThanOrEqual(7);
  });

  it("issues هرگز محتوای پیام را بازتاب نمی‌دهد", () => {
    const canary = "CANARY-محتوای-محرمانه";
    const e = err({ ...base, messages: [{ role: "system", content: canary }, { role: "system", content: canary }, { role: "assistant", content: canary }], temperature: canary });
    expect(JSON.stringify(e)).not.toContain("CANARY");
  });

  it("کلید ناشناخته در issues بریده می‌شود (۴۰ نویسه) و به‌صورت JSON می‌آید", () => {
    const e = err({ ...base, ["k".repeat(100) + "\n"]: 1 });
    expect(e.issues?.join()).toContain(`"${"k".repeat(40)}"`);
    expect(e.issues?.join()).not.toContain("k".repeat(41));
  });
});

describe("ai-gateway · parseRequest ≡ اوراکل مستقل (۴۰۰ بذر)", () => {
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

  /** اوراکل: قاعده‌ها از روی مستند، با کد ساده و جدا از پیاده‌سازی. */
  function oracle(x: unknown): boolean {
    if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
    const o = x as Record<string, unknown>;
    const allowed = ["model", "messages", "maxOutputTokens", "temperature", "stopSequences", "requestId", "timeoutMs"];
    if (Object.keys(o).some((k) => !allowed.includes(k))) return false;
    if (o["model"] !== "m1") return false;
    const ms = o["messages"];
    if (!Array.isArray(ms) || ms.length < 1 || ms.length > 64) return false;
    let total = 0;
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i] as unknown;
      if (typeof m !== "object" || m === null || Array.isArray(m)) return false;
      const mm = m as Record<string, unknown>;
      if (Object.keys(mm).length !== 2 || !("role" in mm) || !("content" in mm)) return false;
      if (!["system", "user", "assistant"].includes(mm["role"] as string)) return false;
      if (mm["role"] === "system" && i > 0) return false;
      const c = mm["content"];
      if (typeof c !== "string" || c.trim().length === 0 || c.length > 1_000_000 || c.includes("\u0000") || /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(c)) return false;
      total += c.length;
    }
    if ((ms[ms.length - 1] as { role: string }).role !== "user") return false;
    if (total > 1000) return false;
    const mot = o["maxOutputTokens"];
    if (!(typeof mot === "number" && Number.isInteger(mot) && mot >= 1 && mot <= 4096)) return false;
    if ("temperature" in o && !(typeof o["temperature"] === "number" && o["temperature"] >= 0 && o["temperature"] <= 2)) return false;
    if ("timeoutMs" in o && !(typeof o["timeoutMs"] === "number" && Number.isInteger(o["timeoutMs"]) && o["timeoutMs"] >= 1 && o["timeoutMs"] <= 600000)) return false;
    if ("requestId" in o && !(typeof o["requestId"] === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(o["requestId"]))) return false;
    if ("stopSequences" in o) {
      const s = o["stopSequences"];
      if (!Array.isArray(s) || s.length > 4) return false;
      if (new Set(s).size !== s.length) return false;
      for (const e of s as unknown[]) if (typeof e !== "string" || e.length < 1 || e.length > 64 || e.includes("\u0000") || !e.isWellFormed()) return false;
    }
    return true;
  }

  /** پایهٔ معتبر + صفر تا دو «جهش» که ممکن است نامعتبرش کنند؛ هر دو دسته به شمار کافی تولید می‌شوند. */
  function gen(seed: number): unknown {
    const r = rng(seed);
    const n = r.int(1, 6);
    const messages: Array<{ role: string; content: string }> = [];
    if (r.next() < 0.3) messages.push({ role: "system", content: r.pick(["قواعد", "x".repeat(r.int(1, 100))]) });
    for (let i = 0; i < n; i++) messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: r.pick(["سلام", "الف ب", "x".repeat(r.int(1, 120)), "😀", "ماده ۱۰"]) });
    if (messages[messages.length - 1]?.role !== "user") messages.pop();
    const o: Record<string, unknown> = { model: "m1", messages, maxOutputTokens: r.int(1, 4096) };
    if (r.next() < 0.4) o["temperature"] = r.pick([0, 0.5, 1, 2]);
    if (r.next() < 0.3) o["timeoutMs"] = r.pick([1, 5000, 600000]);
    if (r.next() < 0.3) o["requestId"] = r.pick(["abc", "ok-1", "a.b:c_d".replace("_", "-"), "x".repeat(128)]);
    if (r.next() < 0.3) o["stopSequences"] = r.pick([[], ["a"], ["a", "b"], ["a", "b", "c", "d"]]);
    const mutations: Array<() => void> = [
      () => { o["model"] = r.pick(["m2", "", 5]); },
      () => { o["maxOutputTokens"] = r.pick([0, 4097, 1.5, "7", -1]); },
      () => { delete o["maxOutputTokens"]; },
      () => { o["temperature"] = r.pick([2.5, -1, Number.NaN, "0"]); },
      () => { o["timeoutMs"] = r.pick([0, 600001, 2.5]); },
      () => { o["requestId"] = r.pick(["a b", "", "x".repeat(129)]); },
      () => { o["stopSequences"] = r.pick([["a", "a"], ["a", "b", "c", "d", "e"], [""], "x"]); },
      () => { o["bogus"] = 1; },
      () => { o["messages"] = r.pick([[], "x", Array.from({ length: 65 }, () => ({ role: "user", content: "x" }))]); },
      () => { messages.push({ role: "assistant", content: "x" }); },
      () => { messages.push({ role: "system", content: "x" }); messages.push({ role: "user", content: "x" }); },
      () => { messages[0] = { role: "user", content: r.pick(["", "   ", "a\u0000", "\ud800", "x".repeat(2000)]) }; },
      () => { messages[0] = { role: r.pick(["tool", "User", ""]), content: "x" }; },
      () => { (messages[0] as Record<string, unknown>)["name"] = "n"; },
    ];
    const count = r.pick([0, 0, 1, 1, 2]);
    for (let i = 0; i < count; i++) r.pick(mutations)();
    return r.next() < 0.02 ? r.pick([null, [], "x", 5]) : o;
  }

  it("پذیرش/رد یکسان با اوراکل روی ۴۰۰ ورودی تصادفی (هر دو دسته دیده می‌شوند)", () => {
    let accepted = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const x = gen(seed);
      const got = parse(x).ok;
      expect(got, `seed=${seed} ${JSON.stringify(x)?.slice(0, 300)}`).toBe(oracle(x));
      if (got) accepted++;
    }
    expect(accepted).toBeGreaterThan(100);
    expect(accepted).toBeLessThan(300);
  });
});

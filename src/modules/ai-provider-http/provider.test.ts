import { describe, expect, it } from "vitest";
import { ProviderFailure } from "@/modules/ai-gateway";
import type { ToolModelProvider } from "@/modules/ai-gateway";
import { createHttpToolProvider } from "./index";
import { ANTHROPIC_URL, KEY, OPENAI_URL, baseOptions, fakeFetch, json, makeCall, must } from "./test-kit";

const mk = (format: "openai-chat" | "anthropic-messages", f: ReturnType<typeof fakeFetch>, over: Record<string, unknown> = {}): ToolModelProvider => must(createHttpToolProvider(baseOptions(format, f, over)));
const caught = async (p: Promise<unknown>): Promise<unknown> => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("انتظار پرتاب");
};
const failureOf = async (p: Promise<unknown>) => {
  const e = await caught(p);
  expect(e).toBeInstanceOf(ProviderFailure);
  return e as ProviderFailure;
};

describe("createHttpToolProvider · ساخت", () => {
  it("پیکربندیِ نامعتبر ⇒ ok:false بی‌پرتاب", () => {
    const r = createHttpToolProvider({});
    expect(r.ok).toBe(false);
    expect(() => createHttpToolProvider(undefined)).not.toThrow();
  });
  it("شیءِ ارائه‌دهنده یخ‌زده است و تنها completeWithTools دارد؛ کلید/نشانی در آن نیست", () => {
    const p = mk("openai-chat", fakeFetch(json({})));
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.keys(p)).toEqual(["completeWithTools"]);
    const dump = JSON.stringify(p) + String(p.completeWithTools);
    expect(dump).not.toContain(KEY);
    expect(dump).not.toContain("api.openai.com");
  });
  it("جداشده از this کار می‌کند (دروازه متد را bind می‌کند)", async () => {
    const f = fakeFetch(json({ ok: 1 }));
    const { completeWithTools } = mk("openai-chat", f);
    expect(await completeWithTools(makeCall("openai-chat"))).toEqual({ ok: 1 });
  });
  it("تغییرِ شیءِ options پس از ساخت اثری ندارد", async () => {
    const f = fakeFetch(json({}));
    const o = baseOptions("openai-chat", f) as Record<string, unknown>;
    const p = must(createHttpToolProvider(o));
    o["endpoint"] = "https://evil.example/x";
    await p.completeWithTools(makeCall("openai-chat"));
    expect(f.calls[0]?.url).toBe(OPENAI_URL);
  });
});

describe("completeWithTools · درخواستِ فرستاده‌شده", () => {
  it.each([
    ["openai-chat", OPENAI_URL, "authorization", `Bearer ${KEY}`],
    ["anthropic-messages", ANTHROPIC_URL, "x-api-key", KEY],
  ] as const)("%s: نشانی، روش، سرایندها و گزینه‌های امنیتی", async (format, url, hname, hval) => {
    const f = fakeFetch(json({}));
    const ac = new AbortController();
    await mk(format, f).completeWithTools(makeCall(format, {}, ac.signal));
    expect(f.calls).toHaveLength(1);
    const { url: u, init } = f.calls[0]!;
    expect(u).toBe(url);
    expect(init.method).toBe("POST");
    const h = init.headers as Record<string, string>;
    expect(h[hname]).toBe(hval);
    expect(h["content-type"]).toBe("application/json");
    expect(init.redirect).toBe("error");
    expect(init.credentials).toBe("omit");
    expect(init.cache).toBe("no-store");
    expect(init.referrerPolicy).toBe("no-referrer");
    expect(init.signal).toBe(ac.signal);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body["model"]).toBe("provider-model-1");
    expect(body["stream"]).toBe(false);
    expect(JSON.stringify(init.body)).not.toContain(KEY);
  });
  it("anthropicVersion سفارشی و max_completion_tokens به بدنه می‌رسند", async () => {
    const fa = fakeFetch(json({}));
    await mk("anthropic-messages", fa, { anthropicVersion: "2024-10-22" }).completeWithTools(makeCall("anthropic-messages"));
    expect((fa.calls[0]!.init.headers as Record<string, string>)["anthropic-version"]).toBe("2024-10-22");
    const fo = fakeFetch(json({}));
    await mk("openai-chat", fo, { openaiMaxTokensField: "max_completion_tokens" }).completeWithTools(makeCall("openai-chat"));
    expect(JSON.parse(fo.calls[0]!.init.body as string)["max_completion_tokens"]).toBe(100);
  });
  it("کلید در هر تماس دوباره خوانده می‌شود (چرخش بی‌بازسازی) و می‌تواند async باشد", async () => {
    const f = fakeFetch(() => json({}));
    let n = 0;
    const p = mk("openai-chat", f, { getApiKey: () => Promise.resolve(`key-${++n}`) });
    await p.completeWithTools(makeCall("openai-chat"));
    await p.completeWithTools(makeCall("openai-chat"));
    expect((f.calls[0]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer key-1");
    expect((f.calls[1]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer key-2");
  });
});

describe("completeWithTools · کلیدِ نامعتبر ⇒ auth بی‌ارسال", () => {
  it.each([
    ["پرتاب", () => { throw new Error(`cannot read /secrets/${KEY}`); }],
    ["رد", () => Promise.reject(new Error(KEY))],
    ["تهی", () => ""],
    ["غیررشته", () => 5 as unknown as string],
    ["فاصله", () => "sk a"],
    ["تزریقِ سرایند", () => `${KEY}\r\nX-Evil: 1`],
    ["غیرASCII", () => "کلید"],
    ["بلند", () => "a".repeat(513)],
  ])("%s", async (_n, getApiKey) => {
    const f = fakeFetch(json({}));
    const e = await failureOf(mk("openai-chat", f, { getApiKey }).completeWithTools(makeCall("openai-chat")));
    expect(e.kind).toBe("auth");
    expect(f.calls).toHaveLength(0);
    expect(e.message).not.toContain(KEY);
    expect(e.cause).toBeUndefined();
  });
});

describe("completeWithTools · نگاشتِ وضعیت", () => {
  const cases: ReadonlyArray<readonly [number, string]> = [
    [400, "rejected"], [401, "auth"], [403, "auth"], [404, "rejected"], [413, "rejected"], [422, "rejected"], [429, "rate_limited"],
    [408, "unavailable"], [500, "unavailable"], [502, "unavailable"], [503, "unavailable"], [504, "unavailable"], [529, "unavailable"], [302, "rejected"], [418, "rejected"], [205, "ok"],
  ];
  it.each(cases.filter(([, k]) => k !== "ok"))("وضعیت %s ⇒ %s", async (status, kind) => {
    const f = fakeFetch(json({ error: { message: `echo ${KEY} سؤالِ محرمانه` } }, status));
    const e = await failureOf(mk("openai-chat", f).completeWithTools(makeCall("openai-chat")));
    expect(e.kind).toBe(kind);
    expect(JSON.stringify([e.message, e.kind, e.retryAfterMs])).not.toContain("محرمانه");
    expect(e.message).not.toContain(KEY);
    expect(e.cause).toBeUndefined();
  });
  it("بدنهٔ پاسخِ ناموفق خوانده نمی‌شود، فقط لغو می‌شود", async () => {
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ pull() { pulled++; }, cancel() { cancelled = true; } });
    const f = fakeFetch(new Response(body, { status: 500 }));
    await failureOf(mk("openai-chat", f).completeWithTools(makeCall("openai-chat")));
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(1);
  });
  it("Retry-After روی ۴۲۹ و ۵xx منتقل می‌شود، روی auth/rejected نه", async () => {
    const e1 = await failureOf(mk("openai-chat", fakeFetch(json({}, 429, { "retry-after": "12" }))).completeWithTools(makeCall("openai-chat")));
    expect(e1.retryAfterMs).toBe(12_000);
    const e2 = await failureOf(mk("openai-chat", fakeFetch(json({}, 503, { "retry-after-ms": "340" }))).completeWithTools(makeCall("openai-chat")));
    expect(e2.retryAfterMs).toBe(340);
    const e3 = await failureOf(mk("openai-chat", fakeFetch(json({}, 401, { "retry-after": "5" }))).completeWithTools(makeCall("openai-chat")));
    expect(e3.retryAfterMs).toBeNull();
    const e4 = await failureOf(mk("openai-chat", fakeFetch(json({}, 400, { "retry-after": "5" }))).completeWithTools(makeCall("openai-chat")));
    expect(e4.retryAfterMs).toBeNull();
  });
  it("Retry-After بیش از ۱ ساعت یا نامعتبر نادیده گرفته می‌شود؛ تاریخ با ساعتِ تزریقی", async () => {
    const big = await failureOf(mk("openai-chat", fakeFetch(json({}, 429, { "retry-after": "7200" }))).completeWithTools(makeCall("openai-chat")));
    expect(big.retryAfterMs).toBeNull();
    const junk = await failureOf(mk("openai-chat", fakeFetch(json({}, 429, { "retry-after": "soon" }))).completeWithTools(makeCall("openai-chat")));
    expect(junk.retryAfterMs).toBeNull();
    const now = () => Date.parse("2026-01-01T00:00:00Z");
    const d = await failureOf(mk("openai-chat", fakeFetch(json({}, 429, { "retry-after": "Thu, 01 Jan 2026 00:00:09 GMT" })), { now }).completeWithTools(makeCall("openai-chat")));
    expect(d.retryAfterMs).toBe(9000);
  });
  it("response.redirected=true حتی با ۲۰۰ ⇒ rejected", async () => {
    const r = json({ ok: 1 });
    Object.defineProperty(r, "redirected", { value: true });
    const e = await failureOf(mk("openai-chat", fakeFetch(r)).completeWithTools(makeCall("openai-chat")));
    expect(e.kind).toBe("rejected");
  });
});

describe("completeWithTools · پاسخِ موفق", () => {
  it("JSON را خام برمی‌گرداند (تفسیر با دروازه است)", async () => {
    const body = { choices: [{ message: { content: "x" } }], weird: { nested: [1, 2, 3] } };
    expect(await mk("openai-chat", fakeFetch(json(body))).completeWithTools(makeCall("openai-chat"))).toEqual(body);
  });
  it.each([["بدنهٔ تهی", new Response("", { status: 200 })], ["HTML", new Response("<html>login</html>", { status: 200 })], ["۲۰۴", new Response(null, { status: 204 })]])("%s ⇒ null (دروازه BAD_RESPONSE می‌کند)", async (_n, r) => {
    expect(await mk("openai-chat", fakeFetch(r)).completeWithTools(makeCall("openai-chat"))).toBeNull();
  });
  it("بدنهٔ بزرگ‌تر از maxResponseBytes ⇒ null", async () => {
    const f = fakeFetch(new Response(JSON.stringify({ pad: "x".repeat(5000) }), { status: 200 }));
    expect(await mk("openai-chat", f, { maxResponseBytes: 1024 }).completeWithTools(makeCall("openai-chat"))).toBeNull();
  });
  it("قطعِ جریان حینِ خواندنِ بدنه ⇒ unavailable بی‌نشتِ علت در پیام", async () => {
    const s = new ReadableStream<Uint8Array>({ start: (c) => c.error(new Error(`reset ${KEY}`)) });
    const e = await failureOf(mk("openai-chat", fakeFetch(new Response(s, { status: 200 }))).completeWithTools(makeCall("openai-chat")));
    expect(e.kind).toBe("unavailable");
    expect(e.message).not.toContain(KEY);
  });
});

describe("completeWithTools · شبکه و لغو", () => {
  it("خطای شبکه ⇒ unavailable (علت فقط در cause)", async () => {
    const e = await failureOf(mk("openai-chat", fakeFetch(new TypeError("fetch failed"))).completeWithTools(makeCall("openai-chat")));
    expect(e.kind).toBe("unavailable");
    expect((e.cause as Error).message).toBe("fetch failed");
    expect(e.message).toBe("provider failure: unavailable");
  });
  it("خطای redirect:'error' (TypeError) هم unavailable است و درخواستِ دوم فرستاده نمی‌شود", async () => {
    const f = fakeFetch(new TypeError("fetch failed: unexpected redirect"));
    const e = await failureOf(mk("openai-chat", f).completeWithTools(makeCall("openai-chat")));
    expect(e.kind).toBe("unavailable");
    expect(f.calls).toHaveLength(1);
  });
  it("لغو پیش از ارسال: fetch صدا زده نمی‌شود و علتِ لغو پرتاب می‌شود (نه ProviderFailure)", async () => {
    const ac = new AbortController();
    const reason = new Error("user-cancel");
    ac.abort(reason);
    const f = fakeFetch(json({}));
    const e = await caught(mk("openai-chat", f).completeWithTools(makeCall("openai-chat", {}, ac.signal)));
    expect(e).toBe(reason);
    expect(f.calls).toHaveLength(0);
  });
  it("لغو حینِ fetch ⇒ علتِ لغو (نه unavailable)", async () => {
    const ac = new AbortController();
    const f = fakeFetch((r) => new Promise<Response>((_res, rej) => (r.init.signal as AbortSignal).addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")), { once: true })));
    const pr = mk("openai-chat", f).completeWithTools(makeCall("openai-chat", {}, ac.signal));
    await new Promise((r) => setTimeout(r, 5));
    expect(f.calls).toHaveLength(1); // fetch واقعاً در جریان است؛ لغو از مسیرِ catch می‌گذرد، نه بررسیِ پیش از ارسال
    ac.abort("stop-now");
    expect(await caught(pr)).toBe("stop-now");
  });
  it("لغو حینِ خواندنِ بدنه ⇒ علتِ لغو (نه unavailable)", async () => {
    const ac = new AbortController();
    const f = fakeFetch(
      (r) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              (r.init.signal as AbortSignal).addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")), { once: true });
            },
          }),
          { status: 200 },
        ),
    );
    const pr = mk("openai-chat", f).completeWithTools(makeCall("openai-chat", {}, ac.signal));
    await new Promise((r) => setTimeout(r, 5));
    ac.abort("late-stop");
    expect(await caught(pr)).toBe("late-stop");
  });
});

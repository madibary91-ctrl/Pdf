import { describe, expect, it } from "vitest";
import { classifyStatus, discardBody, parseRetryAfter, readJsonCapped } from "./response";

const hdr = (o: Record<string, string>) => new Headers(o);
const NOW = Date.parse("2026-01-01T00:00:00Z");

describe("classifyStatus", () => {
  it("جدولِ دقیق", () => {
    const expected: Record<number, string> = { 200: "ok", 201: "ok", 204: "ok", 299: "ok", 400: "rejected", 401: "auth", 403: "auth", 404: "rejected", 408: "unavailable", 409: "rejected", 413: "rejected", 422: "rejected", 429: "rate_limited", 500: "unavailable", 502: "unavailable", 503: "unavailable", 504: "unavailable", 529: "unavailable", 599: "unavailable" };
    for (const [s, c] of Object.entries(expected)) expect(classifyStatus(Number(s)), s).toBe(c);
  });
  it("هر وضعیتِ ۱۰۰ تا ۵۹۹ دقیقاً یکی از پنج دسته است و ۳xx هرگز ok نیست", () => {
    for (let s = 100; s <= 599; s++) {
      const c = classifyStatus(s);
      expect(["ok", "auth", "rate_limited", "unavailable", "rejected"]).toContain(c);
      if (s < 200 || s >= 300) expect(c).not.toBe("ok");
      if (s >= 300 && s < 400) expect(c).toBe("rejected");
    }
  });
  it("مقدارهای نامعتبر ⇒ rejected", () => {
    for (const v of [Number.NaN, 1.5, -1, 0, 600, 700, Infinity]) expect(classifyStatus(v), String(v)).toBe("rejected");
  });
});

describe("parseRetryAfter", () => {
  const p = (o: Record<string, string>) => parseRetryAfter(hdr(o), () => NOW);
  it("ثانیهٔ صحیح و ms", () => {
    expect(p({ "retry-after": "7" })).toBe(7000);
    expect(p({ "retry-after": " 0 " })).toBe(0);
    expect(p({ "retry-after-ms": "250" })).toBe(250);
  });
  it("retry-after-ms بر retry-after اولویت دارد؛ ms نامعتبر ⇒ برگشت به retry-after", () => {
    expect(p({ "retry-after-ms": "250", "retry-after": "7" })).toBe(250);
    expect(p({ "retry-after-ms": "abc", "retry-after": "7" })).toBe(7000);
    expect(p({ "retry-after-ms": "1.5", "retry-after": "2" })).toBe(2000);
  });
  it("تاریخِ HTTP نسبت به ساعتِ تزریقی؛ گذشته ⇒ ۰", () => {
    expect(p({ "retry-after": "Thu, 01 Jan 2026 00:00:30 GMT" })).toBe(30_000);
    expect(p({ "retry-after": "Wed, 31 Dec 2025 23:00:00 GMT" })).toBe(0);
  });
  it.each(["", "-5", "1.5", "1e3", "abc", "5s", "+5", "99999999", "0x10"])("نامعتبر ⇒ undefined: %j", (v) => {
    expect(p({ "retry-after": v })).toBeUndefined();
  });
  it("نبودنِ سرایند ⇒ undefined؛ ساعتِ خراب ⇒ undefined", () => {
    expect(p({})).toBeUndefined();
    expect(parseRetryAfter(hdr({ "retry-after": "Thu, 01 Jan 2026 00:00:30 GMT" }), () => Number.NaN)).toBeUndefined();
  });
  it("سقفِ ۱ ساعت را ProviderFailure اعمال می‌کند؛ این‌جا فقط عددِ خام", () => {
    expect(p({ "retry-after": "9999999" })).toBe(9_999_999_000);
  });
});

const streamOf = (chunks: Array<Uint8Array | string>, errorAfter = false): ReadableStream<Uint8Array> => {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < chunks.length) {
        const ch = chunks[i++] as Uint8Array | string;
        c.enqueue(typeof ch === "string" ? enc.encode(ch) : ch);
      } else if (errorAfter) c.error(new Error("socket hang up"));
      else c.close();
    },
  });
};
const resp = (body: ReadableStream<Uint8Array> | string | null, headers: Record<string, string> = {}) => new Response(body, { status: 200, headers });

describe("readJsonCapped", () => {
  it("JSON معمولی و UTF-8 فارسی", async () => {
    expect(await readJsonCapped(resp('{"a":"سلام ✓"}'), 1024)).toEqual({ a: "سلام ✓" });
  });
  it("بدنه در چند تکه، حتی وسطِ یک نویسهٔ چندبایتی", async () => {
    const bytes = new TextEncoder().encode('{"a":"سلام"}');
    const mid = bytes.indexOf(0xd8) + 1;
    expect(await readJsonCapped(resp(streamOf([bytes.slice(0, mid), bytes.slice(mid)])), 1024)).toEqual({ a: "سلام" });
  });
  it("BOM پذیرفته می‌شود", async () => {
    expect(await readJsonCapped(resp(streamOf([new Uint8Array([0xef, 0xbb, 0xbf]), '{"a":1}'])), 1024)).toEqual({ a: 1 });
  });
  it("دقیقاً در سقف ⇒ می‌خواند؛ یک بایت بیشتر ⇒ null", async () => {
    const body = '{"a":"xxxxxxxxxx"}';
    const n = new TextEncoder().encode(body).byteLength;
    expect(await readJsonCapped(resp(body), n)).toEqual({ a: "xxxxxxxxxx" });
    expect(await readJsonCapped(resp(body), n - 1)).toBeNull();
  });
  it("سقف حینِ جریان اعمال و جریان لغو می‌شود (بی‌خواندنِ همه)", async () => {
    let pulled = 0;
    let cancelled = false;
    const s = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(100).fill(0x20));
      },
      cancel() {
        cancelled = true;
      },
    });
    expect(await readJsonCapped(resp(s), 250)).toBeNull();
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);
  });
  it("content-lengthِ بزرگ‌تر از سقف ⇒ null بی‌خواندنِ بدنه", async () => {
    let pulled = 0;
    const s = new ReadableStream<Uint8Array>({
      pull() {
        pulled++;
      },
    });
    expect(await readJsonCapped(resp(s, { "content-length": "999999" }), 1024)).toBeNull();
    expect(pulled).toBe(0);
  });
  it("content-lengthِ دروغ (کوچک‌تر) سقفِ حینِ جریان را دور نمی‌زند", async () => {
    expect(await readJsonCapped(resp("x".repeat(5000), { "content-length": "10" }), 1024)).toBeNull();
  });
  it("content-length دقیقاً برابرِ سقف مجاز است (مرزِ شاملِ دو سر)", async () => {
    expect(await readJsonCapped(resp('{"a":1}', { "content-length": "1024" }), 1024)).toEqual({ a: 1 });
    expect(await readJsonCapped(resp('{"a":1}', { "content-length": "1025" }), 1024)).toBeNull();
  });
  it("content-lengthِ نامعتبر نادیده گرفته می‌شود", async () => {
    expect(await readJsonCapped(resp('{"a":1}', { "content-length": "abc" }), 1024)).toEqual({ a: 1 });
  });
  it.each([["بدنهٔ تهی", ""], ["JSON خراب", "{"], ["متن", "hello"], ["HTML", "<html>"], ["فقط فاصله", "   "]])("%s ⇒ null", async (_n, body) => {
    expect(await readJsonCapped(resp(body), 1024)).toBeNull();
  });
  it("UTF-8 نامعتبر ⇒ null", async () => {
    expect(await readJsonCapped(resp(streamOf([new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])])), 1024)).toBeNull();
  });
  it("body=null ⇒ null", async () => {
    expect(await readJsonCapped({ body: null, headers: new Headers() }, 1024)).toBeNull();
  });
  it("تکهٔ غیر Uint8Array ⇒ null", async () => {
    const s = new ReadableStream({ start: (c) => c.enqueue("str" as unknown as Uint8Array) });
    expect(await readJsonCapped(resp(s as ReadableStream<Uint8Array>), 1024)).toBeNull();
  });
  it("عمقِ بسیار زیاد پرتاب نمی‌کند", async () => {
    expect(await readJsonCapped(resp("[".repeat(500_000) + "]".repeat(500_000)), 2_000_000)).toSatisfy((v: unknown) => v === null || Array.isArray(v));
  });
  it("__proto__ در JSON به‌صورتِ ویژگیِ خودی می‌ماند و نمونهٔ سراسری آلوده نمی‌شود", async () => {
    const v = (await readJsonCapped(resp('{"__proto__":{"polluted":1}}'), 1024)) as Record<string, unknown>;
    expect(Object.keys(v)).toEqual(["__proto__"]);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
  it("خطای جریان پرتاب می‌شود (نگاشتش با فراخواننده است)", async () => {
    await expect(readJsonCapped(resp(streamOf(['{"a":'], true)), 1024)).rejects.toThrow("socket hang up");
  });
});

describe("discardBody", () => {
  it("جریان را لغو می‌کند و هرگز پرتاب نمی‌کند", async () => {
    let cancelled = false;
    await discardBody({ body: new ReadableStream({ cancel: () => void (cancelled = true) }) });
    expect(cancelled).toBe(true);
    await expect(discardBody({ body: null })).resolves.toBeUndefined();
    await expect(discardBody({ body: { cancel: () => Promise.reject(new Error("x")) } as unknown as ReadableStream })).resolves.toBeUndefined();
  });
});

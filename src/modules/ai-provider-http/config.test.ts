import { describe, expect, it } from "vitest";
import { HTTP_PROVIDER_LIMITS, resolveOptions, sanitizeApiKey } from "./config";
import { KEY, baseOptions, fakeFetch } from "./test-kit";

const f = fakeFetch(new Response("{}"));
const ok = (over: Record<string, unknown> = {}) => resolveOptions(baseOptions("openai-chat", f, over));
const issuesOf = (r: ReturnType<typeof resolveOptions>) => {
  if (r.ok) throw new Error("انتظار شکست");
  return r.error.issues.join(" | ");
};

describe("resolveOptions · پیش‌فرض‌ها", () => {
  it("پیکربندیِ کمینه معتبر است و پیش‌فرض‌ها اعمال می‌شوند", () => {
    const r = ok();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.maxResponseBytes).toBe(HTTP_PROVIDER_LIMITS.defaultMaxResponseBytes);
    expect(r.value.maxResponseBytes).toBe(1_048_576);
    expect(r.value.anthropicVersion).toBe("2023-06-01");
    expect(r.value.openaiMaxTokensField).toBe("max_tokens");
    expect(r.value.now).toBe(Date.now);
    expect(Object.isFrozen(r.value)).toBe(true);
  });
  it("مقدارهای صریح پذیرفته می‌شوند", () => {
    const now = () => 5;
    const r = resolveOptions(baseOptions("anthropic-messages", f, { maxResponseBytes: 2048, anthropicVersion: "2024-10-22", openaiMaxTokensField: "max_completion_tokens", now }));
    expect(r.ok && r.value.maxResponseBytes).toBe(2048);
    expect(r.ok && r.value.anthropicVersion).toBe("2024-10-22");
    expect(r.ok && r.value.openaiMaxTokensField).toBe("max_completion_tokens");
    expect(r.ok && r.value.now).toBe(now);
  });
  it("نشانی به شکلِ نرمال‌شده (href) نگه داشته می‌شود", () => {
    const r = ok({ endpoint: "https://API.OpenAI.com/v1/chat/completions?api-version=2024-06-01" });
    expect(r.ok && r.value.endpoint).toBe("https://api.openai.com/v1/chat/completions?api-version=2024-06-01");
  });
});

describe("resolveOptions · رد بر مرز", () => {
  it.each([null, undefined, 5, "x", [], () => 1])("ورودیِ غیرشیء رد می‌شود: %s", (v) => {
    expect(resolveOptions(v).ok).toBe(false);
  });
  it("کلیدِ ناشناخته رد می‌شود و نامش بریده می‌شود", () => {
    const r = ok({ ["x".repeat(100)]: 1 });
    expect(r.ok).toBe(false);
    expect(issuesOf(r)).toContain("کلیدِ ناشناخته");
    expect(issuesOf(r).length).toBeLessThan(200);
  });
  it.each(["openai", "", undefined, 3, "OPENAI-CHAT"])("format نامعتبر: %s", (v) => {
    expect(issuesOf(ok({ format: v }))).toContain("format");
  });
  it("getApiKey و fetch باید تابع باشند", () => {
    expect(issuesOf(ok({ getApiKey: "sk-secret-literal" }))).toContain("getApiKey");
    expect(issuesOf(ok({ fetch: {} }))).toContain("fetch");
    expect(issuesOf(ok({ getApiKey: undefined }))).toContain("getApiKey");
  });
  it.each([0, 1023, 16_777_217, 1.5, "1024", Number.NaN, Infinity, -5])("maxResponseBytes نامعتبر: %s", (v) => {
    expect(issuesOf(ok({ maxResponseBytes: v }))).toContain("maxResponseBytes");
  });
  it.each([1024, 16_777_216])("مرزهای maxResponseBytes (شاملِ دو سر): %s", (v) => {
    expect(ok({ maxResponseBytes: v }).ok).toBe(true);
  });
  it.each(["2023-6-1", "latest", 2023, "2023-06-01 ", "20230601"])("anthropicVersion نامعتبر: %s", (v) => {
    expect(issuesOf(ok({ anthropicVersion: v }))).toContain("anthropicVersion");
  });
  it("openaiMaxTokensField و now و allowInsecureLoopback نامعتبر", () => {
    expect(issuesOf(ok({ openaiMaxTokensField: "max_output_tokens" }))).toContain("openaiMaxTokensField");
    expect(issuesOf(ok({ now: 5 }))).toContain("now");
    expect(issuesOf(ok({ allowInsecureLoopback: "yes" }))).toContain("allowInsecureLoopback");
  });
  it("همهٔ مشکلات یک‌جا گزارش می‌شوند، حداکثر ۱۰ مورد", () => {
    const r = resolveOptions({ ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, 1])), format: 1 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.issues.length).toBe(10);
  });
});

describe("resolveOptions · نشانی (endpoint)", () => {
  const bad: ReadonlyArray<readonly [string, unknown]> = [
    ["غیررشته", 5],
    ["تهی", ""],
    ["نسبی", "/v1/chat/completions"],
    ["بی‌پروتکل", "api.openai.com/v1"],
    ["http بی‌مجوز", "http://api.openai.com/v1/chat/completions"],
    ["ftp", "ftp://api.openai.com/x"],
    ["file", "file:///etc/passwd"],
    ["javascript", "javascript:alert(1)"],
    ["userinfo", "https://user:pass@api.openai.com/v1"],
    ["فقط user", "https://user@api.openai.com/v1"],
    ["fragment", "https://api.openai.com/v1#x"],
    ["فاصله", "https://api.openai.com/v1 /x"],
    ["خط جدید", "https://api.openai.com/v1\n/x"],
    ["تب", "https://api.openai.com/\tv1"],
    ["بک‌اسلش", "https://api.openai.com\\@evil.example/v1"],
    ["NUL", "https://api.openai.com/v1\u0000"],
    ["خیلی بلند", `https://api.openai.com/${"a".repeat(2100)}`],
    ["هاستِ تهی (ترمیمِ WHATWG)", "https:///v1"],
    ["بی‌اسلش", "https:api.openai.com/v1"],
    ["یک اسلش", "https:/api.openai.com/v1"],
    ["سه اسلش با کوئری", "https:///?x=api.openai.com"],
  ];
  it.each(bad)("رد می‌شود: %s", (_n, v) => {
    expect(ok({ endpoint: v }).ok).toBe(false);
  });
  it("http فقط با allowInsecureLoopback و فقط برای loopback", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      expect(ok({ endpoint: `http://${host}:8080/v1/chat/completions`, allowInsecureLoopback: true }).ok).toBe(true);
      expect(ok({ endpoint: `http://${host}:8080/v1/chat/completions` }).ok).toBe(false);
    }
    for (const host of ["example.com", "10.0.0.1", "127.0.0.2", "localhost.evil.example", "0.0.0.0", "evil.example#@localhost"]) {
      expect(ok({ endpoint: `http://${host}/v1`, allowInsecureLoopback: true }).ok).toBe(false);
    }
  });
  it("http://user@localhost همچنان رد می‌شود", () => {
    expect(ok({ endpoint: "http://user@localhost/v1", allowInsecureLoopback: true }).ok).toBe(false);
  });
  it("https برای هر میزبان بی‌نیاز از allowInsecureLoopback است و با آن هم کار می‌کند", () => {
    expect(ok({ endpoint: "https://gateway.example.ir/openai/v1/chat/completions", allowInsecureLoopback: true }).ok).toBe(true);
  });
  it("پیامِ خطا هیچ‌گاه نشانی یا کلید را بازتاب نمی‌دهد", () => {
    const secretUrl = "https://user:SUPERSECRET@api.openai.com/v1";
    const r = resolveOptions({ ...baseOptions("openai-chat", f), endpoint: secretUrl, getApiKey: "KEYLITERAL" });
    const dump = JSON.stringify(r);
    expect(dump).not.toContain("SUPERSECRET");
    expect(dump).not.toContain("KEYLITERAL");
    expect(dump).not.toContain("api.openai.com");
  });
});

describe("sanitizeApiKey", () => {
  it("کلیدِ ASCII چاپی پذیرفته می‌شود", () => {
    expect(sanitizeApiKey(KEY)).toBe(KEY);
    expect(sanitizeApiKey("a")).toBe("a");
    expect(sanitizeApiKey("~!")).toBe("~!");
    expect(sanitizeApiKey("a".repeat(HTTP_PROVIDER_LIMITS.maxKeyChars))).not.toBeNull();
  });
  it.each(["", " ", "a b", "a\nb", "a\r\nX-Evil: 1", "a\tb", "کلید", "a\u0000b", "a\u007fb", "é", `${"a".repeat(513)}`, 5, null, undefined, {}, ["a"]])("کلیدِ نامعتبر ⇒ null: %j", (v) => {
    expect(sanitizeApiKey(v)).toBeNull();
  });
});

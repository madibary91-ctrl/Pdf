import { describe, expect, it } from "vitest";
import { resolveConfig } from "./config";
import { createOrchestrator } from "./orchestrator";
import { fakeChecker, fakeGateway, fakeSearcher, replyJson } from "./test-kit";

const good = () => ({
  searcher: fakeSearcher([]),
  gateway: fakeGateway(() => replyJson({ answer: "x", citations: [] })),
  checker: fakeChecker({ texts: {} }),
  policy: { onRejectedCitation: "withhold", requireQuotes: true },
});
const issuesOf = (r: ReturnType<typeof resolveConfig>): readonly string[] => (r.ok ? [] : (r.error.issues ?? []));

describe("ai-orchestrator · resolveConfig", () => {
  it("پیکربندی معتبر پذیرفته می‌شود و منجمد است", () => {
    const r = resolveConfig(good());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.isFrozen(r.value)).toBe(true);
      expect(Object.isFrozen(r.value.policy)).toBe(true);
      expect(r.value.policy).toEqual({ onRejectedCitation: "withhold", requireQuotes: true });
    }
  });

  it("غیرشیء ⇒ INVALID_CONFIG", () => {
    for (const bad of [null, undefined, 5, "x", [], true]) {
      const r = resolveConfig(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatchObject({ code: "INVALID_CONFIG", retryable: false, issues: ["config"], accounting: null });
    }
  });

  it("هر بخش ناقص با نام خودش؛ همه یک‌جا", () => {
    expect(issuesOf(resolveConfig({}))).toEqual(["searcher", "gateway", "checker", "policy"]);
    expect(issuesOf(resolveConfig({ ...good(), searcher: {} }))).toEqual(["searcher"]);
    expect(issuesOf(resolveConfig({ ...good(), searcher: null }))).toEqual(["searcher"]);
    expect(issuesOf(resolveConfig({ ...good(), gateway: { complete() {} } }))).toEqual(["gateway"]);
    expect(issuesOf(resolveConfig({ ...good(), gateway: { limits() {} } }))).toEqual(["gateway"]);
    expect(issuesOf(resolveConfig({ ...good(), checker: {} }))).toEqual(["checker"]);
    expect(issuesOf(resolveConfig({ ...good(), policy: null }))).toEqual(["policy"]);
    expect(issuesOf(resolveConfig({ ...good(), policy: [] }))).toEqual(["policy"]);
  });

  it("سیاست بی‌پیش‌فرض: هر دو میدان الزامی و دقیق‌اند", () => {
    expect(issuesOf(resolveConfig({ ...good(), policy: {} }))).toEqual(["policy.onRejectedCitation", "policy.requireQuotes"]);
    expect(issuesOf(resolveConfig({ ...good(), policy: { requireQuotes: true } }))).toEqual(["policy.onRejectedCitation"]);
    expect(issuesOf(resolveConfig({ ...good(), policy: { onRejectedCitation: "redact" } }))).toEqual(["policy.requireQuotes"]);
    for (const v of ["REDACT", "drop", "", null, true, 1]) expect(issuesOf(resolveConfig({ ...good(), policy: { onRejectedCitation: v, requireQuotes: true } })), String(v)).toEqual(["policy.onRejectedCitation"]);
    for (const v of ["true", 1, 0, null, undefined]) expect(issuesOf(resolveConfig({ ...good(), policy: { onRejectedCitation: "redact", requireQuotes: v } })), String(v)).toEqual(["policy.requireQuotes"]);
    for (const a of ["redact", "withhold"] as const) for (const q of [true, false]) expect(resolveConfig({ ...good(), policy: { onRejectedCitation: a, requireQuotes: q } }).ok).toBe(true);
  });

  it("کلید ناشناخته (غلط املایی) رد؛ در سطح بالا و سیاست", () => {
    expect(issuesOf(resolveConfig({ ...good(), usageSink: {} }))).toEqual(["unknown:usageSink"]);
    expect(issuesOf(resolveConfig({ ...good(), policy: { onRejectedCitation: "redact", requireQuotes: true, requireQuote: true } }))).toEqual(["unknown:policy.requireQuote"]);
    expect(issuesOf(resolveConfig({ ...good(), verifiedOnly: false }))).toEqual(["unknown:verifiedOnly"]);
  });

  it("پیکربندی «گرفته» می‌شود: ویرایش بعدی شیء ورودی و پورت‌ها اثر ندارد", async () => {
    const cfg = good();
    const r = resolveConfig(cfg);
    if (!r.ok) throw new Error("config");
    const original = cfg.searcher.searchArticles;
    (cfg.policy as { requireQuotes: boolean }).requireQuotes = false;
    (cfg as { searcher: unknown }).searcher = null;
    (cfg.gateway as { limits: unknown }).limits = () => null;
    (cfg.checker as { open: unknown }).open = () => {
      throw new Error("tampered");
    };
    expect(r.value.policy.requireQuotes).toBe(true);
    expect(r.value.gateway.limits("legal-chat")).not.toBeNull();
    expect(typeof original).toBe("function");
    await expect(Promise.resolve(r.value.checker.open())).resolves.toBeDefined();
  });

  it("createOrchestrator خطای پیکربندی را بی‌پرتاب برمی‌گرداند", () => {
    const r = createOrchestrator({ ...good(), policy: undefined });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_CONFIG");
    expect(createOrchestrator(good()).ok).toBe(true);
  });
});

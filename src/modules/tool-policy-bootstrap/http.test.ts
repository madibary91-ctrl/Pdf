/**
 * پاسخ HTTP پروب‌ها (ADR-0076 تصمیم ۴): با میزبانِ واقعیِ `tool-policy-host` و ریشهٔ ساختگی؛ هرگز نمی‌پرتابد، هرگز کش نمی‌شود،
 * بدنهٔ بسته، و پاسخِ ناهمسازِ میزبان ۵۰۳ می‌شود (هیچ مسیری از «نمی‌دانم» به ۲۰۰ نیست).
 */
import { afterEach, describe, expect, it } from "vitest";
import { TOOL_POLICY_HOST_STORE_KEY, createToolPolicyHost } from "@/modules/tool-policy-host";
import type { ToolPolicyHost } from "@/modules/tool-policy-host";
import { probeHttpResponse } from "./index";

const CANARY = "LEAK-CANARY-policy-http-3b77";
const timer = { after: () => 0, cancel: () => undefined };

type Health = { state: string; ready: boolean; reason: string | null };
const READY: Health = { state: "RUNNING", ready: true, reason: null };

function hostWith(health: () => unknown): ToolPolicyHost {
  const runtime = { start: async () => ({ started: true as const }), stop: async () => ({ stopped: true, abandonedInFlight: false }), health };
  const made = createToolPolicyHost({ runtime, timer, signals: false });
  if (!made.ok) throw new Error("cfg");
  return made.value;
}

const g: Record<symbol, unknown> = {};
afterEach(async () => {
  const h = g[TOOL_POLICY_HOST_STORE_KEY] as ToolPolicyHost | undefined;
  await h?.shutdown();
  delete g[TOOL_POLICY_HOST_STORE_KEY];
});

const bodyOf = async (r: Response): Promise<unknown> => JSON.parse(await r.text());

describe("tool-policy-bootstrap · http · بدونِ میزبان", () => {
  it("live ۲۰۰؛ startup و ready ۵۰۳ با state absent", async () => {
    expect(probeHttpResponse(g, "live").status).toBe(200);
    expect(probeHttpResponse(g, "startup").status).toBe(503);
    const r = probeHttpResponse(g, "ready");
    expect(r.status).toBe(503);
    expect(await bodyOf(r)).toEqual({ probe: "ready", ok: false, state: "absent", reason: null });
  });

  it.each(["live", "startup", "ready"] as const)("%s: بی‌کش با نوعِ JSON", (k) => {
    const r = probeHttpResponse(g, k);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("content-type")).toBe("application/json; charset=utf-8");
  });

  it.each([undefined, null, "", "LIVE", "health", "x", 1, {}, ["live"]])("kind ناشناخته (%j) ⇒ ۵۰۳ بدنهٔ ثابت", async (k) => {
    const r = probeHttpResponse(g, k as never);
    expect(r.status).toBe(503);
    expect(await bodyOf(r)).toEqual({ ok: false });
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it.each([null, undefined, 5, "x"])("ظرفِ نامعتبر (%j) هرگز نمی‌پرتابد و مثلِ نبودنِ میزبان است", (store) => {
    expect(probeHttpResponse(store, "live").status).toBe(200);
    expect(probeHttpResponse(store, "ready").status).toBe(503);
  });
});

describe("tool-policy-bootstrap · http · با میزبان", () => {
  it("running + ریشهٔ آماده: هر سه ۲۰۰ و بدنهٔ بسته", async () => {
    const h = hostWith(() => READY);
    g[TOOL_POLICY_HOST_STORE_KEY] = h;
    await h.boot();
    expect([probeHttpResponse(g, "live").status, probeHttpResponse(g, "startup").status, probeHttpResponse(g, "ready").status]).toEqual([200, 200, 200]);
    expect(await bodyOf(probeHttpResponse(g, "ready"))).toEqual({ probe: "ready", ok: true, state: "running", reason: null });
  });

  it("بوت‌شده ولی ریشه آماده نیست ⇒ ready ۵۰۳ با دلیلِ ثابت، live ۲۰۰ (بوت ≠ آماده)", async () => {
    const h = hostWith(() => ({ state: "RUNNING", ready: false, reason: "NOT_LOADED" }));
    g[TOOL_POLICY_HOST_STORE_KEY] = h;
    await h.boot();
    const r = probeHttpResponse(g, "ready");
    expect(r.status).toBe(503);
    expect(await bodyOf(r)).toEqual({ probe: "ready", ok: false, state: "running", reason: "NOT_LOADED" });
    expect(probeHttpResponse(g, "startup").status).toBe(503);
    expect(probeHttpResponse(g, "live").status).toBe(200);
  });

  it("پس از خاموشی ready ۵۰۳ است", async () => {
    const h = hostWith(() => READY);
    g[TOOL_POLICY_HOST_STORE_KEY] = h;
    await h.boot();
    await h.shutdown();
    expect(probeHttpResponse(g, "ready").status).toBe(503);
  });

  it("متنِ آزادِ ریشه (reason ناشناخته) بیرون نمی‌آید", async () => {
    const h = hostWith(() => ({ state: "RUNNING", ready: false, reason: CANARY }));
    g[TOOL_POLICY_HOST_STORE_KEY] = h;
    await h.boot();
    const r = probeHttpResponse(g, "ready");
    expect(await r.text()).not.toContain(CANARY);
    expect(r.status).toBe(503);
  });
});

describe("tool-policy-bootstrap · http · میزبانِ خراب هرگز ۲۰۰ نمی‌دهد", () => {
  const install = (probes: unknown): void => {
    g[TOOL_POLICY_HOST_STORE_KEY] = { boot: async () => undefined, shutdown: async () => undefined, status: () => ({}), probes };
  };
  const body = (state: unknown, ok: unknown, reason: unknown = null): unknown => ({ probe: "ready", ok, state, reason });

  it("پروبی که می‌پرتابد ⇒ مثلِ نبودنِ میزبان (live ۲۰۰ فقط چون سیاستِ absent است؛ ready ۵۰۳)", () => {
    const boom = (): never => { throw new Error(CANARY); };
    install({ live: boom, startup: boom, ready: boom });
    expect(probeHttpResponse(g, "ready").status).toBe(503);
    expect(probeHttpResponse(g, "startup").status).toBe(503);
  });

  it.each([
    ["۲۰۰ با ok=false", { httpStatus: 200, body: body("running", false) }],
    ["۵۰۳ با ok=true", { httpStatus: 503, body: body("running", true) }],
    ["کدِ وضعیتِ دیگر", { httpStatus: 500, body: body("running", false) }],
    ["کدِ وضعیتِ رشته", { httpStatus: "200", body: body("running", true) }],
    ["بی‌بدنه", { httpStatus: 200 }],
    ["بدنهٔ null", { httpStatus: 200, body: null }],
    ["ok غیربولی", { httpStatus: 200, body: body("running", 1) }],
    ["state غیررشته", { httpStatus: 200, body: body(5, true) }],
    ["reason غیررشته", { httpStatus: 200, body: body("running", true, 7) }],
    ["reason undefined", { httpStatus: 200, body: { probe: "ready", ok: true, state: "running" } }],
    ["پاسخ null", null],
    ["پاسخ رشته", "ok"],
  ])("پاسخِ ناهمساز: %s ⇒ ۵۰۳ با {ok:false}", async (_n, answer) => {
    install({ live: () => answer, startup: () => answer, ready: () => answer });
    for (const k of ["live", "startup", "ready"] as const) {
      const r = probeHttpResponse(g, k);
      expect(r.status, k).toBe(503);
      expect(await bodyOf(r), k).toEqual({ ok: false });
    }
  });

  it("بدنهٔ خروجی همیشه فقط چهار کلیدِ بسته (کلیدِ اضافهٔ میزبان درز نمی‌کند)", async () => {
    const fat = () => ({ httpStatus: 200, body: { probe: "ready", ok: true, state: "running", reason: null, secret: CANARY, count: 3 } });
    install({ live: fat, startup: fat, ready: fat });
    const r = probeHttpResponse(g, "ready");
    expect(r.status).toBe(200);
    expect(Object.keys((await bodyOf(r)) as object).sort()).toEqual(["ok", "probe", "reason", "state"]);
  });

  it("probe در بدنه همان kindِ درخواست است (نه آنچه میزبان گفته)", async () => {
    const lie = () => ({ httpStatus: 200, body: { probe: "live", ok: true, state: "running", reason: null } });
    install({ live: lie, startup: lie, ready: lie });
    expect(((await bodyOf(probeHttpResponse(g, "ready"))) as { probe: string }).probe).toBe("ready");
  });
});

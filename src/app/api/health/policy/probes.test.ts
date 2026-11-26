/**
 * مسیرهای پروبِ میزبانِ سیاستِ ابزار (ADR-0076): `/api/health/policy/{live,startup,ready}`. نازک و بی‌کش؛
 * `/api/health`ِ اصلی و پروب‌های تسویه دست‌نخورده‌اند و کلیدِ singletonِ جدا دارند.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TOOL_POLICY_HOST_STORE_KEY, createToolPolicyHost, getToolPolicyHost } from "@/modules/tool-policy-host";
import { GET as live, dynamic as liveDynamic } from "./live/route";
import { GET as ready, dynamic as readyDynamic } from "./ready/route";
import { GET as startup, dynamic as startupDynamic } from "./startup/route";

const g = globalThis as Record<symbol, unknown>;
afterEach(async () => {
  await getToolPolicyHost(g)?.shutdown();
  delete g[TOOL_POLICY_HOST_STORE_KEY];
});

function install(health: unknown) {
  const runtime = { start: async () => ({ started: true as const }), stop: async () => ({ stopped: true, abandonedInFlight: false }), health: () => health };
  const made = createToolPolicyHost({ runtime, timer: { after: () => 0, cancel: () => undefined }, signals: false });
  if (!made.ok) throw new Error("cfg");
  g[TOOL_POLICY_HOST_STORE_KEY] = made.value;
  return made.value;
}

describe("health policy probes · مسیرها", () => {
  it("بدونِ میزبان (TOOL_POLICY_HOST خاموش): live ۲۰۰؛ startup و ready ۵۰۳ با state absent", async () => {
    expect(live().status).toBe(200);
    expect([startup().status, ready().status]).toEqual([503, 503]);
    expect(await ready().json()).toEqual({ probe: "ready", ok: false, state: "absent", reason: null });
  });

  it("با میزبانِ running و ریشهٔ آماده روی globalThis هر سه ۲۰۰ (همان نقطهٔ مشترکِ instrumentation)", async () => {
    const h = install({ state: "RUNNING", ready: true, reason: null });
    await h.boot();
    expect([live().status, startup().status, ready().status]).toEqual([200, 200, 200]);
    expect(await startup().json()).toMatchObject({ probe: "startup", ok: true, state: "running" });
  });

  it("بوت شد ولی آماده نیست ⇒ ready و startup ۵۰۳ با دلیلِ ثابت؛ live ۲۰۰", async () => {
    const h = install({ state: "RUNNING", ready: false, reason: "NOT_LOADED" });
    await h.boot();
    expect([live().status, startup().status, ready().status]).toEqual([200, 503, 503]);
    expect(await ready().json()).toEqual({ probe: "ready", ok: false, state: "running", reason: "NOT_LOADED" });
  });

  it("پس از خاموشی ready ۵۰۳ است و بی‌کش", async () => {
    const h = install({ state: "RUNNING", ready: true, reason: null });
    await h.boot();
    await h.shutdown();
    const r = ready();
    expect(r.status).toBe(503);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("هر سه مسیر force-dynamic‌اند", () => {
    expect([liveDynamic, startupDynamic, readyDynamic]).toEqual(["force-dynamic", "force-dynamic", "force-dynamic"]);
  });

  it("مسیرها نازک‌اند: فقط probeHttpResponse از tool-policy-bootstrap با globalThis", () => {
    for (const k of ["live", "startup", "ready"]) {
      const code = readFileSync(join(__dirname, k, "route.ts"), "utf8");
      expect(code).toContain('from "@/modules/tool-policy-bootstrap"');
      expect(code).toContain(`probeHttpResponse(globalThis, "${k}")`);
      expect(code).not.toMatch(/process\.env|@\/db|settlement/);
    }
  });

  it("پروب‌های تسویه و سیاست مستقل‌اند: میزبانِ سیاست پروبِ /api/health/{ready} تسویه را عوض نمی‌کند", async () => {
    const { GET: settlementReady } = await import("../ready/route");
    const h = install({ state: "RUNNING", ready: true, reason: null });
    await h.boot();
    expect(settlementReady().status).toBe(503); // تسویه میزبانی ندارد
    expect(ready().status).toBe(200);
  });
});

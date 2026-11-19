/**
 * مسیرهای پروبِ رفتگرِ تسویه (ADR-0033): `/api/health/{live,startup,ready}`. هر مسیر باید نازک و بی‌کش باشد؛
 * `/api/health` اصلی (select 1، برای build_and_start) دست‌نخورده می‌ماند.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SETTLEMENT_HOST_STORE_KEY, createSettlementHost, getSettlementHost } from "@/modules/settlement-host";
import { GET as live, dynamic as liveDynamic } from "./live/route";
import { GET as ready, dynamic as readyDynamic } from "./ready/route";
import { GET as startup, dynamic as startupDynamic } from "./startup/route";

const g = globalThis as Record<symbol, unknown>;
afterEach(async () => {
  await getSettlementHost(g)?.shutdown();
  delete g[SETTLEMENT_HOST_STORE_KEY];
});

function install(health: unknown) {
  const runtime = { start: async () => ({ started: true as const, atMs: 1 }), stop: async () => ({ clean: true }), health: () => health as never };
  const made = createSettlementHost({ runtime, timer: { after: () => 0, cancel: () => undefined }, signals: false });
  if (!made.ok) throw new Error("cfg");
  g[SETTLEMENT_HOST_STORE_KEY] = made.value;
  return made.value;
}

describe("health probes · مسیرها", () => {
  it("بدونِ میزبان (SETTLEMENT_HOST خاموش): live ۲۰۰؛ startup و ready ۵۰۳ با state absent", async () => {
    expect((await live()).status).toBe(200);
    const s = startup();
    const r = ready();
    expect([s.status, r.status]).toEqual([503, 503]);
    expect(await r.json()).toEqual({ probe: "ready", ok: false, state: "absent", sweep: null });
  });

  it("با میزبانِ running روی globalThis هر سه ۲۰۰ (همان نقطهٔ مشترکِ instrumentation)", async () => {
    await install({ health: { status: "ok" }, httpStatus: 200 }).boot();
    expect([(await live()).status, startup().status, ready().status]).toEqual([200, 200, 200]);
    expect(await startup().json()).toMatchObject({ probe: "startup", ok: true, state: "running" });
  });

  it("پس از خاموشی ready ۵۰۳ است و بی‌کش", async () => {
    const h = install({ health: { status: "ok" }, httpStatus: 200 });
    await h.boot();
    await h.shutdown();
    const r = ready();
    expect(r.status).toBe(503);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("هر سه مسیر force-dynamic‌اند (هرگز در ساخت پیش‌رندر نمی‌شوند)", () => {
    expect([liveDynamic, startupDynamic, readyDynamic]).toEqual(["force-dynamic", "force-dynamic", "force-dynamic"]);
  });

  it("مسیرِ اصلیِ /api/health دست‌نخورده: همچنان select 1 و {ok:true} (قراردادِ build_and_start)", () => {
    const src = readFileSync(join(__dirname, "route.ts"), "utf8");
    expect(src).toContain("select 1");
    expect(src).toContain("Response.json({ ok: true })");
    expect(src).not.toMatch(/settlement/i);
  });

  it("هر مسیر فقط به رابطِ عمومیِ settlement-bootstrap وابسته است و GET نازک است", () => {
    for (const k of ["live", "startup", "ready"]) {
      const src = readFileSync(join(__dirname, k, "route.ts"), "utf8");
      expect([...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1])).toEqual(["@/modules/settlement-bootstrap"]);
      expect(src).toContain(`probeHttpResponse(globalThis, "${k}")`);
    }
  });
});

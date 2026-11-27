/**
 * انتخابِ بازکنندهٔ پایگاهِ میزبانِ سیاست و استخرِ اختصاصی (ADR-0083). درایور ساختگی است؛ با PostgreSQL واقعی:
 * `tooling/tool-policy-dedicated-pool.pg.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import {
  POLICY_APPLICATION_NAME,
  POLICY_CONNECT_TIMEOUT_MS,
  POLICY_DATABASE_URL_ENV,
  POLICY_POOL_MAX,
  isValidPolicyDatabaseUrl,
  selectPolicyDatabaseOpener,
  type PolicyPoolDriver,
  type PolicyPoolEvent,
  type PolicyPoolLike,
  type PolicyPoolOptions,
} from "./instrumentation-policy-db";

const URL_OK = "postgresql://runtime_user:s3cr3t-pw@db.internal:5432/app?sslmode=require";

function rig(env: Record<string, unknown>, opts: { endFails?: boolean } = {}) {
  const events: PolicyPoolEvent[] = [];
  const shared = vi.fn(async () => ({ db: { tag: "shared" }, close: async () => undefined, release: () => undefined }));
  const listeners: Array<(e: unknown) => void> = [];
  const created: PolicyPoolOptions[] = [];
  const end = vi.fn(async (): Promise<unknown> => {
    if (opts.endFails) throw Object.assign(new Error("boom host=db.internal password=s3cr3t-pw"), { code: "ECONNRESET" });
    return undefined;
  });
  const pool: PolicyPoolLike = { end, on: (_e, l) => void listeners.push(l) };
  const driverLoaded = vi.fn();
  const driver = async (): Promise<PolicyPoolDriver> => {
    driverLoaded();
    return {
      createPool: (o) => {
        created.push(o);
        return pool;
      },
      wrap: (p) => ({ tag: "dedicated", pool: p }),
    };
  };
  const open = selectPolicyDatabaseOpener({ env, shared, log: (e) => void events.push(e), driver });
  return { open, shared, events, listeners, created, end, driverLoaded, pool };
}

describe("selectPolicyDatabaseOpener · انتخاب", () => {
  it("متغیر نبود ⇒ همان بازکنندهٔ مشترک (هویتِ شیء)، بی‌بارگذاریِ درایور", () => {
    const r = rig({});
    expect(r.open).toBe(r.shared);
    expect(r.driverLoaded).not.toHaveBeenCalled();
  });

  it("متغیرِ خالی = نبود (قراردادِ env: خالی خاموش/پیش‌فرض است)", () => {
    const r = rig({ [POLICY_DATABASE_URL_ENV]: "" });
    expect(r.open).toBe(r.shared);
  });

  it("رشتهٔ معتبر ⇒ بازکنندهٔ دیگر؛ تا فراخوانی هیچ درایور/استخری ساخته نمی‌شود (تنبل)", () => {
    const r = rig({ [POLICY_DATABASE_URL_ENV]: URL_OK });
    expect(r.open).not.toBe(r.shared);
    expect(r.driverLoaded).not.toHaveBeenCalled();
    expect(r.created).toEqual([]);
    expect(r.events).toEqual([]);
  });

  it("استخرِ جدا با رشتهٔ داده‌شده، سقفِ ۲، مهلتِ اتصال و application_name؛ استخرِ مشترک هرگز صدا زده نمی‌شود", async () => {
    const r = rig({ [POLICY_DATABASE_URL_ENV]: URL_OK });
    const opened = await r.open();
    expect(r.created).toEqual([{ connectionString: URL_OK, max: POLICY_POOL_MAX, connectionTimeoutMillis: POLICY_CONNECT_TIMEOUT_MS, application_name: POLICY_APPLICATION_NAME }]);
    expect(POLICY_POOL_MAX).toBe(2);
    expect(opened.db).toEqual({ tag: "dedicated", pool: r.pool });
    expect(r.shared).not.toHaveBeenCalled();
    expect(r.events).toEqual([{ type: "pool.opened", mode: "dedicated" }]);
  });

  it("DATABASE_URL (پرامتیاز) هرگز جایگزین نمی‌شود: env دیگر نادیده است", async () => {
    const r = rig({ [POLICY_DATABASE_URL_ENV]: URL_OK, DATABASE_URL: "postgresql://super:pw@elsewhere/app" });
    await r.open();
    expect(r.created[0]?.connectionString).toBe(URL_OK);
  });
});

describe("selectPolicyDatabaseOpener · شکست‌بسته", () => {
  const BAD: unknown[] = ["mysql://u:p@h/db", "not a url", " postgresql://u:p@h/db", "postgresql://u:p@h/db ", "postgresql://", "postgres:///db", 5, true, {}, ["postgresql://u:p@h/db"]];

  it.each(BAD.map((v) => [JSON.stringify(v), v] as const))("رشتهٔ نامعتبر %s ⇒ پرتاب، نه بازگشت به استخرِ مشترک؛ بی‌درایور", async (_n, v) => {
    const r = rig({ [POLICY_DATABASE_URL_ENV]: v });
    expect(r.open).not.toBe(r.shared);
    await expect(r.open()).rejects.toThrow("POLICY_DATABASE_URL_INVALID");
    expect(r.shared).not.toHaveBeenCalled();
    expect(r.driverLoaded).not.toHaveBeenCalled();
    expect(r.events).toEqual([{ type: "pool.config-invalid", env: "POLICY_DATABASE_URL" }]);
  });

  it("پیامِ خطا و لاگِ نامعتبر مقدارِ رشته را نمی‌آورند", async () => {
    const secret = "mysql://leaky:topsecret@h/db";
    const r = rig({ [POLICY_DATABASE_URL_ENV]: secret });
    const err = await r.open().then(() => null, (e: unknown) => e as Error);
    expect(String(err?.message)).not.toContain("topsecret");
    expect(JSON.stringify(r.events)).not.toContain("topsecret");
  });

  it("درایور بارگذاری‌نشدنی ⇒ پرتاب و استخرِ مشترک صدا زده نمی‌شود", async () => {
    const shared = vi.fn();
    const open = selectPolicyDatabaseOpener({ env: { [POLICY_DATABASE_URL_ENV]: URL_OK }, shared: shared as never, log: () => undefined, driver: () => Promise.reject(new Error("no pg")) });
    await expect(open()).rejects.toThrow("no pg");
    expect(shared).not.toHaveBeenCalled();
  });

  it("isValidPolicyDatabaseUrl: فقط postgres/postgresql با میزبان", () => {
    expect(isValidPolicyDatabaseUrl(URL_OK)).toBe(true);
    expect(isValidPolicyDatabaseUrl("postgres://u:p@127.0.0.1/db")).toBe(true);
    expect(isValidPolicyDatabaseUrl("http://u:p@h/db")).toBe(false);
    expect(isValidPolicyDatabaseUrl("")).toBe(false);
    expect(isValidPolicyDatabaseUrl(undefined)).toBe(false);
  });
});

describe("selectPolicyDatabaseOpener · چرخهٔ عمر", () => {
  it("close استخر را دقیقاً یک بار می‌بندد؛ فراخوانیِ دوباره همان وعده است", async () => {
    const r = rig({ [POLICY_DATABASE_URL_ENV]: URL_OK });
    const o = await r.open();
    const a = o.close();
    const b = o.close();
    expect(a).toBe(b);
    await a;
    await o.close();
    expect(r.end).toHaveBeenCalledTimes(1);
    expect(r.events.at(-1)).toEqual({ type: "pool.closed" });
  });

  it("release (شکستِ بوت) هم استخرِ اختصاصی را می‌بندد (برخلافِ مشترک؛ دیگری آن را نمی‌خواند) و پس از آن close بی‌اثر است", async () => {
    const r = rig({ [POLICY_DATABASE_URL_ENV]: URL_OK });
    const o = await r.open();
    o.release();
    await o.close();
    expect(r.end).toHaveBeenCalledTimes(1);
  });

  it("خطای end به close می‌رسد (میزبان closed:failed می‌کند) ولی release آن را می‌بلعد؛ لاگ فقط رویدادِ ثابت است", async () => {
    const a = rig({ [POLICY_DATABASE_URL_ENV]: URL_OK }, { endFails: true });
    const oa = await a.open();
    await expect(oa.close()).rejects.toThrow();
    expect(a.events.at(-1)).toEqual({ type: "pool.close-failed" });
    expect(JSON.stringify(a.events)).not.toContain("s3cr3t");
    const b = rig({ [POLICY_DATABASE_URL_ENV]: URL_OK }, { endFails: true });
    const ob = await b.open();
    expect(() => ob.release()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(b.end).toHaveBeenCalledTimes(1);
  });

  it("pool.on('error') نصب است و فقط کدِ کوتاه را لاگ می‌کند، نه message (ممکن است نشانی/رمز داشته باشد)", async () => {
    const r = rig({ [POLICY_DATABASE_URL_ENV]: URL_OK });
    await r.open();
    expect(r.listeners).toHaveLength(1);
    r.listeners[0]?.(Object.assign(new Error("password authentication failed for user runtime_user s3cr3t-pw"), { code: "57P01" }));
    r.listeners[0]?.(new Error("no code s3cr3t-pw"));
    r.listeners[0]?.(Object.assign(new Error("x"), { code: "A".repeat(40) }));
    r.listeners[0]?.(null);
    const errors = r.events.filter((e) => e.type === "pool.error");
    expect(errors).toEqual([
      { type: "pool.error", code: "57P01" },
      { type: "pool.error", code: "UNKNOWN" },
      { type: "pool.error", code: "UNKNOWN" },
      { type: "pool.error", code: "UNKNOWN" },
    ]);
    expect(JSON.stringify(r.events)).not.toContain("s3cr3t");
  });

  it("لاگِ پرتاب‌کننده یا رد‌شونده بازکردن/بستن را نمی‌شکند", async () => {
    const pool: PolicyPoolLike = { end: async () => undefined, on: () => undefined };
    for (const log of [
      () => {
        throw new Error("log down");
      },
      () => Promise.reject(new Error("log down")),
    ]) {
      const open = selectPolicyDatabaseOpener({ env: { [POLICY_DATABASE_URL_ENV]: URL_OK }, shared: vi.fn() as never, log, driver: async () => ({ createPool: () => pool, wrap: () => ({}) }) });
      const o = await open();
      await expect(o.close()).resolves.toBeUndefined();
    }
  });
});

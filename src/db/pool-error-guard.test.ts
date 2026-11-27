import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POOL_ERROR_GUARD_MARK, defaultDbPoolLog, installPoolErrorGuard, safePoolErrorCode, type DbPoolEvent } from "./pool-error-guard";

const SECRET_URL = "postgres://app_user:S3cr3t-Pa55@db.internal:5432/legal";
const pgError = (code: string, message = "terminating connection due to administrator command"): Error & { code: string } => Object.assign(new Error(message), { code });
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

function rig() {
  const pool = new EventEmitter();
  const events: DbPoolEvent[] = [];
  const result = installPoolErrorGuard(pool, (e) => events.push(e));
  const client = (): EventEmitter => {
    const c = new EventEmitter();
    pool.emit("connect", c);
    return c;
  };
  return { pool, events, result, client };
}

describe("pool-error-guard · کدِ ایمنِ خطا", () => {
  it("کدِ کوتاهِ لاتین/رقم/خط‌زیر عیناً؛ بقیه UNKNOWN", () => {
    for (const c of ["57P01", "ECONNRESET", "08006", "A_1", "a".repeat(16)]) expect(safePoolErrorCode({ code: c }), c).toBe(c);
    for (const bad of ["", "a".repeat(17), "57-P01", "کد", "a b", " 57P01", "57P01\n", SECRET_URL]) expect(safePoolErrorCode({ code: bad }), bad).toBe("UNKNOWN");
    for (const bad of [undefined, null, "57P01", 57, {}, { code: 57 }, { code: null }, [], () => 1, Symbol("x")]) expect(safePoolErrorCode(bad)).toBe("UNKNOWN");
  });
});

describe("pool-error-guard · نصب", () => {
  it("یک شنوندهٔ error و یک شنوندهٔ connect روی استخر می‌گذارد", () => {
    const { pool, result } = rig();
    expect(result).toEqual({ installed: true });
    expect(pool.listenerCount("error")).toBe(1);
    expect(pool.listenerCount("connect")).toBe(1);
  });

  it("نصبِ دوباره روی همان استخر بی‌اثر است (HMR/globalThis): شنونده‌ها دو برابر نمی‌شوند و لاگ دوبل نمی‌شود", () => {
    const { pool, events } = rig();
    const again = installPoolErrorGuard(pool, (e) => events.push(e));
    expect(again).toEqual({ installed: false });
    expect(pool.listenerCount("error")).toBe(1);
    expect(pool.listenerCount("connect")).toBe(1);
    pool.emit("error", pgError("57P01"));
    expect(events).toHaveLength(1);
  });

  it("نشانه پنهان و تغییرناپذیر است؛ استخرِ دیگر مستقل است", () => {
    const a = rig();
    const b = rig();
    expect(Object.keys(a.pool)).not.toContain(String(POOL_ERROR_GUARD_MARK));
    expect(Object.getOwnPropertyDescriptor(a.pool, POOL_ERROR_GUARD_MARK)).toMatchObject({ value: true, enumerable: false, writable: false, configurable: false });
    expect(b.result).toEqual({ installed: true });
    a.pool.emit("error", pgError("57P01"));
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(0);
  });

  it("ورودیِ نامعتبر می‌پرتابد (خطای برنامه‌نویس، نه بلعیده‌شده)", () => {
    for (const bad of [null, undefined, 42, "pool", true, {}, { on: 1 }]) expect(() => installPoolErrorGuard(bad as never), String(bad)).toThrow(TypeError);
  });

  it("کنترلِ منفی: EventEmitterِ بدونِ نگهبان با error می‌پرتابد؛ با نگهبان نه", () => {
    expect(() => new EventEmitter().emit("error", pgError("57P01"))).toThrow();
    const { pool } = rig();
    expect(() => pool.emit("error", pgError("57P01"))).not.toThrow();
  });
});

describe("pool-error-guard · اتصالِ بی‌کار (error روی استخر)", () => {
  it("رویدادِ بسته با نوعِ db.pool.error و فقط کد؛ بی‌کلیدِ اضافه", () => {
    const { pool, events } = rig();
    pool.emit("error", pgError("57P01"));
    expect(events).toEqual([{ type: "db.pool.error", code: "57P01" }]);
    expect(Object.keys(events[0] as object).sort()).toEqual(["code", "type"]);
  });

  it("message/stack/رشتهٔ اتصال هرگز در لاگ نمی‌آید", () => {
    const { pool, events, client } = rig();
    const e = Object.assign(pgError("28P01", `password authentication failed for ${SECRET_URL}`), { detail: SECRET_URL, connectionString: SECRET_URL });
    pool.emit("error", e);
    client().emit("error", Object.assign(new Error(SECRET_URL), { code: SECRET_URL }));
    const text = JSON.stringify(events);
    for (const needle of ["S3cr3t", "app_user", "db.internal", "password authentication", "stack", "message", "at "]) expect(text, needle).not.toContain(needle);
    expect(events.map((x) => x.code)).toEqual(["28P01", "UNKNOWN"]);
  });

  it("مقدارِ غیرِ شیء (رشته/null/undefined) هم فرایند را نمی‌اندازد و UNKNOWN لاگ می‌شود", () => {
    const { pool, events } = rig();
    for (const v of ["boom", null, undefined, 42]) expect(() => pool.emit("error", v)).not.toThrow();
    expect(events).toEqual(Array.from({ length: 4 }, () => ({ type: "db.pool.error", code: "UNKNOWN" })));
  });

  it("خطاهای مجزا هر کدام یک‌بار لاگ می‌شوند", () => {
    const { pool, events } = rig();
    pool.emit("error", pgError("57P01"));
    pool.emit("error", pgError("57P01"));
    pool.emit("error", pgError("08006"));
    expect(events.map((e) => e.code)).toEqual(["57P01", "57P01", "08006"]);
  });
});

describe("pool-error-guard · اتصالِ اجاره‌شده (error روی کلاینت)", () => {
  it("هر کلاینتِ تازه دقیقاً یک شنوندهٔ error می‌گیرد و خطایش فرایند را نمی‌اندازد", () => {
    const { events, client } = rig();
    const c1 = client();
    const c2 = client();
    expect(c1.listenerCount("error")).toBe(1);
    expect(c2.listenerCount("error")).toBe(1);
    expect(() => c1.emit("error", pgError("57P01"))).not.toThrow();
    expect(events).toEqual([{ type: "db.pool.error", code: "57P01" }]);
  });

  it("کلاینتِ نامعتبر در connect نادیده گرفته می‌شود (بی‌پرتاب)", () => {
    const { pool, events } = rig();
    for (const bad of [null, undefined, "x", 1, {}, { on: 1 }]) expect(() => pool.emit("connect", bad)).not.toThrow();
    expect(events).toEqual([]);
  });

  it("همان خطا که هم به کلاینت و هم به استخر می‌رسد یک‌بار لاگ می‌شود (هر دو ترتیب)", () => {
    const first = rig();
    const e1 = pgError("57P01");
    first.client().emit("error", e1);
    first.pool.emit("error", e1);
    expect(first.events).toEqual([{ type: "db.pool.error", code: "57P01" }]);

    const second = rig();
    const e2 = pgError("57P01");
    second.pool.emit("error", e2);
    second.client().emit("error", e2);
    expect(second.events).toEqual([{ type: "db.pool.error", code: "57P01" }]);
  });

  it("دو کلاینتِ مختلف با دو خطای مجزا: دو لاگ", () => {
    const { events, client } = rig();
    client().emit("error", pgError("57P01"));
    client().emit("error", pgError("57P01"));
    expect(events).toHaveLength(2);
  });
});

describe("pool-error-guard · لاگِ خراب", () => {
  afterEach(() => vi.restoreAllMocks());

  it("لاگِ پرتاب‌کننده شنوندهٔ error را نمی‌شکند", () => {
    const pool = new EventEmitter();
    installPoolErrorGuard(pool, () => {
      throw new Error("log down");
    });
    expect(() => pool.emit("error", pgError("57P01"))).not.toThrow();
    const c = new EventEmitter();
    pool.emit("connect", c);
    expect(() => c.emit("error", pgError("57P01"))).not.toThrow();
  });

  it("لاگِ ردکننده (Promise) رد‌نشدهٔ کنترل‌نشده نمی‌سازد", async () => {
    const seen: unknown[] = [];
    const onRej = (r: unknown): void => void seen.push(r);
    process.on("unhandledRejection", onRej);
    try {
      const pool = new EventEmitter();
      installPoolErrorGuard(pool, () => Promise.reject(new Error("async log down")));
      pool.emit("error", pgError("57P01"));
      await tick();
      await tick();
      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRej);
    }
  });

  it("لاگِ پیش‌فرض: یک خطِ JSON روی console.error با scope=db و فقط کد", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pool = new EventEmitter();
    installPoolErrorGuard(pool);
    pool.emit("error", pgError("57P01", `x ${SECRET_URL}`));
    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0]?.[0];
    expect(typeof line).toBe("string");
    expect(JSON.parse(line as string)).toEqual({ scope: "db", type: "db.pool.error", code: "57P01" });
    expect(line as string).not.toContain("S3cr3t");
    expect(spy.mock.calls[0]).toHaveLength(1);
  });

  it("defaultDbPoolLog مستقیم هم همان قالب را می‌دهد", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    defaultDbPoolLog({ type: "db.pool.error", code: "ECONNRESET" });
    expect(spy).toHaveBeenCalledWith('{"scope":"db","type":"db.pool.error","code":"ECONNRESET"}');
  });
});

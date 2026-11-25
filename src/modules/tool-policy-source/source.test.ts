import { describe, expect, it } from "vitest";
import { projectToolPolicy } from "@/modules/tool-policy";
import {
  adminFail,
  controlledReader,
  deepFrozen,
  fakeClock,
  flush,
  MAX_STALE,
  newSource,
  okCurrent,
  policyFor,
  REFRESH_TIMEOUT,
  scriptedReader,
} from "./test-kit";

const proj = (level: number) => {
  const p = projectToolPolicy(policyFor(level));
  if (!p.ok) throw new Error("proj");
  return p.value;
};

describe("tool-policy-source · بارِ نخست و بسته‌شدنِ شکست", () => {
  it("پیش از بارِ موفق: NOT_LOADED (هرگز پیش‌فرضِ بی‌صدا) و سلامت NOT_LOADED", () => {
    const { source } = newSource(scriptedReader([okCurrent(1)]).reader);
    const s = source.snapshot();
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.error.code).toBe("NOT_LOADED");
    expect(source.health()).toMatchObject({ state: "NOT_LOADED", version: null, ageMs: null, drift: null, consecutiveFailures: 0, lastFailure: null, lastAttemptAtMs: null, lastSuccessAtMs: null });
  });

  it("بارِ نخست ناموفق ⇒ هنوز NOT_LOADED (نه پیش‌فرض‌های کد)", async () => {
    const { source } = newSource(scriptedReader([adminFail("STORE_FAILURE")]).reader);
    const r = await source.refresh();
    expect(r).toMatchObject({ ok: false, error: { code: "READ_FAILED" } });
    const s = source.snapshot();
    expect(s.ok).toBe(false);
    expect(source.health()).toMatchObject({ state: "NOT_LOADED", consecutiveFailures: 1, lastFailure: "READ_FAILED" });
  });

  it("بارِ موفق: نگاشتِ دقیقِ projectToolPolicy، نسخه/منبع/drift، سنِ ۰ و یخ‌زدگیِ عمیق", async () => {
    const { source, clock } = newSource(scriptedReader([okCurrent(2)]).reader);
    const r = await source.refresh();
    expect(r).toEqual({ ok: true, value: { outcome: "loaded", version: 2 } });
    const s = source.snapshot();
    if (!s.ok) throw new Error("snapshot");
    expect(s.value).toMatchObject({ version: 2, source: "stored", drift: false, loadedAtMs: clock.nowMs(), confirmedAtMs: clock.nowMs(), ageMs: 0 });
    expect(s.value.projection).toEqual(proj(2));
    expect(deepFrozen(s.value)).toBe(true);
    expect(() => {
      (s.value as { version: number }).version = 9;
    }).toThrow();
    expect(() => {
      (s.value.projection.durable as { graceMs: number }).graceMs = 1;
    }).toThrow();
  });

  it("نسخهٔ ۰ (پیش‌فرض‌های کد) فقط وقتی مدیر صریحاً بگوید پذیرفته می‌شود", async () => {
    const { source } = newSource(scriptedReader([okCurrent(0)]).reader);
    expect((await source.refresh()).ok).toBe(true);
    const s = source.snapshot();
    expect(s.ok && s.value.source).toBe("defaults");
    expect(s.ok && s.value.version).toBe(0);
  });

  it("drift از مدیر عبور می‌کند و در سلامت دیده می‌شود", async () => {
    const { source } = newSource(scriptedReader([okCurrent(1, 1, { drift: true })]).reader);
    await source.refresh();
    expect(source.health().drift).toBe(true);
    const s = source.snapshot();
    expect(s.ok && s.value.drift).toBe(true);
  });
});

describe("tool-policy-source · سنِ مجاز (آخرین‌خوبِ‌شناخته با سقف)", () => {
  it("دقیقاً در سقف FRESH و یک میلی‌ثانیه بعد STALE؛ تازه‌سازیِ موفق دوباره FRESH", async () => {
    const { source, clock } = newSource(scriptedReader([okCurrent(1), okCurrent(1)]).reader);
    await source.refresh();
    clock.advance(MAX_STALE);
    const at = source.snapshot();
    expect(at.ok && at.value.ageMs).toBe(MAX_STALE);
    clock.advance(1);
    const over = source.snapshot();
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error.code).toBe("STALE");
    expect(source.health()).toMatchObject({ state: "STALE", version: 1, ageMs: MAX_STALE + 1 });
    await source.refresh();
    const again = source.snapshot();
    expect(again.ok && again.value.ageMs).toBe(0);
  });

  it("شکستِ خواندن نسخهٔ خوب را تا سقف نگه می‌دارد، سپس بسته می‌شود؛ هرگز داده‌ای از نسخهٔ کهنه نمی‌دهد", async () => {
    const { source, clock } = newSource(scriptedReader([okCurrent(1), adminFail("STORE_FAILURE")]).reader);
    await source.refresh();
    clock.advance(30_000);
    expect((await source.refresh()).ok).toBe(false);
    const mid = source.snapshot();
    expect(mid.ok && mid.value.ageMs).toBe(30_000);
    expect(mid.ok && mid.value.version).toBe(1);
    clock.advance(30_001);
    const late = source.snapshot();
    expect(late.ok).toBe(false);
    expect(JSON.stringify(late)).not.toContain("projection");
  });

  it("سن از «شروعِ» تازه‌سازیِ موفق سنجیده می‌شود، نه پایانِ آن (محافظه‌کارانه)", async () => {
    const c = controlledReader();
    const { source, clock } = newSource(c.reader);
    const p = source.refresh();
    clock.advance(4_000);
    c.pending[0]!.resolve(okCurrent(1));
    await p;
    const s = source.snapshot();
    expect(s.ok && s.value.confirmedAtMs).toBe(clock.nowMs() - 4_000);
    expect(s.ok && s.value.ageMs).toBe(4_000);
  });

  it("تأییدِ همان نسخه confirmedAt را جلو می‌برد ولی loadedAt را نه؛ نسخهٔ تازه هر دو را", async () => {
    const { source, clock } = newSource(scriptedReader([okCurrent(1), okCurrent(1), okCurrent(2)]).reader);
    const t0 = clock.nowMs();
    expect(await source.refresh()).toMatchObject({ value: { outcome: "loaded" } });
    clock.advance(1_000);
    expect(await source.refresh()).toMatchObject({ value: { outcome: "unchanged", version: 1 } });
    let s = source.snapshot();
    expect(s.ok && [s.value.loadedAtMs, s.value.confirmedAtMs]).toEqual([t0, t0 + 1_000]);
    clock.advance(1_000);
    expect(await source.refresh()).toMatchObject({ value: { outcome: "updated", version: 2 } });
    s = source.snapshot();
    expect(s.ok && [s.value.loadedAtMs, s.value.confirmedAtMs]).toEqual([t0 + 2_000, t0 + 2_000]);
    expect(s.ok && s.value.projection).toEqual(proj(2));
  });
});

describe("tool-policy-source · ناورداهای نسخه و محتوا", () => {
  it("نسخهٔ عقب‌تر رد می‌شود (VERSION_REGRESSED) و نسخهٔ نگه‌داشته‌شده می‌ماند", async () => {
    const { source } = newSource(scriptedReader([okCurrent(3), okCurrent(2)]).reader);
    await source.refresh();
    expect(await source.refresh()).toMatchObject({ ok: false, error: { code: "VERSION_REGRESSED" } });
    const s = source.snapshot();
    expect(s.ok && s.value.version).toBe(3);
    expect(source.health()).toMatchObject({ consecutiveFailures: 1, lastFailure: "VERSION_REGRESSED" });
  });

  it("بازگشت از نسخهٔ ۱ به ۰ (پیش‌فرضِ کد) هم عقب‌گرد است و رد می‌شود", async () => {
    const { source } = newSource(scriptedReader([okCurrent(1), okCurrent(0)]).reader);
    await source.refresh();
    expect(await source.refresh()).toMatchObject({ ok: false, error: { code: "VERSION_REGRESSED" } });
  });

  it("همان نسخه با سیاستِ دیگر ⇒ VERSION_CONTENT_MISMATCH؛ با منبعِ دیگر هم", async () => {
    const { source } = newSource(scriptedReader([okCurrent(2, 2), okCurrent(2, 3)]).reader);
    await source.refresh();
    expect(await source.refresh()).toMatchObject({ ok: false, error: { code: "VERSION_CONTENT_MISMATCH" } });
    const s = source.snapshot();
    expect(s.ok && s.value.projection).toEqual(proj(2));
  });

  it("پرشِ نسخه‌ها (۱ ← ۵) مجاز است؛ شکافِ نسخه مسئلهٔ ذخیره‌ساز است", async () => {
    const { source } = newSource(scriptedReader([okCurrent(1), okCurrent(5)]).reader);
    await source.refresh();
    expect(await source.refresh()).toMatchObject({ ok: true, value: { outcome: "updated", version: 5 } });
  });
});

describe("tool-policy-source · پاسخِ خواننده ورودیِ ناشناخته است", () => {
  const bad = async (resp: unknown) => {
    const { source } = newSource(scriptedReader([resp]).reader);
    const r = await source.refresh();
    return { r, s: source.snapshot() };
  };

  it("پاسخِ بدشکل ⇒ INVALID_RESPONSE", async () => {
    for (const resp of [undefined, null, 1, "x", [], {}, { ok: "yes" }, { ok: true }, { ok: true, value: null }, { ok: false }, { ok: false, error: null }, { ok: true, value: "x" }]) {
      const { r, s } = await bad(resp);
      expect(r, JSON.stringify(resp)).toMatchObject({ ok: false, error: { code: "INVALID_RESPONSE" } });
      expect(s.ok).toBe(false);
    }
  });

  it("نسخه/منبع/drift ناسازگار ⇒ INVALID_RESPONSE", async () => {
    const base = okCurrent(1);
    if (!base.ok) throw new Error("x");
    const v = base.value;
    for (const patch of [
      { version: -1 },
      { version: 1.5 },
      { version: 2 ** 60 },
      { version: "1" },
      { version: NaN },
      { source: "other" },
      { source: "defaults" },
      { drift: "no" },
      { drift: undefined },
    ]) {
      const { r } = await bad({ ok: true, value: { ...v, ...patch } });
      expect(r, JSON.stringify(patch)).toMatchObject({ ok: false, error: { code: "INVALID_RESPONSE" } });
    }
    const zero = okCurrent(0);
    if (!zero.ok) throw new Error("x");
    const { r } = await bad({ ok: true, value: { ...zero.value, source: "stored" } });
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_RESPONSE" } });
  });

  it("سیاستِ غیرِ قابلِ نگاشت (جعلی/دست‌کاری‌شده) ⇒ PROJECTION_INVALID", async () => {
    const base = okCurrent(1);
    if (!base.ok) throw new Error("x");
    for (const policy of [undefined, null, {}, { loop: {} }, [], JSON.parse('{"__proto__": {"x": 1}}'), "policy", 5]) {
      const { r, s } = await bad({ ok: true, value: { ...base.value, policy } });
      expect(r, JSON.stringify(policy)).toMatchObject({ ok: false, error: { code: "PROJECTION_INVALID" } });
      expect(s.ok).toBe(false);
    }
    const tampered = JSON.parse(JSON.stringify(base.value.policy));
    tampered.timing.maxCallMs = tampered.timing.graceMs; // رابطهٔ پول شکسته
    const { r } = await bad({ ok: true, value: { ...base.value, policy: tampered } });
    expect(r).toMatchObject({ ok: false, error: { code: "PROJECTION_INVALID" } });
  });

  it("STORED_POLICY_INVALID مدیر کدِ خودش را می‌گیرد؛ هر خطای دیگرِ مدیر READ_FAILED است", async () => {
    expect((await bad(adminFail("STORED_POLICY_INVALID"))).r).toMatchObject({ ok: false, error: { code: "STORED_POLICY_INVALID" } });
    for (const code of ["STORE_FAILURE", "INVALID_CLOCK", "WHATEVER"]) expect((await bad(adminFail(code))).r).toMatchObject({ ok: false, error: { code: "READ_FAILED" } });
    for (const code of [undefined, 1, null, {}]) expect((await bad({ ok: false, error: { code } })).r).toMatchObject({ ok: false, error: { code: "INVALID_RESPONSE" } });
  });

  it("getterِ پرتاب‌کننده روی پاسخ ⇒ INVALID_RESPONSE، نه استثنا", async () => {
    const evil = { ok: true, get value(): never { throw new Error("boom"); } };
    expect((await bad(evil)).r).toMatchObject({ ok: false, error: { code: "INVALID_RESPONSE" } });
  });

  it("پرتابِ همگام/ناهمگامِ خواننده ⇒ READ_FAILED و متنِ استثنا هرگز بیرون نمی‌آید", async () => {
    const secret = "postgres://user:SECRETPASS@db/prod";
    for (const step of [
      () => {
        throw new Error(secret);
      },
      () => Promise.reject(new Error(secret)),
    ]) {
      const { source } = newSource(scriptedReader([step]).reader);
      const r = await source.refresh();
      expect(r).toMatchObject({ ok: false, error: { code: "READ_FAILED" } });
      expect(JSON.stringify(r) + JSON.stringify(source.health()) + JSON.stringify(source.snapshot())).not.toContain("SECRETPASS");
    }
  });

  it("خطای مدیر با پیامِ سرّی بازتاب داده نمی‌شود", async () => {
    const resp = { ok: false, error: { code: "STORED_POLICY_INVALID", message: "SECRETMSG", issues: ["SECRETISSUE"], currentVersion: 3 } };
    const { r } = await bad(resp);
    expect(JSON.stringify(r)).not.toContain("SECRET");
  });
});

describe("tool-policy-source · تازه‌سازیِ هم‌زمان و تلاشِ رهاشده", () => {
  it("فراخوانی‌های هم‌زمان یک تلاش را شریک‌اند؛ پس از پایان تلاشِ تازه", async () => {
    const c = controlledReader();
    const { source } = newSource(c.reader);
    const a = source.refresh();
    const b = source.refresh();
    expect(c.calls()).toBe(1);
    expect(a).toBe(b);
    c.pending[0]!.resolve(okCurrent(1));
    expect(await a).toMatchObject({ ok: true });
    const next = source.refresh();
    expect(c.calls()).toBe(2);
    c.pending[1]!.resolve(okCurrent(1));
    expect(await next).toMatchObject({ ok: true, value: { outcome: "unchanged" } });
  });

  it("مرزِ دقیق: در refreshTimeoutMs هنوز شریک؛ یک میلی‌ثانیه بعد رها و تلاشِ نو", async () => {
    const c = controlledReader();
    const { source, clock } = newSource(c.reader);
    void source.refresh();
    clock.advance(REFRESH_TIMEOUT);
    void source.refresh();
    expect(c.calls()).toBe(1);
    clock.advance(1);
    void source.refresh();
    expect(c.calls()).toBe(2);
  });

  it("نتیجهٔ تلاشِ رهاشده دورریخته می‌شود (SUPERSEDED) و حالت را نمی‌گیرد؛ نتیجهٔ تلاشِ نو معتبر است", async () => {
    const c = controlledReader();
    const { source, clock } = newSource(c.reader);
    const first = source.refresh();
    clock.advance(REFRESH_TIMEOUT + 1);
    const second = source.refresh();
    expect(c.calls()).toBe(2);
    c.pending[1]!.resolve(okCurrent(1));
    expect(await second).toMatchObject({ ok: true, value: { outcome: "loaded", version: 1 } });
    c.pending[0]!.resolve(okCurrent(9)); // دیرهنگام و با نسخهٔ دیگر
    expect(await first).toMatchObject({ ok: false, error: { code: "SUPERSEDED" } });
    const s = source.snapshot();
    expect(s.ok && s.value.version).toBe(1);
    expect(source.health().consecutiveFailures).toBe(0); // SUPERSEDED شکستِ منبع نیست
  });

  it("رهاشده‌ای که ردّ می‌شود هم شمارندهٔ شکست را عوض نمی‌کند", async () => {
    const c = controlledReader();
    const { source, clock } = newSource(c.reader);
    const first = source.refresh();
    clock.advance(REFRESH_TIMEOUT + 1);
    void source.refresh();
    c.pending[0]!.reject(new Error("late"));
    expect(await first).toMatchObject({ error: { code: "SUPERSEDED" } });
    expect(source.health().consecutiveFailures).toBe(0);
  });

  it("خواننده‌ای که هرگز تمام نمی‌کند، تازه‌سازیِ بعدی را قفل نمی‌کند", async () => {
    const c = controlledReader();
    const { source, clock } = newSource(c.reader);
    void source.refresh(); // معلق برای همیشه
    clock.advance(REFRESH_TIMEOUT + 1);
    const next = source.refresh();
    c.pending[1]!.resolve(okCurrent(4));
    expect(await next).toMatchObject({ ok: true, value: { version: 4 } });
  });

  it("پرتابِ همگامِ خواننده تلاش را در جریان باقی نمی‌گذارد", async () => {
    let n = 0;
    const reader = {
      current: (): Promise<never> => {
        n += 1;
        throw new Error("sync");
      },
    };
    const { source } = newSource(reader as never);
    expect(await source.refresh()).toMatchObject({ error: { code: "READ_FAILED" } });
    expect(await source.refresh()).toMatchObject({ error: { code: "READ_FAILED" } });
    expect(n).toBe(2);
    expect(source.health().consecutiveFailures).toBe(2);
  });

  it("پس از موفقیت شمارندهٔ شکست و آخرین شکست پاک می‌شود", async () => {
    const { source, clock } = newSource(scriptedReader([adminFail("X"), adminFail("X"), okCurrent(1)]).reader);
    await source.refresh();
    clock.advance(10);
    await source.refresh();
    expect(source.health()).toMatchObject({ consecutiveFailures: 2, lastFailure: "READ_FAILED" });
    clock.advance(10);
    await source.refresh();
    expect(source.health()).toMatchObject({ consecutiveFailures: 0, lastFailure: null });
  });
});

describe("tool-policy-source · ساعت", () => {
  it("ساعتِ نامعتبر در refresh ⇒ INVALID_CLOCK و خواننده صدا زده نمی‌شود", async () => {
    for (const v of [NaN, Infinity, -1, 1.5, "1", null, undefined]) {
      const r = scriptedReader([okCurrent(1)]);
      const { source } = newSource(r.reader, { nowMs: () => v } as never);
      expect(await source.refresh(), String(v)).toMatchObject({ ok: false, error: { code: "INVALID_CLOCK" } });
      expect(r.state.calls).toBe(0);
    }
  });

  it("ساعتِ پرتاب‌کننده: refresh ⇒ INVALID_CLOCK؛ snapshot/health هرگز نمی‌پرتابند و بسته‌اند", async () => {
    let boom = false;
    const clock = {
      nowMs: (): number => {
        if (boom) throw new Error("clock");
        return 5_000;
      },
    };
    const { source } = newSource(scriptedReader([okCurrent(1)]).reader, clock as never);
    await source.refresh();
    boom = true;
    const s = source.snapshot();
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.error.code).toBe("CLOCK_INVALID");
    expect(source.health().state).toBe("CLOCK_INVALID");
    expect(await source.refresh()).toMatchObject({ error: { code: "INVALID_CLOCK" } });
  });

  it("ساعتِ رو به عقب ⇒ CLOCK_INVALID؛ تازه‌سازیِ موفق دوباره‌پایه‌گذاری می‌کند", async () => {
    const { source, clock } = newSource(scriptedReader([okCurrent(1), okCurrent(1)]).reader);
    await source.refresh();
    clock.set(clock.nowMs() - 1);
    const s = source.snapshot();
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.error.code).toBe("CLOCK_INVALID");
    await source.refresh();
    const healed = source.snapshot();
    expect(healed.ok && healed.value.ageMs).toBe(0);
  });
});

describe("tool-policy-source · هرگز نمی‌پرتابد و ایزوله است", () => {
  it("دو منبع حالتِ جدا دارند", async () => {
    const a = newSource(scriptedReader([okCurrent(1)]).reader);
    const b = newSource(scriptedReader([okCurrent(2)]).reader);
    await a.source.refresh();
    expect(b.source.snapshot().ok).toBe(false);
    await b.source.refresh();
    const sa = a.source.snapshot();
    const sb = b.source.snapshot();
    expect(sa.ok && sa.value.version).toBe(1);
    expect(sb.ok && sb.value.version).toBe(2);
  });

  it("هر snapshot شیءِ تازه است ولی projection مشترکِ یخ‌زده (بی‌کپیِ هر درخواست)", async () => {
    const { source, clock } = newSource(scriptedReader([okCurrent(1)]).reader);
    await source.refresh();
    const s1 = source.snapshot();
    clock.advance(5);
    const s2 = source.snapshot();
    if (!s1.ok || !s2.ok) throw new Error("x");
    expect(s1.value).not.toBe(s2.value);
    expect(s1.value.projection).toBe(s2.value.projection);
    expect(s2.value.ageMs - s1.value.ageMs).toBe(5);
  });

  it("flush کمکی: refresh پس از تمامِ ریزوظیفه‌ها همچنان درست است", async () => {
    const c = controlledReader();
    const { source } = newSource(c.reader);
    const p = source.refresh();
    await flush();
    expect(source.snapshot().ok).toBe(false);
    c.pending[0]!.resolve(okCurrent(1));
    await p;
    expect(source.snapshot().ok).toBe(true);
  });
});

describe("tool-policy-source · مرزهای باقی‌مانده", () => {
  it("ساعتِ رو به عقب تلاشِ در جریان را شریک نمی‌کند (تلاشِ نو)", () => {
    const c = controlledReader();
    const { source, clock } = newSource(c.reader);
    void source.refresh();
    clock.set(clock.nowMs() - 10);
    void source.refresh();
    expect(c.calls()).toBe(2);
  });

  it("نتیجهٔ موفقِ refresh و snapshot یخ‌زده‌اند", async () => {
    const { source } = newSource(scriptedReader([okCurrent(1)]).reader);
    const r = await source.refresh();
    if (!r.ok) throw new Error("x");
    expect(Object.isFrozen(r.value)).toBe(true);
    const bad = await newSource(scriptedReader([adminFail("X")]).reader).source.refresh();
    if (bad.ok) throw new Error("x");
    expect(Object.isFrozen(bad.error)).toBe(true);
  });
});


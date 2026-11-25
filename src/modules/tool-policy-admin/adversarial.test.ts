import { describe, expect, it } from "vitest";
import { createMemoryPolicyStore } from "./memory-store";
import { ACTOR, REASON, compat, newAdmin, prng, sampleRecord, setPolicy, unwrap, wrapStore } from "./test-kit";
import type { PolicyVersionStore } from "./types";

const A = compat(60_000, 20_000);
const codeOf = (r: { ok: boolean; error?: { code: string } }): string => (r.ok ? "OK" : r.error!.code);
const SECRET = "SECRET-DB-PASSWORD-9f2";

const hostile: [string, (...a: never[]) => unknown][] = [
  ["پرتاب همگام", () => { throw new Error(SECRET); }],
  ["رد Promise", async () => { throw new Error(SECRET); }],
  ["undefined", async () => undefined],
  ["null", async () => null],
  ["شیءِ تهی", async () => ({})],
  ["ok رشته", async () => ({ ok: "yes", value: null })],
  ["خطای بی‌کد", async () => ({ ok: false })],
  ["خطای کدِ ناشناخته", async () => ({ ok: false, error: { code: "WEIRD" } })],
  ["خطای کد غیررشته", async () => ({ ok: false, error: { code: 5 } })],
];

describe("tool-policy-admin · ذخیره‌سازِ خصمانه (مرز)", () => {
  // هر روش فقط عملیاتی را می‌شکند که از آن استفاده می‌کند؛ هر عملیات روی ذخیره‌سازِ تازه (بی‌اثرِ عملیاتِ دیگر).
  const USES: Record<string, readonly string[]> = {
    latest: ["current", "set", "rollbackTo"],
    get: ["rollbackTo"],
    append: ["set"],
    list: ["history"],
  };
  const OPS: Record<string, (a: ReturnType<typeof newAdmin>["admin"]) => Promise<{ ok: boolean; error?: { code: string } }>> = {
    current: (a) => a.current() as never,
    set: (a) => setPolicy(a, 1, A) as never,
    rollbackTo: (a) => a.rollbackTo({ expectedVersion: 1, toVersion: 1, actor: ACTOR, reason: REASON }) as never,
    history: (a) => a.history() as never,
  };
  for (const [name, fn] of hostile) {
    it(`هر روشِ ذخیره‌ساز ⇒ STORE_FAILURE فقط برای عملیاتِ وابسته، بی‌استثنا و بی‌نشتِ متن: ${name}`, async () => {
      for (const method of ["latest", "get", "append", "list"] as const) {
        for (const [op, run] of Object.entries(OPS)) {
          const inner = createMemoryPolicyStore();
          await inner.append(sampleRecord(1));
          const r = await run(newAdmin(wrapStore(inner, { [method]: fn })).admin);
          expect(JSON.stringify(r)).not.toContain(SECRET);
          const broken = (USES[method] as readonly string[]).includes(op);
          if (broken) expect(codeOf(r), `${method}/${op}`).toBe("STORE_FAILURE");
          else expect(codeOf(r), `${method}/${op}`).not.toBe("STORE_FAILURE");
        }
      }
    });
  }

  it("append با UNAVAILABLE یا INVALID ⇒ STORE_FAILURE با currentVersion", async () => {
    for (const code of ["UNAVAILABLE", "INVALID"]) {
      const store = wrapStore(createMemoryPolicyStore(), { append: async () => ({ ok: false, error: { code } }) });
      const r = await setPolicy(newAdmin(store).admin, 0, A);
      expect(!r.ok && r.error.code).toBe("STORE_FAILURE");
      expect(!r.ok && r.error.currentVersion).toBe(0);
    }
  });

  it("append با CONFLICT ولی خواندنِ بعدی شکست ⇒ VERSION_CONFLICT با currentVersion=null", async () => {
    const inner = createMemoryPolicyStore();
    let n = 0;
    const store = wrapStore(inner, {
      latest: async () => (++n === 1 ? { ok: true, value: null } : { ok: false, error: { code: "UNAVAILABLE" } }),
      append: async () => ({ ok: false, error: { code: "CONFLICT" } }),
    });
    const r = await setPolicy(newAdmin(store).admin, 0, A);
    expect(!r.ok && r.error.code).toBe("VERSION_CONFLICT");
    expect(!r.ok && r.error.currentVersion).toBeNull();
  });

  it("ذخیره‌سازی که رکوردِ خراب با ok:true پس می‌دهد هرگز پذیرفته نمی‌شود", async () => {
    const corrupt = [{ version: 1 }, { ...sampleRecord(1), actor: "bad actor" }, { ...sampleRecord(1), policy: [] }, "x", 5, []];
    for (const value of corrupt) {
      const store = wrapStore(createMemoryPolicyStore(), { latest: async () => ({ ok: true, value }) });
      expect(codeOf(await newAdmin(store).admin.current() as never)).toBe("STORE_FAILURE");
    }
  });
});

describe("tool-policy-admin · ورودیِ خصمانه", () => {
  it("getterِ متغیر: آنچه اعتبارسنجی شد دقیقاً همان است که ذخیره می‌شود (بی‌TOCTOU)", async () => {
    const { admin } = newAdmin();
    let reads = 0;
    const overrides = { timing: { ...A.timing }, model: { get timeoutMs() { reads++; return reads === 1 ? 20_000 : 99_999_999; } } };
    const r = unwrap(await setPolicy(admin, 0, overrides));
    expect(reads).toBe(1);
    expect(r.policy.model.timeoutMs).toBe(20_000);
    expect((r.overrides as { model: { timeoutMs: number } }).model.timeoutMs).toBe(20_000);
    const h = unwrap(await admin.history());
    expect((h.entries[0]!.overrides as { model: { timeoutMs: number } }).model.timeoutMs).toBe(20_000);
  });

  it("getterِ ورودیِ اصلی (expectedVersion/actor/reason) هم یک‌بار خوانده می‌شود", async () => {
    const { admin } = newAdmin();
    let n = 0;
    const input = { overrides: A, actor: ACTOR, reason: REASON, get expectedVersion() { return n++ === 0 ? 0 : 7; } };
    expect(unwrap(await admin.set(input)).version).toBe(1);
    expect(n).toBe(1);
  });

  it("Proxyهای پرتاب‌کننده (ریشه، overrides، بخش) ⇒ خطای ساختاری، نه استثنا", async () => {
    const { admin } = newAdmin();
    const boom = (): never => { throw new Error(SECRET); };
    const proxies = [new Proxy({}, { ownKeys: boom }), new Proxy({}, { get: boom, ownKeys: () => ["a"], getOwnPropertyDescriptor: () => ({ value: 1, enumerable: true, configurable: true }) })];
    for (const p of proxies) {
      const r1 = await admin.set(p);
      const r2 = await admin.set({ expectedVersion: 0, overrides: p, actor: ACTOR, reason: REASON });
      const r3 = await admin.set({ expectedVersion: 0, overrides: { timing: p }, actor: ACTOR, reason: REASON });
      for (const r of [r1, r2, r3]) {
        expect(r.ok).toBe(false);
        expect(JSON.stringify(r)).not.toContain(SECRET);
      }
    }
  });

  it("__proto__ در overrides رد می‌شود و پروتوتایپ آلوده نمی‌شود", async () => {
    const { admin } = newAdmin();
    const evil = JSON.parse('{"__proto__":{"polluted":true},"timing":{"__proto__":{"polluted":true}}}');
    expect(codeOf((await setPolicy(admin, 0, evil)) as never)).toBe("INVALID_OVERRIDES");
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("دست‌کاریِ ورودی پس از set بی‌اثر است و رکوردِ ذخیره‌شده یخ‌زده", async () => {
    const { admin } = newAdmin();
    const overrides = { timing: { ...A.timing }, model: { ...A.model } };
    unwrap(await setPolicy(admin, 0, overrides));
    overrides.timing["graceMs"] = 1;
    const h = unwrap(await admin.history());
    expect((h.entries[0]!.overrides as { timing: { graceMs: number } }).timing.graceMs).toBe(60_000);
    expect(() => { (h.entries[0] as { version: number }).version = 9; }).toThrow();
  });

  it("دلیلِ فارسی با نیم‌فاصله و علامتِ جهتِ تکی (U+200F) ذخیره می‌شود؛ کنترل‌های بازنویسیِ جهت رد", async () => {
    const { admin } = newAdmin();
    const reason = "کاهش مهلت‌ها \u200f(اندازه‌گیری تأخیر)";
    unwrap(await setPolicy(admin, 0, A, { reason }));
    expect(unwrap(await admin.history()).entries[0]!.reason).toBe(reason);
    expect(codeOf((await setPolicy(admin, 1, compat(70_000, 20_000), { reason: "a\u202eb" })) as never)).toBe("INVALID_ARGUMENT");
  });

  it("فازِ تصادفی: هیچ ورودیِ بی‌ساختاری نمی‌پرتابد و نسخه‌ای نمی‌سازد (۱۰۰۰ بذر)", async () => {
    const pool: unknown[] = [null, undefined, 0, -1, 1.5, NaN, "", "x", true, [], [1], {}, { a: 1 }, { timing: 1 }, { timing: null }, { timing: { graceMs: "1" } }, () => 1, Symbol("s"), BigInt(5), new Date(0), new Map()];
    for (let seed = 1; seed <= 1000; seed++) {
      const rnd = prng(seed);
      const pick = (): unknown => pool[Math.floor(rnd() * pool.length)];
      const { admin, store } = newAdmin();
      const results = await Promise.all([
        admin.set(pick()),
        admin.set({ expectedVersion: pick(), overrides: pick(), actor: pick(), reason: pick() }),
        admin.rollbackTo({ expectedVersion: pick(), toVersion: pick(), actor: pick(), reason: pick() }),
        admin.history(pick()),
      ]);
      for (const r of results.slice(0, 3)) expect(r.ok, `seed ${seed}`).toBe(false);
      expect(await store.latest()).toEqual({ ok: true, value: null });
    }
  });
});

describe("tool-policy-admin · ساعت و ذخیره‌سازِ آهسته", () => {
  it("ذخیره‌سازِ ناهمگام با تأخیرِ تصادفی: ناوردا (نسخه‌های بی‌شکاف) برقرار است", async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rnd = prng(seed);
      const inner = createMemoryPolicyStore();
      const delay = <T>(v: T): Promise<T> => new Promise((res) => setTimeout(() => res(v), Math.floor(rnd() * 3)));
      const slow: PolicyVersionStore = {
        latest: async () => delay(await inner.latest()),
        get: async (v) => delay(await inner.get(v)),
        append: async (r) => delay(await inner.append(r)),
        list: async (q) => delay(await inner.list(q)),
      };
      const { admin } = newAdmin(slow);
      const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => setPolicy(admin, 0, compat(60_000 + i * 5_000, 15_000), { actor: `u${i}` })));
      expect(rs.filter((r) => r.ok).length, `seed ${seed}`).toBe(1);
      const l = await inner.latest();
      expect(l.ok && l.value?.version).toBe(1);
    }
  });
});

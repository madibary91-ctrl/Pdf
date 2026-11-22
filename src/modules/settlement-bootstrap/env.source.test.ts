/**
 * settlement-bootstrap · سیاستِ env برای منبعِ خواندنِ پایش `SETTLEMENT_BACKLOG_SOURCE` (ADR-0051، م۳‑ه‑۴‑الف‑۲‑۴‑ب‑۲‑۳) — بی‌پایگاه.
 * ناوردا: پیش‌فرض (`outbox`) شکلِ نتیجه را بایت‌به‌بایت مثلِ پیش از ADR-0051 نگه می‌دارد؛ فقط `pending` نشانهٔ صریح دارد؛ مقدارِ نامعتبر یا بی‌کلیدِ روشنِ پایش شکست‌بسته است؛
 * مقدارِ env هرگز در پیام نمی‌آید. فایلِ تازه؛ `env.test.ts` و `env.backlog.test.ts` دست‌نخورده‌اند.
 */
import { describe, expect, it } from "vitest";
import { SETTLEMENT_BACKLOG_WATCH_ENV as E } from "@/modules/settlement-backlog-watch";
import { ENV_BACKLOG_SOURCE, parseBootstrapEnv } from "./env";
import { CANARY } from "./test-kit";

const BASE = { SETTLEMENT_HOST: "on", SETTLEMENT_GRACE_MS: "60000" };
const WATCH_ON = { ...BASE, SETTLEMENT_BACKLOG_WATCH: "on" };
const issuesOf = (env: Record<string, unknown>): readonly string[] => {
  const r = parseBootstrapEnv(env);
  if (r.ok) throw new Error(`انتظار شکست بود: ${JSON.stringify(r.value)}`);
  return r.issues;
};
const okValue = (env: Record<string, unknown>) => {
  const r = parseBootstrapEnv(env);
  if (!r.ok) throw new Error(`انتظار موفقیت بود: ${r.issues.join(" | ")}`);
  return r.value;
};

describe("settlement-bootstrap · env · SETTLEMENT_BACKLOG_SOURCE", () => {
  it("نامِ متغیر دقیقاً SETTLEMENT_BACKLOG_SOURCE است (و زیرِ پیشوندِ رزروشده)", () => {
    expect(ENV_BACKLOG_SOURCE).toBe("SETTLEMENT_BACKLOG_SOURCE");
    expect(ENV_BACKLOG_SOURCE.startsWith("SETTLEMENT_")).toBe(true);
  });

  it.each([[undefined], [""], ["outbox"]])("پیش‌فرض (%j) با پایشِ روشن: نتیجه بایت‌به‌بایت مثلِ بی‌کلید است و `source` ندارد", (v) => {
    const withKey = okValue({ ...WATCH_ON, [ENV_BACKLOG_SOURCE]: v });
    const without = okValue(WATCH_ON);
    expect(withKey).toEqual(without);
    expect(JSON.stringify(withKey)).toBe(JSON.stringify(without));
    if (!withKey.enabled || withKey.backlog === undefined) throw new Error("پایش باید روشن باشد");
    expect("source" in withKey.backlog).toBe(false);
  });

  it("pending با پایشِ روشن: `backlog.source === \"pending\"` و آستانه‌های env دست‌نخورده می‌مانند", () => {
    const v = okValue({ ...WATCH_ON, [ENV_BACKLOG_SOURCE]: "pending", [E.downCount]: "7", [E.degradedCount]: "2", [E.readyPolicy]: "gate_down" });
    if (!v.enabled || v.backlog === undefined) throw new Error("پایش باید روشن باشد");
    expect(v.backlog.source).toBe("pending");
    expect(v.backlog.overrides).toMatchObject({ downCount: 7, degradedCount: 2, readyPolicy: "gate_down" });
    const plain = okValue({ ...WATCH_ON, [E.downCount]: "7", [E.degradedCount]: "2", [E.readyPolicy]: "gate_down" });
    if (!plain.enabled || plain.backlog === undefined) throw new Error("پایش باید روشن باشد");
    expect(v.backlog.overrides).toEqual(plain.backlog.overrides);
  });

  it("نتیجه فریز است (source هم)", () => {
    const v = okValue({ ...WATCH_ON, [ENV_BACKLOG_SOURCE]: "pending" });
    expect(Object.isFrozen(v)).toBe(true);
    if (!v.enabled || v.backlog === undefined) throw new Error("پایش باید روشن باشد");
    expect(Object.isFrozen(v.backlog)).toBe(true);
  });

  it.each([["PENDING"], ["Pending"], [" pending"], ["pending "], ["index"], ["derived"], ["1"], ["true"], ["on"], ["off"], ["outbox,pending"], ["OUTBOX"], [5], [null], [{}], [[]], [true]])(
    "مقدارِ نامعتبرِ %j ⇒ خطا (حتی با پایشِ روشن) و نامِ متغیر در پیام",
    (bad) => {
      const issues = issuesOf({ ...WATCH_ON, [ENV_BACKLOG_SOURCE]: bad });
      expect(issues).toContain("SETTLEMENT_BACKLOG_SOURCE باید outbox یا pending باشد.");
    },
  );

  it.each([["pending"], ["outbox"]])("مقدارِ معتبرِ %j بی‌کلیدِ روشنِ پایش (نبودن/off/خالی) ⇒ خطا: اطمینانِ کاذب نمی‌دهیم", (v) => {
    for (const watch of [{}, { SETTLEMENT_BACKLOG_WATCH: "off" }, { SETTLEMENT_BACKLOG_WATCH: "" }]) {
      const issues = issuesOf({ ...BASE, ...watch, [ENV_BACKLOG_SOURCE]: v });
      expect(issues).toContain("SETTLEMENT_BACKLOG_SOURCE تنظیم شده ولی SETTLEMENT_BACKLOG_WATCH روشن (on) نیست.");
    }
  });

  it("خالی/نبودن بی‌پایش خطا نیست (رفتارِ امروز)", () => {
    expect(parseBootstrapEnv({ ...BASE, [ENV_BACKLOG_SOURCE]: "" })).toMatchObject({ ok: true });
    expect(parseBootstrapEnv(BASE)).toMatchObject({ ok: true });
  });

  it("SETTLEMENT_HOST خاموش ⇒ محیط نادیده است؛ حتی مقدارِ نامعتبرِ منبع", () => {
    for (const host of [undefined, "", "off"]) {
      expect(parseBootstrapEnv({ SETTLEMENT_HOST: host, [ENV_BACKLOG_SOURCE]: "garbage" })).toEqual({ ok: true, value: { enabled: false } });
    }
  });

  it("پایشِ نامعتبر + منبعِ معتبر: خطای خودِ پایش می‌ماند و منبع آن را پنهان نمی‌کند", () => {
    const issues = issuesOf({ ...BASE, SETTLEMENT_BACKLOG_WATCH: "ON", [ENV_BACKLOG_SOURCE]: "pending" });
    expect(issues).toContain("SETTLEMENT_BACKLOG_WATCH باید on یا off باشد.");
  });

  it("آستانهٔ نامعتبرِ پایش با منبعِ pending همچنان شکست‌بسته است (منبع آن را شُل نمی‌کند)", () => {
    const issues = issuesOf({ ...WATCH_ON, [ENV_BACKLOG_SOURCE]: "pending", [E.downCount]: "0" });
    expect(issues.length).toBeGreaterThan(0);
  });

  it("کلیدِ ناشناخته با شباهتِ SETTLEMENT_BACKLOG_SOURCE (غلطِ تایپی) همچنان رد می‌شود", () => {
    for (const k of ["SETTLEMENT_BACKLOG_SOURCES", "SETTLEMENT_BACKLOG_SOURCE_X", "SETTLEMENT_BACKLOG_SORCE"]) {
      expect(issuesOf({ ...WATCH_ON, [k]: "pending" }).join("\n")).toContain("ناشناخته");
    }
  });

  it("مقدار هرگز در پیام یا نتیجهٔ خطا نمی‌آید (قناری)", () => {
    for (const env of [{ ...WATCH_ON, [ENV_BACKLOG_SOURCE]: CANARY }, { ...BASE, [ENV_BACKLOG_SOURCE]: CANARY }, { ...BASE, [ENV_BACKLOG_SOURCE]: ["pending", CANARY] }]) {
      expect(JSON.stringify(issuesOf(env))).not.toContain(CANARY);
    }
  });

  it("خاصیتی: ۳۰۰۰ محیطِ تصادفی — هرگز نمی‌پرتابد؛ source=pending ⇔ (منبع دقیقاً pending ∧ پایش on)؛ منبعِ نامعتبر ⇒ خطا؛ بی‌پایش ⇒ بی‌backlog", () => {
    let seed = 20261125;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const sources: unknown[] = [undefined, "", "outbox", "pending", "PENDING", "x", 1, null, {}, "outbox "];
    const watches: unknown[] = [undefined, "", "off", "on", "ON", "yes"];
    let pending = 0;
    let rejectedSource = 0;
    for (let i = 0; i < 3000; i++) {
      const src = sources[Math.floor(rnd() * sources.length)];
      const watch = watches[Math.floor(rnd() * watches.length)];
      const env: Record<string, unknown> = { ...BASE, SETTLEMENT_BACKLOG_WATCH: watch, [ENV_BACKLOG_SOURCE]: src };
      const r = parseBootstrapEnv(env);
      const sourceSet = src !== undefined && src !== "";
      const sourceValid = src === "outbox" || src === "pending";
      const watchOn = watch === "on";
      if (sourceSet && !sourceValid) {
        expect(r.ok, JSON.stringify(env)).toBe(false);
        rejectedSource++;
        continue;
      }
      if (sourceSet && !watchOn) {
        expect(r.ok, JSON.stringify(env)).toBe(false);
        continue;
      }
      if (!r.ok) {
        // تنها دلیلِ ردِ باقی‌مانده: مقدارِ نامعتبرِ کلیدِ پایش
        expect(watch === "ON" || watch === "yes", JSON.stringify(env)).toBe(true);
        continue;
      }
      if (!r.value.enabled) throw new Error("باید روشن باشد");
      if (!watchOn) expect(r.value.backlog).toBeUndefined();
      else {
        expect(r.value.backlog).toBeDefined();
        const isPending = r.value.backlog?.source === "pending";
        expect(isPending, JSON.stringify(env)).toBe(src === "pending");
        if (isPending) pending++;
      }
    }
    expect(pending).toBeGreaterThan(20); // انتظار ≈ ۵۰ (۱/۱۰ × ۱/۶ × ۳۰۰۰): آزمون پوچ نیست
    expect(rejectedSource).toBeGreaterThan(500);
  });
});

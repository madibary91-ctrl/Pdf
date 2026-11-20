/**
 * نگهبانِ منبعِ سیم‌کشیِ پایشِ پسماند (ADR-0043): ناورداهایی که رفتارِ زمان‌اجرا به آن‌ها تکیه دارد و جهشی/بازبین باید قرمزشان کند.
 * فایلِ تازه؛ `purity.test.ts` دست‌نخورده‌ایِ آن (به‌جز فهرستِ importهای مجاز، با Test-Change-Approved) همچنان فرمانروای کلیِ ماژول است.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const strip = (c: string): string => c.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
const src = (n: string): string => strip(readFileSync(join(__dirname, n), "utf8"));
const bootstrap = src("bootstrap.ts");
const http = src("http.ts");
const env = src("env.ts");
const count = (code: string, re: RegExp): number => (code.match(re) ?? []).length;

describe("settlement-bootstrap · نگهبانِ منبع · پایشِ پسماند", () => {
  it("پایش فقط وقتی کلیدِ env روشن است ساخته می‌شود (یک جا) و فقط روی outboxِ PostgreSQL و ساعتِ سیستم و همان زمان‌سنجِ میزبان", () => {
    expect(count(bootstrap, /createBacklogWatch\(/g)).toBe(1);
    expect(bootstrap).toMatch(/if \(settings\.backlog !== undefined\) \{/);
    expect(bootstrap).toMatch(/createBacklogWatch\(\{ outbox: outbox\.value, clock: createSystemClock\(\), timer, \.\.\.settings\.backlog\.overrides \}\)/);
    expect(bootstrap).toMatch(/const timer = cfg\.timer === undefined \? createNodeTimer\(\) : cfg\.timer;/);
    expect(bootstrap).toMatch(/\n    timer,\n/); // همان timer به host
    expect(count(bootstrap, /createNodeTimer\(\)/g)).toBe(1);
    expect(count(bootstrap, /createSystemClock\(\)/g)).toBe(1);
  });

  it("پیش‌فرضِ شکست‌بسته: اگر ساختنِ پایش رد شد پایگاه بسته می‌شود و میزبان ساخته نمی‌شود", () => {
    const at = bootstrap.indexOf("createBacklogWatch(");
    const hostAt = bootstrap.indexOf("createSettlementHost(");
    expect(at).toBeGreaterThan(0);
    expect(hostAt).toBeGreaterThan(at);
    const between = bootstrap.slice(at, hostAt);
    expect(between).toMatch(/if \(!made\.ok\) \{\s*await closeQuietly\(opened\);\s*return failure\("BACKLOG_INVALID", made\.error\.issues\);/);
  });

  it("شروعِ پایش فقط از رویدادِ booted و توقف فقط از shutdown.started و closeResources (پیش از opened.close)", () => {
    expect(count(bootstrap, /\bwatch\.start\(\)/g)).toBe(1);
    expect(count(bootstrap, /\bwatch\.stop\(\)/g)).toBe(1);
    expect(count(bootstrap, /\bstartWatch\(\)/g)).toBe(1); // فقط همان یک فراخوانی (تعریف به شکلِ `startWatch = (`)
    expect(bootstrap).toMatch(/event\["type"\] === "booted"\) startWatch\(\)/);
    expect(bootstrap).toMatch(/event\["type"\] === "shutdown\.started"\) stopWatch\(\)/);
    expect(bootstrap).toMatch(/closeResources: \(\) => \{\s*stopWatch\(\);[^}]*return opened\.close\(\);\s*\}/);
    expect(bootstrap).toMatch(/if \(watch === null \|\| closing\) return;/); // پس از خاموشی هرگز شروع نمی‌شود
    // `closing` دفاعِ دومِ ناوردای «host پس از شروعِ خاموشی booted نمی‌دهد» است؛ رفتارِ بیرونی‌اش با host قابل‌مشاهده نیست ⇒ فقط با منبع قفل می‌شود.
    expect(bootstrap).toMatch(/const stopWatch = \(\): void => \{\s*closing = true;\s*if \(watch === null \|\| !watchStarted\) return;/);
  });

  it("پایش در ظرف ثبت و راستی‌آزمایی می‌شود؛ ثبت‌نشده ⇒ watch=null (هرگز شروع نمی‌شود)", () => {
    expect(bootstrap).toMatch(/cfg\.store\[BACKLOG_WATCH_STORE_KEY\] = watch;/);
    expect(bootstrap).toMatch(/if \(cfg\.store\[BACKLOG_WATCH_STORE_KEY\] !== watch\) throw/);
    expect(bootstrap).toMatch(/watch = null;/);
  });

  it("bootstrap به متدهای نوشتنیِ outbox دست نمی‌زند (پایش فقط‌خواندنی است و خواندن در ماژولِ watch می‌ماند)", () => {
    for (const [name, code] of [["bootstrap.ts", bootstrap], ["http.ts", http], ["env.ts", env]] as const) {
      expect(code, name).not.toMatch(/\.(begin|bury|claim|acknowledgeDead|listUnacknowledgedDead|listDead|counts|record\w*|settle\w*)\s*\(/);
    }
  });

  it("http: سیاستِ پروب فقط از projectBacklogForProbe می‌آید؛ مسدودسازی فقط ۲۰۰ را ۵۰۳ می‌کند؛ خطا ⇒ پاسخِ سادهٔ میزبان", () => {
    expect(count(http, /projectBacklogForProbe\(/g)).toBe(1);
    expect(http).toMatch(/projectBacklogForProbe\(kind, w\.view\)/);
    expect(http).toMatch(/status: p\.blocks \? 503 : r\.httpStatus/);
    expect(http).toMatch(/ok: p\.blocks \? false : r\.body\.ok/);
    expect(http).not.toMatch(/status: 200|200 as const|\? 200/); // هرگز ۵۰۳ را ۲۰۰ نمی‌کند
    expect(http).toMatch(/\} catch \{\s*return plain;\s*\}/);
    expect(http).not.toMatch(/kind === "live"/); // «live» را خودِ سیاست (ماژولِ watch) کنار می‌گذارد، نه یک شرطِ پراکنده
  });

  it("env: نام‌های آستانه از ماژولِ watch می‌آیند (نه تکرارِ دستی) و کلیدِ روشن‌کننده صریح و پیش‌فرض خاموش است", () => {
    expect(env).toMatch(/Object\.values\(SETTLEMENT_BACKLOG_WATCH_ENV\)/);
    expect(env).toMatch(/export const ENV_BACKLOG_WATCH = "SETTLEMENT_BACKLOG_WATCH";/);
    expect(env).toMatch(/watchRaw === undefined \|\| watchRaw === "" \|\| watchRaw === "off"/);
    expect(env).toMatch(/watchRaw === "on"/);
    expect(env).not.toMatch(/SETTLEMENT_BACKLOG_(INTERVAL|TIMEOUT|DEGRADED|DOWN|SAMPLE|READY)/); // نام‌ها سخت‌کد نشده
  });

  it("هیچ آستانه‌ای در bootstrap سخت‌کد نیست (پیش‌فرض‌ها فقط در ماژولِ watch)", () => {
    for (const [name, code] of [["bootstrap.ts", bootstrap], ["http.ts", http], ["env.ts", env]] as const) {
      expect(code, name).not.toMatch(/\b(degradedCount|downCount|degradedAfterMs|downAfterMs|intervalMs|timeoutMs|sampleMaxAgeMs|sampleLimit)\s*:/);
    }
  });

  it("کلیدِ ثبتِ پایش از index صادر نمی‌شود", () => {
    expect(src("index.ts")).not.toMatch(/BACKLOG_WATCH_STORE_KEY|settlement-backlog-watch/);
  });
});

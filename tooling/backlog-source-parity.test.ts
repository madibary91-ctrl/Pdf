/**
 * همارزیِ `SETTLEMENT_BACKLOG_SOURCE` میانِ bootstrap و CLIِ نمایه (ADR-0051، بی‌پایگاه). تکمیلِ `settlement-pending-migrate-parity.test.ts` (دست‌نخورده، جز فهرستِ نام‌ها):
 * هر envی که bootstrap با منبعِ `pending` می‌پذیرد، همان CLIِ نصبِ نمایه هم می‌پذیرد — وگرنه اپراتور برای نصبِ نمایه‌ای که برنامه به آن تکیه دارد
 * مجبور به ویرایشِ env می‌شد. و ناهمخوانی در دو جهتِ مقدارِ ناشناخته (فقط bootstrap رد می‌کند؛ CLI نادیده می‌گیرد) آگاهانه ثبت شده است.
 */
import { describe, expect, it } from "vitest";
import { MODULES } from "@/modules/registry";
import { parseBootstrapEnv } from "@/modules/settlement-bootstrap";
import { parsePendingMigrateArgs } from "@/modules/settlement-pending-migrate/args";

const ON = { SETTLEMENT_HOST: "on", SETTLEMENT_GRACE_MS: "60000", SETTLEMENT_BACKLOG_WATCH: "on" };

describe("tooling · SETTLEMENT_BACKLOG_SOURCE: bootstrap ⊆ CLIِ نمایه", () => {
  it("envِ pending که bootstrap می‌پذیرد، CLI را برای هر چهار دستور رد نمی‌کند", () => {
    const env = { DATABASE_URL: "x", ...ON, SETTLEMENT_BACKLOG_SOURCE: "pending", SETTLEMENT_OUTBOX_SCHEMA: "out_a" };
    expect(parseBootstrapEnv(env)).toMatchObject({ ok: true, value: { enabled: true, backlog: { source: "pending" } } });
    for (const argv of [["status"], ["up"], ["verify"], ["down", "--yes"]]) expect(parsePendingMigrateArgs(argv, env), argv.join(" ")).toMatchObject({ ok: true });
    expect(parsePendingMigrateArgs(["up"], env)).toMatchObject({ ok: true, value: { schema: "out_a" } });
  });

  it("خاصیتی: ۳۰۰۰ محیط — پذیرفتهٔ bootstrap هرگز ردِ CLI نیست؛ شِمای دو سو برابر", () => {
    let seed = 20261125;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const srcVals: unknown[] = [undefined, "", "outbox", "pending", "x", 5];
    const schemaVals: unknown[] = [undefined, "", "out_a", "public", "A-B"];
    let bothOk = 0;
    let pendingOk = 0;
    for (let i = 0; i < 3000; i++) {
      const env: Record<string, unknown> = { DATABASE_URL: "x", ...ON };
      env["SETTLEMENT_BACKLOG_SOURCE"] = srcVals[Math.floor(rnd() * srcVals.length)];
      env["SETTLEMENT_OUTBOX_SCHEMA"] = schemaVals[Math.floor(rnd() * schemaVals.length)];
      const b = parseBootstrapEnv(env);
      const m = parsePendingMigrateArgs(["status"], env);
      if (b.ok && b.value.enabled) {
        if (!(m.ok && m.value.command !== "help")) expect.unreachable(`CLI رد کرد ولی bootstrap پذیرفت: ${JSON.stringify(env)}`);
        expect(m.value.schema).toBe(b.value.settlementSchema);
        bothOk++;
        if (b.value.backlog?.source === "pending") pendingOk++;
      }
    }
    expect(bothOk).toBeGreaterThan(300);
    expect(pendingOk).toBeGreaterThan(50);
  });

  it("مقدارِ ناشناخته: bootstrap رد می‌کند و CLI نادیده می‌گیرد (آگاهانه؛ مقدار در CLI معنا ندارد)", () => {
    const env = { DATABASE_URL: "x", ...ON, SETTLEMENT_BACKLOG_SOURCE: "index" };
    expect(parseBootstrapEnv(env)).toMatchObject({ ok: false });
    expect(parsePendingMigrateArgs(["status"], env)).toMatchObject({ ok: true });
  });

  it("registry: bootstrap به settlement-pending وابسته اعلام شده (لایهٔ پایین‌تر) و settlement-pending به bootstrap نه؛ CLIِ نمایه به bootstrap وابسته نیست", () => {
    const get = (n: string) => MODULES.find((m) => m.name === n);
    const b = get("settlement-bootstrap");
    const p = get("settlement-pending");
    expect(b?.dependsOn).toContain("settlement-pending");
    expect(p).toBeDefined();
    expect((p?.layer ?? 99) < (b?.layer ?? 0)).toBe(true);
    expect(p?.dependsOn).not.toContain("settlement-bootstrap");
    expect(get("settlement-pending-migrate")?.dependsOn).not.toContain("settlement-bootstrap");
  });
});

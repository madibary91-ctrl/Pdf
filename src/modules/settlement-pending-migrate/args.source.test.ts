/**
 * settlement-pending-migrate · `SETTLEMENT_BACKLOG_SOURCE` در ورودیِ CLI (ADR-0051): همان فایلِ envِ برنامه (که `pending` را انتخاب می‌کند) باید با همین CLI نصب/راستی‌آزمایی شود.
 * مقدارش اینجا نادیده است (صاحبش bootstrap است)؛ غلطِ تایپی همچنان رد می‌شود؛ مقدار هرگز پژواک نمی‌شود. فایلِ تازه؛ `args.test.ts` دست‌نخورده.
 */
import { describe, expect, it } from "vitest";
import { KNOWN_SETTLEMENT_ENV, parsePendingMigrateArgs } from "./args";

const ENV = { DATABASE_URL: "x" };
const CANARY = "LEAK-CANARY-pending-source-77aa";

describe("settlement-pending-migrate · SETTLEMENT_BACKLOG_SOURCE", () => {
  it("جزوِ نام‌های شناخته‌شده است", () => {
    expect(KNOWN_SETTLEMENT_ENV).toContain("SETTLEMENT_BACKLOG_SOURCE");
  });

  it.each([["status"], ["up"], ["verify"]])("دستورِ %s با envِ برنامه (SOURCE=pending|outbox) پذیرفته می‌شود", (command) => {
    for (const v of ["pending", "outbox", ""]) {
      expect(parsePendingMigrateArgs([command], { ...ENV, SETTLEMENT_BACKLOG_SOURCE: v }), v).toMatchObject({ ok: true, value: { command } });
    }
    expect(parsePendingMigrateArgs(["down", "--yes"], { ...ENV, SETTLEMENT_BACKLOG_SOURCE: "pending" })).toMatchObject({ ok: true, value: { command: "down" } });
  });

  it("مقدارِ منبع بر نتیجه اثری ندارد (شِما و مهلت همان‌اند)", () => {
    const a = parsePendingMigrateArgs(["up"], { ...ENV, SETTLEMENT_OUTBOX_SCHEMA: "out_x" });
    const b = parsePendingMigrateArgs(["up"], { ...ENV, SETTLEMENT_OUTBOX_SCHEMA: "out_x", SETTLEMENT_BACKLOG_SOURCE: "pending" });
    expect(b).toEqual(a);
  });

  it("غلطِ تایپی همچنان رد می‌شود و مقدار پژواک نمی‌شود", () => {
    for (const k of ["SETTLEMENT_BACKLOG_SOURCES", "SETTLEMENT_BACKLOG_SORCE", "SETTLEMENT_BACKLOG_SOURCE_X"]) {
      const r = parsePendingMigrateArgs(["status"], { ...ENV, [k]: CANARY });
      expect(r.ok, k).toBe(false);
      expect(JSON.stringify(r)).not.toContain(CANARY);
    }
    expect(JSON.stringify(parsePendingMigrateArgs(["status"], { ...ENV, SETTLEMENT_BACKLOG_SOURCE: CANARY }))).not.toContain(CANARY);
  });
});

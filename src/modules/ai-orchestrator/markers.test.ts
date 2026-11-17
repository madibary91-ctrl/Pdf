import { describe, expect, it } from "vitest";
import { idsOf, REDACTION_MARK, rewriteMarkers, scanMarkers } from "./markers";

const ids = (t: string) => scanMarkers(t).map((m) => m.ids);

describe("ai-orchestrator · scanMarkers", () => {
  it("نشانهٔ ساده، گروهی، تکراری و جداگانه", () => {
    expect(ids("الف [S1] ب")).toEqual([["S1"]]);
    expect(ids("[S1, S2]")).toEqual([["S1", "S2"]]);
    expect(ids("[S1،S2 ،  S3]")).toEqual([["S1", "S2", "S3"]]);
    expect(ids("[S1][S2]")).toEqual([["S1"], ["S2"]]);
    expect(ids("[S1, S1]")).toEqual([["S1"]]);
    expect(ids("[S10] [S999]")).toEqual([["S10"], ["S999"]]);
    expect(ids("بدون نشانه S1 (S2) [x] [1]")).toEqual([]);
  });

  it("مخدوش: هر چیز نشانه‌مانندِ ناقض دستور", () => {
    for (const bad of ["[S۱]", "[S١]", "[s1]", "[S01]", "[S0]", "[S1 S2]", "[ S1 ]", "[S1;S2]", "[S1, ]", "[S1, x]", "[S1000]", "[S 1]", "[S1-2]", "[S1 و S2]"]) {
      const m = scanMarkers(`الف ${bad} ب`);
      expect(m, bad).toHaveLength(1);
      expect(m[0]?.ids, bad).toBeNull();
    }
  });

  it("بازه‌ها دقیق‌اند و raw همان متن است", () => {
    const text = "الف [S1] ب [S۲] ج";
    const ms = scanMarkers(text);
    expect(ms.map((m) => [m.start, m.end, m.raw])).toEqual([[4, 8, "[S1]"], [11, 15, "[S۲]"]]);
    for (const m of ms) expect(text.slice(m.start, m.end)).toBe(m.raw);
  });

  it("نشانهٔ بسیار بلند یا چندخطی نشانه حساب نمی‌شود (سقف ۴۰ نویسه و بی‌خط‌جدید)", () => {
    expect(scanMarkers("[S1" + "x".repeat(60) + "]")).toEqual([]);
    expect(scanMarkers("[S1\nS2]")).toEqual([]);
  });

  it("idsOf یکتا و به ترتیب نخستین ظهور؛ مخدوش‌ها نادیده", () => {
    expect(idsOf(scanMarkers("[S2] [S۱] [S1, S2] [S3]"))).toEqual(["S2", "S1", "S3"]);
    expect(idsOf([])).toEqual([]);
  });
});

describe("ai-orchestrator · rewriteMarkers", () => {
  const rw = (t: string, acc: string[]) => rewriteMarkers(t, scanMarkers(t), new Set(acc));

  it("پذیرفته‌ها بی‌تغییر؛ ناپذیرفته‌ها و مخدوش‌ها ⇒ علامت", () => {
    expect(rw("الف [S1] ب [S2] ج", ["S1"])).toBe(`الف [S1] ب ${REDACTION_MARK} ج`);
    expect(rw("[S۱] x", ["S1"])).toBe(`${REDACTION_MARK} x`);
    expect(rw("x", [])).toBe("x");
    expect(rw("", ["S1"])).toBe("");
  });

  it("گروه: فقط پذیرفته‌ها می‌مانند؛ گروهِ کاملاً پذیرفته با فرمت اصلی‌اش دست‌نخورده", () => {
    expect(rw("[S1, S2, S3]", ["S1", "S3"])).toBe("[S1, S3]");
    expect(rw("[S1،S2]", ["S1", "S2"])).toBe("[S1،S2]");
    expect(rw("[S1, S2]", [])).toBe(REDACTION_MARK);
    expect(rw("[S1,S2]", ["S2"])).toBe("[S2]");
  });

  it("علامت جایگزین سفارشی و بی‌تغییر ماندن متن پیرامون", () => {
    expect(rewriteMarkers("a [S9] b", scanMarkers("a [S9] b"), new Set(), "###")).toBe("a ### b");
  });

  it("علامت خودش نشانه/ارجاع نیست و idempotent است", () => {
    expect(scanMarkers(REDACTION_MARK)).toEqual([]);
    expect(REDACTION_MARK).not.toMatch(/ماده|\[S/);
    // رقم ندارد؛ پس ممیزی عدد (numbers.ts) نیازی به کنار گذاشتنش ندارد
    expect(REDACTION_MARK).not.toMatch(/[0-9\u06F0-\u06F9\u0660-\u0669]/);
    const t = "x [S1] [S2] [S۳] [S1, S2]";
    const once = rw(t, ["S1"]);
    expect(rw(once, ["S1"])).toBe(once);
  });
});

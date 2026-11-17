/** خواننده‌های ردیف (بدون پایگاه): ردیفِ ناهمخوان با مدل = CorruptRowError، نه مقدار پیش‌فرض و نه حدس. */
import { describe, expect, it } from "vitest";
import { CorruptRowError } from "./errors";
import { int, isoDate, isoDateOrNull, readProvenance, readSubpart, readVersionRow, str, strOrNull } from "./rows";

const throwsCorrupt = (fn: () => unknown) => expect(fn).toThrow(CorruptRowError);

const baseProv = {
  source_name: "منبع",
  source_url: null,
  source_kind: "secondary",
  retrieved_on: "2025-01-10",
  review_status: "pending-legal-review",
  reviewed_by: null,
  reviewed_on: null,
};

describe("rows: نگهبان‌های نوع ستون", () => {
  it("str: فقط رشته", () => {
    expect(str({ a: "x" }, "a")).toBe("x");
    expect(str({ a: "" }, "a")).toBe("");
    for (const bad of [null, undefined, 1, true, {}, [], new Date()]) throwsCorrupt(() => str({ a: bad }, "a"));
    throwsCorrupt(() => str({}, "missing"));
  });
  it("strOrNull: رشته یا null، نه undefined", () => {
    expect(strOrNull({ a: null }, "a")).toBeNull();
    expect(strOrNull({ a: "x" }, "a")).toBe("x");
    for (const bad of [undefined, 1, {}]) throwsCorrupt(() => strOrNull({ a: bad }, "a"));
  });
  it("int: فقط عدد صحیح (نه رشته، نه اعشاری، نه NaN، نه bigint)", () => {
    expect(int({ a: 0 }, "a")).toBe(0);
    expect(int({ a: -5 }, "a")).toBe(-5);
    for (const bad of ["1", 1.5, NaN, Infinity, null, undefined, BigInt(1)]) throwsCorrupt(() => int({ a: bad }, "a"));
  });
  it("isoDate / isoDateOrNull: فقط تاریخ میلادی معتبر ISO", () => {
    expect(isoDate({ a: "2024-02-29" }, "a")).toBe("2024-02-29");
    expect(isoDateOrNull({ a: null }, "a")).toBeNull();
    for (const bad of ["2023-02-29", "1403-01-01", "2024-1-1", "", null, undefined, new Date("2020-01-01")]) throwsCorrupt(() => isoDate({ a: bad }, "a"));
    for (const bad of ["x", undefined, 5]) throwsCorrupt(() => isoDateOrNull({ a: bad }, "a"));
  });
});

describe("rows: readProvenance", () => {
  it("تأییدنشده و تأییدشدهٔ سازگار", () => {
    expect(readProvenance(baseProv)).toEqual({
      sourceName: "منبع",
      sourceUrl: null,
      sourceKind: "secondary",
      retrievedOn: "2025-01-10",
      review: { status: "pending-legal-review", reviewedBy: null, reviewedOn: null },
    });
    const v = readProvenance({ ...baseProv, source_kind: "official", review_status: "legally-verified", reviewed_by: "علی", reviewed_on: "2025-02-01" });
    expect(v.review).toEqual({ status: "legally-verified", reviewedBy: "علی", reviewedOn: "2025-02-01" });
  });
  it("وضعیت بازبینی ناسازگار هرگز verified نمی‌شود", () => {
    throwsCorrupt(() => readProvenance({ ...baseProv, review_status: "legally-verified" }));
    throwsCorrupt(() => readProvenance({ ...baseProv, review_status: "legally-verified", reviewed_by: "علی" }));
    throwsCorrupt(() => readProvenance({ ...baseProv, review_status: "legally-verified", reviewed_on: "2025-02-01" }));
    throwsCorrupt(() => readProvenance({ ...baseProv, reviewed_by: "علی" }));
    throwsCorrupt(() => readProvenance({ ...baseProv, reviewed_on: "2025-02-01" }));
  });
  it("مقدار شمارشی ناشناخته", () => {
    throwsCorrupt(() => readProvenance({ ...baseProv, review_status: "approved" }));
    throwsCorrupt(() => readProvenance({ ...baseProv, source_kind: "wiki" }));
    throwsCorrupt(() => readProvenance({ ...baseProv, retrieved_on: "1403-01-01" }));
  });
});

describe("rows: readSubpart و readVersionRow", () => {
  it("تبصره/بند", () => {
    expect(readSubpart({ kind: "clause", label: "الف", body: "متن" })).toEqual({ kind: "clause", label: "الف", text: "متن" });
    throwsCorrupt(() => readSubpart({ kind: "item", label: "1", body: "x" }));
    throwsCorrupt(() => readSubpart({ kind: "note", label: 1, body: "x" }));
  });
  it("نسخه: فیلدها و تبصره‌ها منتقل می‌شوند؛ تاریخ نامعتبر رد", () => {
    const subs = [{ kind: "note" as const, label: "1", text: "t" }];
    expect(readVersionRow({ ...baseProv, valid_from: "2000-01-01", valid_to: null, body: "متن" }, subs)).toEqual({
      validFrom: "2000-01-01",
      validTo: null,
      text: "متن",
      subparts: subs,
      provenance: readProvenance(baseProv),
    });
    throwsCorrupt(() => readVersionRow({ ...baseProv, valid_from: "x", valid_to: null, body: "m" }, []));
    throwsCorrupt(() => readVersionRow({ ...baseProv, valid_from: "2000-01-01", valid_to: "bad", body: "m" }, []));
    throwsCorrupt(() => readVersionRow({ ...baseProv, valid_from: "2000-01-01", valid_to: null, body: 5 }, []));
  });
});

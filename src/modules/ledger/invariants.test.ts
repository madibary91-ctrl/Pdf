import { describe, expect, it } from "vitest";
import { checkInvariants, foldJournal } from "./index";
import type { JournalEntry } from "./index";
import { UNIT, fundedState, mustState, run } from "./test-kit";

function scenario() {
  const entries: JournalEntry[] = [];
  let s = fundedState(0);
  const step = (kind: string, f: Record<string, unknown>, at = 10_000) => {
    const o = run(s, kind as "grant", f, at);
    if (!o.ok) throw new Error(o.error.code);
    entries.push(...o.entries);
    s = o.state;
  };
  step("grant", { grantId: "g1", unit: UNIT, amount: 1000, source: "purchase" });
  step("reserve", { reservationId: "r1", unit: UNIT, amount: 500, ttlMs: 1_000 });
  step("reserve", { reservationId: "r2", unit: UNIT, amount: 100, ttlMs: 9_000 });
  step("charge", { reservationId: "r1", attemptId: "x1", unit: UNIT, amount: 120 });
  step("charge", { reservationId: "r2", attemptId: "x1", unit: UNIT, amount: 130 }); // کسری ۳۰
  step("refund", { refundId: "f1", reservationId: "r1", attemptId: "x1", unit: UNIT, amount: 20 });
  step("close", { reservationId: "r2", remainder: "forfeit" });
  step("grant", { grantId: "g2", unit: UNIT, amount: 1, source: "promo" }, 11_000); // انقضای r1
  return { state: s, entries };
}

describe("ledger/invariants · checkInvariants", () => {
  it("حالتِ سازگار تهی است", () => {
    expect(checkInvariants(scenario().state)).toEqual([]);
    expect(checkInvariants(fundedState(0))).toEqual([]);
  });
  const mutations: [string, (s: ReturnType<typeof scenario>["state"]) => void, RegExp][] = [
    ["available منفی", (s) => { s.available = -1; }, /available/],
    ["available اعشاری", (s) => { s.available = 1.5; }, /available/],
    ["held نامعتبر", (s) => { s.held = Number.NaN; }, /held/],
    ["totals نامعتبر", (s) => { s.totals.granted = -5; }, /totals\.granted/],
    ["held ≠ Σ", (s) => { s.held += 1; }, /held ≠/],
    ["بقا شکسته (اعتبار ساخته‌شده)", (s) => { s.available += 1; }, /بقا/],
    ["بقا شکسته (اعتبار گم‌شده)", (s) => { s.totals.forfeited -= 1; }, /بقا|forfeited/],
    ["charged ≠ Σ رزروها", (s) => { s.totals.charged += 1; }, /totals\.charged/],
    ["refunded ≠ Σ تلاش‌ها", (s) => { s.totals.refunded += 1; }, /totals\.refunded/],
    ["shortfall ≠ Σ تلاش‌ها", (s) => { s.totals.shortfall += 1; }, /totals\.shortfall/],
    ["رزرو amount ناهمخوان", (s) => { s.reservations["r1"]!.amount += 1; }, /amount ≠/],
    ["رزرو charged ≠ Σ تلاش", (s) => { s.reservations["r1"]!.charged += 1; }, /charged ≠ Σ تلاش/],
    ["تلاش: مصرف + کسری ≠ درخواست", (s) => { s.reservations["r2"]!.attempts["x1"]!.requested += 1; }, /کسری ≠ درخواست/],
    ["بازگشت بیش از مصرف", (s) => { s.reservations["r1"]!.attempts["x1"]!.refunded = 999; }, /بازگشت بیش از مصرف/],
    ["رزرو بسته با remaining", (s) => { s.reservations["r1"]!.remaining = 1; }, /بستهٔ r1/],
    ["رزرو بسته بی‌closedBy", (s) => { s.reservations["r1"]!.closedBy = null; }, /بستهٔ r1/],
    ["رزرو باز با نشانهٔ بستن", (s) => { s.reservations["r1"]!.status = "open"; s.reservations["r1"]!.remaining = 0; }, /رزرو باز r1/],
  ];
  it.each(mutations)("تخطی تشخیص داده می‌شود: %s", (_l, mutate, re) => {
    const { state } = scenario();
    mutate(state);
    const v = checkInvariants(state);
    expect(v.length).toBeGreaterThan(0);
    expect(v.join("|")).toMatch(re);
  });
});

describe("ledger/invariants · foldJournal", () => {
  it("بازپخش از صفر دقیقاً حالت را می‌سازد", () => {
    const { state, entries } = scenario();
    const f = foldJournal(entries);
    expect(f.ok).toBe(true);
    if (f.ok) {
      expect(f.value).toEqual({ available: state.available, held: state.held, totals: state.totals, seq: state.seq });
      expect(f.value.totals.shortfall).toBe(30);
    }
  });
  it("ژورنال تهی = صفر", () => {
    expect(foldJournal([])).toEqual({ ok: true, value: { available: 0, held: 0, totals: { granted: 0, charged: 0, forfeited: 0, refunded: 0, shortfall: 0 }, seq: 0 } });
  });
  it("هر دستکاریِ ژورنال تشخیص داده می‌شود (seq، مبلغ، حذف، جابه‌جایی، availableAfter)", () => {
    const { entries } = scenario();
    const tamper: [string, JournalEntry[]][] = [
      ["حذف ورودی میانی", entries.filter((_, i) => i !== 2)],
      ["جابه‌جایی", [entries[1]!, entries[0]!, ...entries.slice(2)]],
      ["مبلغ دستکاری", entries.map((e, i) => (i === 0 ? { ...e, amount: e.amount + 1 } : e))],
      ["availableAfter دستکاری", entries.map((e, i) => (i === 3 ? { ...e, availableAfter: e.availableAfter + 1 } : e))],
      ["heldAfter دستکاری", entries.map((e, i) => (i === 3 ? { ...e, heldAfter: e.heldAfter + 1 } : e))],
      ["فقط seq دستکاری (بقیه سازگار)", entries.map((e, i) => (i === 2 ? { ...e, seq: 99 } : e))],
      ["مبلغ منفی", entries.map((e, i) => (i === 0 ? { ...e, amount: -1 } : e))],
      ["کسری نامعتبر", entries.map((e, i) => (i === 4 ? { ...e, shortfall: 0.5 } : e))],
    ];
    for (const [label, t] of tamper) expect(foldJournal(t).ok, label).toBe(false);
  });
  it("موجودی منفی در بازپخش رد می‌شود حتی اگر availableAfter هم‌خوان ساخته شود", () => {
    const e: JournalEntry = { seq: 1, atMs: 1, type: "reserve", amount: 5, shortfall: 0, reservationId: "r", attemptId: null, refId: null, availableAfter: -5, heldAfter: 5 };
    const f = foldJournal([e]);
    expect(f.ok).toBe(false);
    expect(!f.ok && f.reason).toContain("منفی");
  });
  it("حالت دست‌ساز بدون ژورنال هم با fundedState سازگار است", () => {
    const s = mustState(run(fundedState(5), "reserve", { reservationId: "r", unit: UNIT, amount: 5, ttlMs: 1_000 }, 5));
    expect(checkInvariants(s)).toEqual([]);
  });
});

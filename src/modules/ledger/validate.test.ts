import { describe, expect, it } from "vitest";
import { ID_RE, LIMITS, UNIT_RE, parseCommand, parseKey } from "./index";

const base = { tenantId: "t1", accountId: "a1" };
const good = {
  open: { ...base, unit: "IRR_MICROS" },
  grant: { ...base, grantId: "g1", unit: "MSG", amount: 5, source: "promo" },
  reserve: { ...base, reservationId: "r1", unit: "MSG", amount: 5, ttlMs: 5000 },
  charge: { ...base, reservationId: "r1", attemptId: "x1", unit: "MSG", amount: 0 },
  close: { ...base, reservationId: "r1", remainder: "forfeit" },
  refund: { ...base, refundId: "f1", reservationId: "r1", attemptId: "x1", unit: "MSG", amount: 1 },
} as const;
const kinds = Object.keys(good) as (keyof typeof good)[];

describe("ledger · parseCommand · ورودی معتبر", () => {
  it.each(kinds)("%s: معتبر پذیرفته و با kind منجمد می‌شود", (k) => {
    const r = parseCommand(k, good[k]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ kind: k, ...good[k] });
      expect(Object.isFrozen(r.value)).toBe(true);
    }
  });
  it("charge با مبلغ صفر مجاز است ولی grant/reserve/refund با صفر نه", () => {
    expect(parseCommand("charge", { ...good.charge, amount: 0 }).ok).toBe(true);
    for (const k of ["grant", "reserve", "refund"] as const) expect(parseCommand(k, { ...good[k], amount: 0 }).ok, k).toBe(false);
  });
  it("-0 به 0 نرمال می‌شود (بی‌اثر روی JSON/اثر انگشت)", () => {
    const r = parseCommand("charge", { ...good.charge, amount: -0 });
    expect(r.ok && Object.is(r.value.kind === "charge" ? r.value.amount : 1, 0)).toBe(true);
  });
  it("بیشینهٔ مبلغ ایمن پذیرفته و یک بیشتر رد می‌شود", () => {
    expect(parseCommand("grant", { ...good.grant, amount: Number.MAX_SAFE_INTEGER }).ok).toBe(true);
    expect(parseCommand("grant", { ...good.grant, amount: Number.MAX_SAFE_INTEGER + 1 }).ok).toBe(false);
  });
  it("مرز ttl: ۱۰۰۰ و ۸۶٬۴۰۰٬۰۰۰ مجاز؛ یکی کمتر/بیشتر رد", () => {
    for (const ttlMs of [LIMITS.MIN_TTL_MS, LIMITS.MAX_TTL_MS]) expect(parseCommand("reserve", { ...good.reserve, ttlMs }).ok).toBe(true);
    for (const ttlMs of [LIMITS.MIN_TTL_MS - 1, LIMITS.MAX_TTL_MS + 1, 0, -1, 1500.5]) expect(parseCommand("reserve", { ...good.reserve, ttlMs }).ok, String(ttlMs)).toBe(false);
  });
});

describe("ledger · parseCommand · ورودی نامعتبر (بی‌پرتاب، پیام ثابت)", () => {
  const badAmounts = [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, "5", null, undefined, BigInt(1), {}, [], true];
  it.each(badAmounts.map((v) => [String(v), v] as const))("مبلغ نامعتبر %s", (_l, v) => {
    for (const k of ["grant", "reserve", "charge", "refund"] as const) {
      const r = parseCommand(k, { ...good[k], amount: v });
      expect(r.ok, k).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
    }
  });
  const badIds = ["", " ", "a b", "_x", "-x", ".x", "__proto__", "a/b", "a#b", "a@b", "a,b", "a+b", "a\\b", "a;b", "a%20b", "a\nb", "a\u0000b", "x".repeat(129), "آ", 5, null, undefined, {}, ["a"]];
  it.each(badIds.map((v) => [JSON.stringify(v) ?? String(v), v] as const))("شناسهٔ نامعتبر %s", (_l, v) => {
    for (const f of ["tenantId", "accountId"] as const) expect(parseCommand("open", { ...good.open, [f]: v }).ok, f).toBe(false);
    expect(parseCommand("charge", { ...good.charge, attemptId: v }).ok).toBe(false);
    expect(parseKey({ tenantId: v, accountId: "a" }).ok).toBe(false);
  });
  it("شناسهٔ ۱۲۸ نویسه مجاز و شناسه‌هایی مثل constructor عادی‌اند", () => {
    expect(ID_RE.test("a".repeat(128))).toBe(true);
    for (const id of ["constructor", "toString", "hasOwnProperty", "valueOf", "A.b:c_d-e"]) expect(ID_RE.test(id), id).toBe(true);
  });
  it.each(["irr", "iRR", "iRR_MICROS", "Irr", "I", "1RR", "_RR", "IRR-X", "X".repeat(17), "", " IRR", "IRR ", 5, null])("واحد نامعتبر %s", (u) => {
    expect(parseCommand("open", { ...good.open, unit: u }).ok).toBe(false);
  });
  it("الگوی واحد: دو تا شانزده نویسهٔ بزرگ/رقم/زیرخط، شروع با حرف", () => {
    for (const u of ["IR", "IRR", "MSG", "IRR_MICROS", "A" + "B".repeat(15)]) expect(UNIT_RE.test(u), u).toBe(true);
  });
  it("منبع grant و حالت close فقط از فهرست بسته", () => {
    expect(parseCommand("grant", { ...good.grant, source: "gift" }).ok).toBe(false);
    expect(parseCommand("grant", { ...good.grant, source: undefined }).ok).toBe(false);
    for (const remainder of ["", "RELEASE", "keep", undefined, null, true]) expect(parseCommand("close", { ...good.close, remainder }).ok, String(remainder)).toBe(false);
  });
  it("کلید ناشناخته و فیلد نبود ⇒ رد؛ شیء غیرساده ⇒ رد", () => {
    for (const k of kinds) {
      expect(parseCommand(k, { ...good[k], extra: 1 }).ok, `${k} extra`).toBe(false);
      expect(parseCommand(k, { ...good[k], kind: "grant" }).ok, `${k} kind`).toBe(false);
      for (const f of Object.keys(good[k])) {
        const copy: Record<string, unknown> = { ...good[k] };
        delete copy[f];
        expect(parseCommand(k, copy).ok, `${k} بی ${f}`).toBe(false);
      }
      for (const raw of [null, undefined, 5, "x", [], [good[k]], new Map(), new (class X {})()]) expect(parseCommand(k, raw).ok, `${k} ${String(raw)}`).toBe(false);
    }
  });
  it("کلیدِ ناشناخته فقط اگر کوتاه و بی‌خطر باشد در پیام می‌آید", () => {
    const a = parseCommand("open", { ...good.open, bonus: 1 });
    const b = parseCommand("open", { ...good.open, "x\ny<script>": 1 });
    expect(!a.ok && a.error.message).toContain("bonus");
    expect(!b.ok && b.error.message).not.toContain("script");
  });
  it("پیام خطا هرگز مقدار ورودی را پژواک نمی‌دهد", () => {
    const r = parseCommand("grant", { ...good.grant, grantId: "SECRET value!" });
    expect(!r.ok && r.error.message).not.toContain("SECRET");
  });
  it("getter و Proxy پرتاب‌کننده ⇒ INVALID_INPUT نه پرتاب", () => {
    const g = { ...good.grant };
    Object.defineProperty(g, "amount", { enumerable: true, get() { throw new Error("boom"); } });
    expect(parseCommand("grant", g).ok).toBe(false);
    const p = new Proxy({}, { ownKeys() { throw new Error("boom"); } });
    expect(parseCommand("grant", p).ok).toBe(false);
    expect(parseKey(p).ok).toBe(false);
  });
  it("شیء با پروتوتایپ null پذیرفته می‌شود", () => {
    const o = Object.assign(Object.create(null) as object, good.open);
    expect(parseCommand("open", o).ok).toBe(true);
  });
  it("ورودی اصلی هرگز تغییر نمی‌کند", () => {
    const input = Object.freeze({ ...good.charge, amount: -0 });
    expect(() => parseCommand("charge", input)).not.toThrow();
  });
});

describe("ledger · parseKey", () => {
  it("معتبر و نامعتبر", () => {
    expect(parseKey({ tenantId: "t", accountId: "a" })).toEqual({ ok: true, value: { tenantId: "t", accountId: "a" } });
    expect(parseKey({ tenantId: "t" }).ok).toBe(false);
    expect(parseKey({ tenantId: "t", accountId: "a", x: 1 }).ok).toBe(false);
    expect(parseKey(null).ok).toBe(false);
  });
});

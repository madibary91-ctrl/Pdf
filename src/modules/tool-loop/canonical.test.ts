import { describe, expect, it } from "vitest";
import { canonicalCallKey as key } from "./index";

describe("tool-loop · کلیدِ هم‌ارزیِ فراخوانی", () => {
  it("ترتیبِ کلیدها و فاصله‌ها بی‌اثر است", () => {
    expect(key("t", '{"a":1,"b":{"x":[1,2],"y":null}}')).toBe(key("t", ' { "b" : {"y":null,"x":[1,2]}, "a": 1 } '));
  });
  it("عددِ هم‌ارز (۱ و ۱٫۰) یکی است", () => {
    expect(key("t", '{"a":1.0}')).toBe(key("t", '{"a":1}'));
  });
  it("ترتیبِ عضوهای آرایه معنا دارد", () => {
    expect(key("t", "[1,2]")).not.toBe(key("t", "[2,1]"));
  });
  it("نامِ ابزار یا مقدارِ متفاوت ⇒ کلیدِ متفاوت", () => {
    expect(key("t", '{"a":1}')).not.toBe(key("u", '{"a":1}'));
    expect(key("t", '{"a":1}')).not.toBe(key("t", '{"a":2}'));
    expect(key("t", '{"a":"1"}')).not.toBe(key("t", '{"a":1}'));
    expect(key("t", '{"a":null}')).not.toBe(key("t", "{}"));
  });
  it("JSONِ خراب به متنِ خام برمی‌گردد (فقط مساوی‌ها یکی‌اند)", () => {
    expect(key("t", "{bad")).toBe(key("t", "{bad"));
    expect(key("t", "{bad")).not.toBe(key("t", "{bad "));
  });
  it("کلیدِ __proto__ بی‌اثر و پایدار است", () => {
    expect(key("t", '{"__proto__":{"x":1},"a":1}')).toBe(key("t", '{"a":1,"__proto__":{"x":1}}'));
    expect(key("t", '{"__proto__":{"x":1}}')).not.toBe(key("t", '{"__proto__":{"x":2}}'));
  });
  it("آرگومانِ بسیار عمیق یا بسیار بزرگ پرتاب نمی‌کند", () => {
    const deep = "[".repeat(5000) + "]".repeat(5000);
    expect(() => key("t", deep)).not.toThrow();
    const big = JSON.stringify({ a: "x".repeat(70_000) });
    expect(key("t", big)).toBe(key("t", big));
    expect(() => key("t", "")).not.toThrow();
  });
  it("عمقِ مجاز (۳۲) کانونی می‌شود و عمیق‌تر خام می‌ماند", () => {
    const nest = (d: number) => "[".repeat(d) + "1" + "]".repeat(d);
    expect(key("t", ` ${nest(10)} `)).toBe(key("t", nest(10)));
    expect(key("t", ` ${nest(40)} `)).not.toBe(key("t", nest(40)));
  });
  it("جداکنندهٔ نام و آرگومان NUL است", () => {
    expect(key("ab", "1")).not.toBe(key("a", "b1"));
  });
});

/** شکست‌بستگیِ reviewPending: calc-tools را شبیه‌سازی می‌کنیم تا نشانه‌های ناسازگار بسازیم (در واقعیت نباید پیش بیایند). */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/modules/calc-tools", () => ({ executeCalcToolJson: vi.fn() }));

import { executeCalcToolJson } from "@/modules/calc-tools";
import { callOf, makeExecutor, parse, runSync } from "./test-kit";

const mocked = vi.mocked(executeCalcToolJson);
const out = (flag: boolean, status: string) =>
  ({
    ok: true,
    value: { tool: "court_fee", result: { feeRials: 1 }, review: { status, reviewedBy: null, reviewedOn: null }, reviewPending: flag, notes: ["n"] },
  }) as never;

beforeEach(() => mocked.mockReset());

describe("calc-tool-executor: reviewPending شکست‌بسته", () => {
  it.each([
    ["پرچم false و وضعیت legally-verified", false, "legally-verified", false],
    ["پرچم true و وضعیت legally-verified (ناسازگار)", true, "legally-verified", true],
    ["پرچم false و وضعیت pending-legal-review (ناسازگار)", false, "pending-legal-review", true],
    ["پرچم false و وضعیتِ ناشناخته (ناسازگار)", false, "approved-by-someone", true],
    ["پرچم true و وضعیتِ pending", true, "pending-legal-review", true],
  ])("%s ⇒ reviewPending=%s", (_n, flag, status, expected) => {
    mocked.mockReturnValue(out(flag, status));
    const seen: boolean[] = [];
    const exec = makeExecutor({ onResult: (o) => void seen.push(o.reviewPending) });
    const r = runSync(exec, callOf("court_fee", {}));
    expect(r).toMatchObject({ ok: true, reviewPending: expected });
    expect(parse(r)["reviewPending"]).toBe(expected);
    expect(seen).toEqual([expected]);
  });

  it("نام و آرگومانِ خامِ مدل عیناً به calc-tools می‌رسد (بی‌پاک‌سازیِ خاموش) همراه با deps", () => {
    mocked.mockReturnValue(out(true, "pending-legal-review"));
    const deps = { courtFeeTariffs: [] };
    runSync(makeExecutor({ deps }), callOf("court_fee", '{"a": 1}'));
    expect(mocked).toHaveBeenCalledWith("court_fee", '{"a": 1}', deps);
  });
});

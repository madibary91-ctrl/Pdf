/**
 * چرخهٔ عمرِ مهلت و اتصال (ADR-0081): پس از رهاشدنِ اجرا هیچ پرس‌وجو/نوشتنِ تازه‌ای شروع نمی‌شود، و اتصالی که دیر باز شد بی‌درنگ بسته می‌شود.
 * هر «آویزان» فقط یک بار آویزان می‌ماند (فراخوانی‌های بعدی عادی‌اند) تا نتیجهٔ دیرهنگام واقعاً به منطق برسد.
 */
import { describe, expect, it } from "vitest";
import { runToolPolicyGrants } from "./index";
import { ARGV, ENV, flush, manualTimer, newWorld, portsFor, relationRows, safeRole, schemaRows } from "./test-kit";

const driftWorld = () => newWorld({ schema: schemaRows([]), relations: relationRows({ tool_policy_versions: [], tool_policy_migration_ledger: [] }) });

/** فقط فراخوانیِ `n`امِ پرس‌وجو آویزان می‌شود؛ `release` نتیجهٔ دیرهنگامش را می‌دهد. */
function hangNth(world: ReturnType<typeof driftWorld>, n: number): { release: (v: unknown) => void } {
  let count = 0;
  const box = { release: (_v: unknown): void => undefined };
  world.queryHook = () => (++count === n ? new Promise((res) => (box.release = res)) : undefined);
  return box;
}

async function startAndExpire(world: ReturnType<typeof driftWorld>): Promise<{ out: Awaited<ReturnType<typeof runToolPolicyGrants>>; timer: ReturnType<typeof manualTimer> }> {
  const timer = manualTimer();
  const p = runToolPolicyGrants({ argv: [...ARGV("apply"), "--timeout-ms=5000"], env: ENV, ports: portsFor(world, timer, []) });
  await flush();
  await timer.advance(5000);
  return { out: await p, timer };
}

describe("tool-policy-grants · نتیجهٔ دیرهنگام پس از مهلت", () => {
  it("خواندنِ نقشِ آویزان: پس از مهلت و رسیدنِ نتیجه هیچ پرس‌وجو یا transactی شروع نمی‌شود", async () => {
    const w = driftWorld();
    const hang = hangNth(w, 1);
    const { out } = await startAndExpire(w);
    expect([out.exitCode, out.report.phase, out.report.wrote]).toEqual([7, "check", undefined]);
    hang.release({ rows: [safeRole] });
    await flush();
    expect(w.calls).toEqual(["query:role"]);
    expect(w.transactions).toEqual([]);
  });

  it("خواندنِ آخر (رابطه‌ها) آویزان: با نتیجهٔ دیرهنگامِ «drift» هرگز transact نمی‌شود", async () => {
    const w = driftWorld();
    const hang = hangNth(w, 3);
    const { out } = await startAndExpire(w);
    expect([out.exitCode, out.report.phase]).toEqual([7, "check"]);
    hang.release({ rows: relationRows({ tool_policy_versions: [], tool_policy_migration_ledger: [] }) });
    await flush();
    expect(w.calls).toEqual(["query:role", "query:schema", "query:relations"]);
    expect(w.transactions).toEqual([]);
  });

  it("transact آویزان: TIMEOUT در phase=apply بی‌wrote؛ نتیجهٔ دیرهنگام هیچ خواندنِ تازه‌ای راه نمی‌اندازد", async () => {
    const w = driftWorld();
    let release: () => void = () => undefined;
    w.transactHook = () => new Promise<void>((res) => (release = res));
    const { out } = await startAndExpire(w);
    expect([out.exitCode, out.report.phase, out.report.wrote]).toEqual([7, "apply", undefined]);
    const before = w.calls.length;
    release();
    await flush();
    expect(w.calls).toHaveLength(before);
  });
});

describe("tool-policy-grants · اتصالِ دیرهنگام", () => {
  it("open آویزان: در مهلت ⇒ TIMEOUT با closed=false؛ وقتی دیر باز شد بی‌درنگ بسته می‌شود و هیچ پرس‌وجویی نمی‌رود", async () => {
    const w = driftWorld();
    let release: (v: unknown) => void = () => undefined;
    w.openHook = () => new Promise((res) => (release = res));
    const { out } = await startAndExpire(w);
    expect([out.exitCode, out.report.closed]).toEqual([7, false]);
    expect(w.closed).toBe(0);
    release({ db: { tag: "late" }, close: () => void w.closed++ });
    await flush();
    expect(w.closed).toBe(1);
    expect(w.calls).toEqual([]);
  });
});

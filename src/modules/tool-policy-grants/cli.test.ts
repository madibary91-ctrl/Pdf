import { describe, expect, it } from "vitest";
import { runToolPolicyGrants, GRANTS_EXIT } from "./index";
import { ARGV, CANARY, ENV, SECRET_URL, exactWorld, expectedStatements, flush, manualTimer, newWorld, portsFor, relationRows, runWith, safeRole, schemaRows } from "./test-kit";

const REPORT_KEYS = new Set(["tool", "command", "ok", "code", "exitCode", "phase", "pgCode", "role", "schema", "findings", "wrote", "statements", "issues", "usage", "closed"]);
const report = (r: { lines: string[] }): Record<string, unknown> => JSON.parse(r.lines[0] as string) as Record<string, unknown>;
const driftWorld = () => newWorld({ schema: schemaRows([]), relations: relationRows({ tool_policy_versions: [], tool_policy_migration_ledger: [] }) });
/** پس از transact دنیا دقیقاً قرارداد می‌شود. */
const converging = (w = driftWorld()) => Object.assign(w, { transactHook: (_s: readonly string[], world: typeof w) => void Object.assign(world, exactWorld()) });

describe("tool-policy-grants · کدهای خروج", () => {
  it("جدولِ بسته قفل است", () => {
    expect(GRANTS_EXIT).toEqual({ OK: 0, INTERNAL: 1, USAGE: 2, PENDING: 3, UNAVAILABLE: 4, DRIFT: 5, APPLY_FAILED: 6, TIMEOUT: 7, ROLE_UNUSABLE: 8 });
    expect(Object.isFrozen(GRANTS_EXIT)).toBe(true);
  });
});

describe("tool-policy-grants · plan و USAGE بی‌اتصال", () => {
  it("plan: دستورها را چاپ می‌کند، هرگز نمی‌گشاید، نمی‌پرسد و نمی‌نویسد؛ بی‌DATABASE_URL هم کار می‌کند", async () => {
    const r = await runWith(ARGV("plan"), { TOOL_POLICY_SCHEMA: "tpg_unit" });
    expect(r.exitCode).toBe(0);
    expect(r.world.opened + r.world.calls.length).toBe(0);
    expect(r.report).toMatchObject({ command: "plan", ok: true, code: "OK", role: "policy_runtime", schema: "tpg_unit", statements: expectedStatements() });
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]?.endsWith("\n")).toBe(true);
    expect(r.timer.delays).toEqual([]);
  });

  it("plan بی‌شِما ⇒ شِمای پیش‌فرض tool_policy", async () => {
    const r = await runWith(ARGV("plan"), {});
    expect(r.report.schema).toBe("tool_policy");
    expect(r.report.statements?.join("\n")).toContain('"tool_policy"."tool_policy_versions"');
  });

  it("آرگومان/env نامعتبر ⇒ USAGE (۲) بی‌اتصال، بی‌مقدار", async () => {
    for (const [argv, env] of [[["verify"], ENV], [ARGV("verify", "Bad"), ENV], [ARGV("verify"), {}], [ARGV("verify"), { ...ENV, TOOL_POLICY_SCHEMA: "public" }], [["nope"], ENV], [[], ENV]] as const) {
      const r = await runWith(argv, env);
      expect([r.exitCode, r.report.code]).toEqual([2, "USAGE"]);
      expect(r.world.opened + r.world.calls.length).toBe(0);
      expect(r.report.usage?.length).toBeGreaterThan(0);
      expect(r.lines.join("")).not.toContain(CANARY);
    }
  });

  it("--help ⇒ ۰ با usage، بی‌اتصال", async () => {
    const r = await runWith(["--help"], undefined);
    expect([r.exitCode, r.report.command]).toEqual([0, "help"]);
    expect(r.world.opened).toBe(0);
  });
});

describe("tool-policy-grants · verify", () => {
  it("دقیقاً قرارداد ⇒ ۰؛ سه خواندن به ترتیب؛ هرگز transact؛ اتصال یک بار باز و بسته", async () => {
    const r = await runWith(ARGV("verify"), ENV);
    expect([r.exitCode, r.report.phase, r.report.closed, r.report.findings, r.report.wrote]).toEqual([0, "check", true, undefined, undefined]);
    expect(r.world.calls).toEqual(["query:role", "query:schema", "query:relations"]);
    expect([r.world.opened, r.world.closed]).toEqual([1, 1]);
    expect(r.timer.pending()).toBe(0);
  });

  it("حقِ کم یا زیاد ⇒ DRIFT (۵) با یافته‌ها؛ هیچ نوشتنی", async () => {
    const r = await runWith(ARGV("verify"), ENV, driftWorld());
    expect([r.exitCode, r.report.code]).toEqual([5, "DRIFT"]);
    expect(r.report.findings).toEqual(["missing:schema:USAGE", "missing:tool_policy_versions:SELECT", "missing:tool_policy_versions:INSERT", "missing:tool_policy_migration_ledger:SELECT"]);
    const extra = await runWith(ARGV("verify"), ENV, newWorld({ schema: schemaRows(["USAGE", "CREATE"]) }));
    expect([extra.exitCode, extra.report.findings]).toEqual([5, ["excess:schema:CREATE"]]);
    expect(r.world.transactions).toEqual([]);
  });

  it("نقشِ ناموجود/خطرناک و مالک ⇒ ROLE_UNUSABLE (۸) و پرس‌وجوهای بعدی اجرا نمی‌شود؛ شِما/جدولِ ناموجود ⇒ PENDING (۳)", async () => {
    const missing = await runWith(ARGV("verify"), ENV, newWorld({ role: [] }));
    expect([missing.exitCode, missing.report.findings]).toEqual([8, ["role_missing"]]);
    expect(missing.world.calls).toEqual(["query:role"]);
    const su = await runWith(ARGV("apply"), ENV, newWorld({ role: [{ ...safeRole, super: true }] }));
    expect([su.exitCode, su.report.findings, su.world.transactions]).toEqual([8, ["role_superuser"], []]);
    const owner = await runWith(ARGV("apply"), ENV, newWorld({ schema: schemaRows(["USAGE"], true) }));
    expect([owner.exitCode, owner.report.findings, owner.world.transactions]).toEqual([8, ["owner:schema"], []]);
    const none = await runWith(ARGV("apply"), ENV, newWorld({ schema: [], relations: [] }));
    expect([none.exitCode, none.report.findings, none.world.transactions]).toEqual([3, ["schema_missing"], []]);
    const bare = await runWith(ARGV("verify"), ENV, newWorld({ relations: [] }));
    expect([bare.exitCode, bare.report.findings?.length]).toEqual([3, 2]);
  });

  it("پاسخِ بدشکلِ هر یک از سه خواندن ⇒ INTERNAL (۱) (بسته: هرگز «خوب» نیست)", async () => {
    for (const bad of [null, "x", {}, { rows: 5 }]) {
      for (const kind of ["query:role", "query:schema", "query:relations"]) {
        const w = newWorld({ queryHook: (text, _p, world) => (world.calls[world.calls.length - 1] === kind ? bad : undefined) });
        const r = await runWith(ARGV("apply"), ENV, w);
        expect([r.exitCode, r.world.transactions.length], `${kind} ${JSON.stringify(bad)}`).toEqual([1, 0]);
      }
    }
  });

  it("خطای پایگاه ⇒ UNAVAILABLE (۴) با فقط SQLSTATE؛ مهلتِ سرور (57014/55P03) ⇒ TIMEOUT (۷)؛ متنِ خطا هرگز بیرون نمی‌رود", async () => {
    const failing = (code: string | null) =>
      newWorld({
        queryHook: () => {
          throw Object.assign(new Error(`${SECRET_URL} ${CANARY}`), { cause: code === null ? undefined : { code, message: CANARY } });
        },
      });
    const a = await runWith(ARGV("verify"), ENV, failing("08006"));
    expect([a.exitCode, a.report.pgCode]).toEqual([4, "08006"]);
    const b = await runWith(ARGV("verify"), ENV, failing(null));
    expect([b.exitCode, b.report.pgCode]).toEqual([4, undefined]);
    for (const code of ["57014", "55P03"]) {
      const t = await runWith(ARGV("verify"), ENV, failing(code));
      expect([t.exitCode, t.report.pgCode]).toEqual([7, code]);
    }
    for (const r of [a, b]) expect(r.lines.join("")).not.toContain(CANARY);
    const odd = await runWith(ARGV("verify"), ENV, failing("not5"));
    expect(odd.report.pgCode).toBeUndefined();
  });

  it("open شکست یا پایگاهِ بی‌close ⇒ UNAVAILABLE / INTERNAL", async () => {
    const o = await runWith(ARGV("verify"), ENV, newWorld({ openHook: () => Promise.reject(new Error(SECRET_URL)) }));
    expect([o.exitCode, o.report.closed]).toEqual([4, true]);
    expect(o.lines.join("")).not.toContain(CANARY);
    const inv = await runWith(ARGV("verify"), ENV, newWorld({ openHook: () => ({ db: {} }) }));
    expect(inv.exitCode).toBe(1);
  });
});

describe("tool-policy-grants · apply", () => {
  it("از پیش دقیق ⇒ ۰ بی‌transact", async () => {
    const r = await runWith(ARGV("apply"), ENV);
    expect([r.exitCode, r.world.transactions, r.report.wrote, r.report.phase]).toEqual([0, [], undefined, "check"]);
  });

  it("drift ⇒ یک transact با دستورهای طرح، سپس خواندنِ دوباره؛ ۰ با wrote و phase=verify", async () => {
    const w = converging();
    const r = await runWith(ARGV("apply"), ENV, w);
    expect([r.exitCode, r.report.wrote, r.report.phase, r.report.findings]).toEqual([0, true, "verify", undefined]);
    expect(w.transactions).toEqual([expectedStatements()]);
    expect(w.calls).toEqual(["query:role", "query:schema", "query:relations", "transact", "query:role", "query:schema", "query:relations"]);
  });

  it("مهلتِ --timeout-ms به سقفِ سمتِ سرور (نیمه) می‌رسد", async () => {
    const w = converging();
    await runWith([...ARGV("apply"), "--timeout-ms=20000"], ENV, w);
    expect(w.transactions[0]?.slice(0, 2)).toEqual(["SET LOCAL lock_timeout = 10000", "SET LOCAL statement_timeout = 10000"]);
  });

  it("ok را از ادعای خودش نمی‌گیرد: transact موفق ولی حقِ زیاد هنوز هست (PUBLIC/عضویت) ⇒ APPLY_FAILED (۶) با یافتهٔ دوباره‌خوانده", async () => {
    const w = driftWorld();
    w.transactHook = (_s, world) => void Object.assign(world, { ...exactWorld(), relations: relationRows({ tool_policy_versions: ["SELECT", "INSERT", "UPDATE"], tool_policy_migration_ledger: ["SELECT"] }) });
    const r = await runWith(ARGV("apply"), ENV, w);
    expect([r.exitCode, r.report.phase, r.report.wrote, r.report.findings]).toEqual([6, "verify", true, ["excess:tool_policy_versions:UPDATE"]]);
  });

  it("transact رد شود ⇒ APPLY_FAILED با SQLSTATE؛ مهلتِ سرور ⇒ TIMEOUT؛ هیچ wrote و هیچ خواندنِ بعدی", async () => {
    const w = driftWorld();
    w.transactHook = () => {
      throw Object.assign(new Error(CANARY), { cause: { code: "42501" } });
    };
    const r = await runWith(ARGV("apply"), ENV, w);
    expect([r.exitCode, r.report.phase, r.report.pgCode, r.report.wrote, w.calls.filter((c) => c === "transact").length]).toEqual([6, "apply", "42501", undefined, 1]);
    expect(w.calls).toHaveLength(4);
    expect(r.lines.join("")).not.toContain(CANARY);
    for (const code of ["55P03", "57014"]) {
      const w2 = driftWorld();
      w2.transactHook = () => Promise.reject(Object.assign(new Error("x"), { code }));
      const t = await runWith(ARGV("apply"), ENV, w2);
      expect([t.exitCode, t.report.pgCode, t.report.wrote]).toEqual([7, code, undefined]);
    }
  });

  it("خواندنِ دوباره شکست/بدشکل ⇒ APPLY_FAILED/INTERNAL با wrote=true (حالتِ نامعلوم هرگز ok نیست)", async () => {
    const failing = converging();
    let n = 0;
    failing.queryHook = () => {
      if (failing.calls.includes("transact") && ++n === 1) throw Object.assign(new Error("x"), { code: "08006" });
      return undefined;
    };
    const r = await runWith(ARGV("apply"), ENV, failing);
    expect([r.exitCode, r.report.phase, r.report.wrote, r.report.pgCode]).toEqual([6, "verify", true, "08006"]);
    const malformed = converging();
    malformed.queryHook = () => (malformed.calls.includes("transact") ? { rows: "bad" } : undefined);
    const m = await runWith(ARGV("apply"), ENV, malformed);
    expect([m.exitCode, m.report.wrote]).toEqual([1, true]);
    const lost = converging();
    lost.transactHook = (_s, world) => void Object.assign(world, { role: [] });
    const l = await runWith(ARGV("apply"), ENV, lost);
    expect([l.exitCode, l.report.findings]).toEqual([6, ["role_missing"]]);
  });
});

describe("tool-policy-grants · مهلتِ کل و بستنِ اتصال", () => {
  it("خواندنِ آویزان ⇒ TIMEOUT (۷) در مهلت؛ نتیجهٔ دیرهنگام هیچ transactی را شروع نمی‌کند؛ اتصال بسته می‌شود", async () => {
    const w = driftWorld();
    let release: (v: unknown) => void = () => undefined;
    w.queryHook = () => new Promise((res) => (release = res));
    const timer = manualTimer();
    const lines: string[] = [];
    const p = runToolPolicyGrants({ argv: [...ARGV("apply"), "--timeout-ms=5000"], env: ENV, ports: portsFor(w, timer, lines) });
    await flush();
    await timer.advance(5000);
    const out = await p;
    expect([out.exitCode, out.report.code, out.report.phase, out.report.closed]).toEqual([7, "TIMEOUT", "check", true]);
    release({ rows: [safeRole] });
    await flush();
    release({ rows: [] });
    await flush();
    expect(w.transactions).toEqual([]);
    expect(w.closed).toBe(1);
    expect(timer.delays[0]).toBe(5000);
  });

  it("close که می‌شکند یا آویزان است ⇒ closed=false (گلو فرایند را سخت می‌بُرد) و نتیجهٔ اصلی عوض نمی‌شود", async () => {
    const throwing = await runWith(ARGV("verify"), ENV, newWorld({ closeHook: () => Promise.reject(new Error("x")) }));
    expect([throwing.exitCode, throwing.report.closed]).toEqual([0, false]);
    const w = newWorld({ closeHook: () => new Promise(() => undefined) });
    const timer = manualTimer();
    const lines: string[] = [];
    const p = runToolPolicyGrants({ argv: ARGV("verify"), env: ENV, ports: portsFor(w, timer, lines) });
    await flush();
    await timer.advance(5000);
    const out = await p;
    expect([out.exitCode, out.report.closed]).toEqual([0, false]);
  });

  it("زمان‌سنجِ خراب ⇒ INTERNAL و هیچ پرس‌وجویی اجرا نمی‌شود", async () => {
    const w = newWorld();
    const broken = { after: () => { throw new Error("t"); }, cancel: () => undefined };
    const out = await runToolPolicyGrants({ argv: ARGV("verify"), env: ENV, ports: { ...portsFor(w, manualTimer(), []), timer: broken } });
    expect([out.exitCode, w.calls.length]).toEqual([1, 0]);
  });
});

describe("tool-policy-grants · مرزها", () => {
  it("گزارش همیشه یک خطِ JSONِ تخت با کلیدهای بسته است و هیچ مقدارِ محیط/رشتهٔ اتصال/متنِ خطا در آن نیست", async () => {
    const runs = [
      await runWith(ARGV("plan"), ENV),
      await runWith(ARGV("verify"), ENV),
      await runWith(ARGV("verify"), ENV, driftWorld()),
      await runWith(ARGV("apply"), ENV, converging()),
      await runWith(ARGV("verify", "Bad"), ENV),
      await runWith(ARGV("verify"), ENV, newWorld({ role: [] })),
    ];
    for (const r of runs) {
      expect(r.lines).toHaveLength(1);
      const rep = report(r);
      for (const k of Object.keys(rep)) expect(REPORT_KEYS.has(k), k).toBe(true);
      expect(r.lines[0]).not.toContain(CANARY);
      expect(r.lines[0]).not.toContain("postgres://");
      expect(rep["exitCode"]).toBe(r.exitCode);
      expect(rep["ok"]).toBe(r.exitCode === 0);
    }
  });

  it("پورتِ خراب/ورودیِ خراب ⇒ INTERNAL بی‌پرتاب؛ write که می‌پرتابد کدِ خروج را عوض نمی‌کند", async () => {
    for (const bad of [undefined, null, 5, "x", [], {}, { argv: [], env: {}, ports: {} }, { argv: [], env: {}, ports: { open() {}, query() {}, transact() {}, write() {} } }]) {
      const out = await runToolPolicyGrants(bad);
      expect(out.exitCode, JSON.stringify(bad)).toBe(1);
    }
    const w = newWorld();
    const out = await runToolPolicyGrants({ argv: ARGV("verify"), env: ENV, ports: { ...portsFor(w, manualTimer(), []), write: () => { throw new Error("w"); } } });
    expect(out.exitCode).toBe(0);
    const getter = await runToolPolicyGrants({ get argv(): never { throw new Error("g"); }, env: {}, ports: portsFor(w, manualTimer(), []) });
    expect(getter.exitCode).toBe(1);
  });

  it("خروجی یخ‌زده است", async () => {
    const r = await runWith(ARGV("verify"), ENV);
    expect(Object.isFrozen(r.report)).toBe(true);
  });
});

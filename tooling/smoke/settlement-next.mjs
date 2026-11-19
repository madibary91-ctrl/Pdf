#!/usr/bin/env node
/**
 * دودیِ فرایندِ واقعی (ADR-0033): `next start` واقعی + PostgreSQL واقعی + SIGTERM واقعی. جزو دروازهٔ CI نیست (ساخت و پورت می‌خواهد)؛
 * مسئولِ تحویل پیش از هر تغییرِ `instrumentation`/`settlement-bootstrap` اجرا می‌کند و خروجی را در یادداشت تحویل می‌آورد.
 *
 * اجرا:  DATABASE_URL=postgresql://… npm run build && node tooling/smoke/settlement-next.mjs
 * سناریوها: A پیش‌فرض خاموش · B روشنِ مهاجرت‌شده (Next صاحبِ خروج) · C روشنِ مهاجرت‌شده با NEXT_MANUAL_SIG_HANDLE (ما صاحبِ خروجیم)
 *           D روشنِ مهاجرت‌نشده (شکست‌بسته) · E env نامعتبر.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DB = process.env.DATABASE_URL;
if (!DB) { console.error("DATABASE_URL لازم است"); process.exit(2); }
const NEXT = join(ROOT, "node_modules", "next", "dist", "bin", "next");
const results = [];
const check = (name, cond, extra = "") => { results.push({ name, ok: !!cond }); console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : ` ← ${extra}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((res, rej) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); s.on("error", rej); });
}
const tag = randomBytes(4).toString("hex");
const L = `smk_l_${tag}`, S = `smk_s_${tag}`;

async function migrate() {
  const r = spawnSync("node", ["node_modules/vite-node/vite-node.mjs", "-c", "vitest.config.ts", "tooling/smoke/settlement-migrate.ts"], { cwd: ROOT, env: { ...process.env, SETTLEMENT_LEDGER_SCHEMA: L, SETTLEMENT_OUTBOX_SCHEMA: S }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`migrate failed: ${r.stdout}${r.stderr}`);
}
async function dropSchemas() {
  const p = new pg.Pool({ connectionString: DB, max: 1 });
  try { await p.query(`DROP SCHEMA IF EXISTS "${L}" CASCADE`); await p.query(`DROP SCHEMA IF EXISTS "${S}" CASCADE`); } finally { await p.end(); }
}

async function run(label, env, body) {
  console.log(`\n── ${label}`);
  const port = await freePort();
  const out = [];
  const child = spawn("node", [NEXT, "start", "-p", String(port), "-H", "127.0.0.1"], { cwd: ROOT, env: { ...process.env, DATABASE_URL: DB, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => out.push(String(d)));
  child.stderr.on("data", (d) => out.push(String(d)));
  let exit = null;
  child.on("exit", (code, sig) => { exit = { code, sig }; });
  const base = `http://127.0.0.1:${port}`;
  const get = async (p) => { try { const r = await fetch(base + p); return { status: r.status, body: await r.json().catch(() => null), cc: r.headers.get("cache-control") }; } catch { return { status: 0, body: null }; } };
  for (let i = 0; i < 300 && (await get("/api/health/live")).status !== 200; i++) await sleep(100);
  const waitFor = async (p, status, ms = 8000) => { for (let t = 0; t < ms; t += 100) { if ((await get(p)).status === status) return true; await sleep(100); } return false; };
  const logs = () => out.join("");
  const events = () => logs().split("\n").filter((l) => l.startsWith('{"scope":"settlement"')).map((l) => JSON.parse(l));
  try { await body({ get, waitFor, logs, events, term: async () => { child.kill("SIGTERM"); for (let i = 0; i < 100 && exit === null; i++) await sleep(100); return exit; } }); }
  finally { if (exit === null) { child.kill("SIGKILL"); await sleep(200); } }
  check(`${label}: هیچ اسراری (گذرواژهٔ پایگاه) در لاگ نیست`, !logs().includes("postgres:postgres") && !/postgres(ql)?:\/\/[^\s]*@/.test(logs()), logs().slice(-300));
}

try {
  await run("A · پیش‌فرض خاموش", {}, async (c) => {
    const h = await c.get("/api/health");
    check("A: /api/health اصلی همچنان ۲۰۰ {ok:true}", h.status === 200 && h.body?.ok === true, JSON.stringify(h));
    check("A: live ۲۰۰", (await c.get("/api/health/live")).status === 200);
    const r = await c.get("/api/health/ready");
    check("A: ready ۵۰۳ با state absent و بی‌کش", r.status === 503 && r.body?.state === "absent" && r.cc === "no-store", JSON.stringify(r));
    check("A: startup ۵۰۳", (await c.get("/api/health/startup")).status === 503);
    check("A: رویداد bootstrap.disabled لاگ شد", c.events().some((e) => e.type === "bootstrap.disabled"), c.logs());
    const ex = await c.term();
    check("A: SIGTERM ⇒ Next خودش می‌بُرد (۱۴۳)", ex?.code === 143, JSON.stringify(ex));
  });

  await migrate();
  const ON = { SETTLEMENT_HOST: "on", SETTLEMENT_GRACE_MS: "60000", SETTLEMENT_LEDGER_SCHEMA: L, SETTLEMENT_OUTBOX_SCHEMA: S };

  await run("B · روشنِ مهاجرت‌شده، Next صاحبِ خروج", ON, async (c) => {
    check("B: ready در نهایت ۲۰۰", await c.waitFor("/api/health/ready", 200), c.logs());
    const r = await c.get("/api/health/ready");
    check("B: بدنهٔ ready بسته و running/ok", r.body?.state === "running" && r.body?.sweep === "ok" && Object.keys(r.body).sort().join() === "ok,probe,state,sweep", JSON.stringify(r));
    check("B: startup و live ۲۰۰", (await c.get("/api/health/startup")).status === 200 && (await c.get("/api/health/live")).status === 200);
    check("B: /api/health اصلی ۲۰۰", (await c.get("/api/health")).status === 200);
    check("B: bootstrap.started با processOwner=next", c.events().some((e) => e.type === "bootstrap.started" && e.processOwner === "next"), c.logs());
    const ex = await c.term();
    check("B: SIGTERM ⇒ خروج با ۱۴۳ (Next پیش‌دستی می‌کند؛ رقابتِ مستند)", ex?.code === 143, JSON.stringify(ex));
  });

  await run("C · روشنِ مهاجرت‌شده، NEXT_MANUAL_SIG_HANDLE (ما صاحبِ خروجیم)", { ...ON, NEXT_MANUAL_SIG_HANDLE: "1" }, async (c) => {
    check("C: ready در نهایت ۲۰۰", await c.waitFor("/api/health/ready", 200), c.logs());
    check("C: bootstrap.started با processOwner=host", c.events().some((e) => e.type === "bootstrap.started" && e.processOwner === "host"), c.logs());
    const ex = await c.term();
    const fin = c.events().find((e) => e.type === "host" && e.event?.type === "shutdown.finished");
    check("C: خاموشیِ مرتب: ok، clean، بی‌مهلت، استخر بسته", fin?.event?.ok === true && fin.event.clean === true && fin.event.timedOut === false && fin.event.closed === "ok", JSON.stringify(fin));
    check("C: خروج با کدِ ۰ (نه ۱۴۳)", ex?.code === 0, JSON.stringify(ex));
  });

  await run("D · روشنِ مهاجرت‌نشده (شکست‌بسته)", { ...ON, SETTLEMENT_LEDGER_SCHEMA: `${L}_none`, SETTLEMENT_OUTBOX_SCHEMA: `${S}_none`, SETTLEMENT_BOOT_ATTEMPTS: "3", SETTLEMENT_BOOT_RETRY_DELAY_MS: "100", NEXT_MANUAL_SIG_HANDLE: "1" }, async (c) => {
    check("D: boot.failed با NOT_MIGRATED", await (async () => { for (let i = 0; i < 80; i++) { if (c.events().some((e) => e.type === "host" && e.event?.type === "boot.failed" && e.event.code === "NOT_MIGRATED")) return true; await sleep(100); } return false; })(), c.logs());
    check("D: بازتلاش نشد (۱ تلاشِ شکست‌خورده)", c.events().filter((e) => e.event?.type === "boot.attempt_failed").length === 1, c.logs());
    check("D: ready و startup ۵۰۳، live ۲۰۰، /api/health اصلی ۲۰۰ (سرور بالاست)", (await c.get("/api/health/ready")).status === 503 && (await c.get("/api/health/startup")).status === 503 && (await c.get("/api/health/live")).status === 200 && (await c.get("/api/health")).status === 200);
    const ex = await c.term();
    check("D: SIGTERM ⇒ خروجِ مرتب با ۰", ex?.code === 0, JSON.stringify(ex));
  });

  await run("E · env نامعتبر (SETTLEMENT_HOST=ON)", { SETTLEMENT_HOST: "ON", SETTLEMENT_GRACE_MS: "60000" }, async (c) => {
    await sleep(500);
    check("E: bootstrap.failed با INVALID_ENV", c.events().some((e) => e.type === "bootstrap.failed" && e.code === "INVALID_ENV"), c.logs());
    check("E: سرور بالا ولی ready ۵۰۳ و /api/health ۲۰۰", (await c.get("/api/health/ready")).status === 503 && (await c.get("/api/health")).status === 200);
    await c.term();
  });
} finally {
  await dropSchemas();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nنتیجه: ${results.length - failed.length}/${results.length} سبز`);
process.exit(failed.length === 0 ? 0 : 1);

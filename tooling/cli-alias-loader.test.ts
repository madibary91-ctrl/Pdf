/**
 * حلقهٔ resolveِ CLI (tooling/cli/alias-loader.mjs، ADR-0034) — بی‌پایگاه. اجرای واقعی با فرایندِ واقعی در
 * `src/modules/settlement-migrate/process.pg.test.ts` سنجیده می‌شود؛ این‌جا قواعدِ بازنویسی (و نبودنِ بازنویسیِ بیش‌ازحد) قفل می‌شود.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { candidateFor, resolve } from "./cli/alias-loader.mjs";

const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "src");
const url = (p: string): string => pathToFileURL(p).href;
const next = (specifier: string): Promise<unknown> => Promise.resolve({ passedThrough: specifier });

describe("tooling/cli · حلقهٔ resolve", () => {
  it("candidateFor: خودِ فایل .ts، مسیر+.ts و مسیر/index.ts؛ وگرنه null", () => {
    expect(candidateFor(join(SRC, "modules", "ledger"))).toBe(join(SRC, "modules", "ledger", "index.ts"));
    expect(candidateFor(join(SRC, "modules", "ledger", "engine"))).toBe(join(SRC, "modules", "ledger", "engine.ts"));
    expect(candidateFor(join(SRC, "modules", "ledger", "engine.ts"))).toBe(join(SRC, "modules", "ledger", "engine.ts"));
    expect(candidateFor(join(SRC, "modules", "ledger", "nope"))).toBeNull();
    expect(candidateFor(join(SRC, "modules", "ledger", "README.md"))).toBeNull(); // فقط .ts
  });

  it("@/… به src/… و فایلِ ناموجود دست‌نخورده می‌ماند", async () => {
    expect(await resolve("@/modules/ledger", { parentURL: url(join(ROOT, "tooling", "x.ts")) }, next)).toEqual({ passedThrough: url(join(SRC, "modules", "ledger", "index.ts")) });
    expect(await resolve("@/modules/__nope__", { parentURL: url(join(ROOT, "tooling", "x.ts")) }, next)).toEqual({ passedThrough: "@/modules/__nope__" });
  });

  it("importِ نسبیِ بی‌پسوند فقط برای والدِ .ts در مخزن (نه node_modules، نه .js) بازنویسی می‌شود", async () => {
    const parent = url(join(SRC, "modules", "ledger", "ledger.ts"));
    expect(await resolve("./engine", { parentURL: parent }, next)).toEqual({ passedThrough: url(join(SRC, "modules", "ledger", "engine.ts")) });
    expect(await resolve("./pg", { parentURL: parent }, next)).toEqual({ passedThrough: url(join(SRC, "modules", "ledger", "pg", "index.ts")) });
    expect(await resolve("./engine", { parentURL: url(join(SRC, "modules", "ledger", "ledger.js")) }, next)).toEqual({ passedThrough: "./engine" });
    expect(await resolve("./engine", { parentURL: url(join(ROOT, "node_modules", "x", "ledger.ts")) }, next)).toEqual({ passedThrough: "./engine" });
    expect(await resolve("./engine", {}, next)).toEqual({ passedThrough: "./engine" });
  });

  it("بسته‌ها و node: دست‌نخورده‌اند", async () => {
    const parent = url(join(SRC, "modules", "ledger", "ledger.ts"));
    for (const spec of ["pg", "drizzle-orm", "node:path", "drizzle-orm/node-postgres", "../../../package.json"]) {
      expect(await resolve(spec, { parentURL: parent }, next), spec).toEqual({ passedThrough: spec });
    }
  });
});

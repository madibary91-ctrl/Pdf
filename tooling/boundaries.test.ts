import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { MODULES, STEPS, type ModuleInfo } from "../src/modules/registry";
import { checkBoundaries, checkRegistry, extractImports, type SourceFile } from "./boundaries";

const ROOT = join(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

function loadSources(): SourceFile[] {
  return walk(join(ROOT, "src")).map((p) => ({
    path: relative(ROOT, p).replace(/\\/g, "/"),
    content: readFileSync(p, "utf8"),
  }));
}

const mod = (over: Partial<ModuleInfo> & { name: string }): ModuleInfo => ({
  layer: 1,
  step: 2,
  title: "t",
  purpose: "p",
  dependsOn: [],
  pure: true,
  humanReview: false,
  status: "planned",
  ...over,
});

describe("tooling: مرزهای واقعی مخزن", () => {
  it("registry سالم است (وابستگی ناشناخته، رو به بالا یا دایره‌ای ندارد)", () => {
    expect(checkRegistry(MODULES)).toEqual([]);
  });

  it("هر گام ساخت حداقل یک ماژول یا توضیح دارد و گام‌ها یکتا هستند", () => {
    expect(new Set(STEPS.map((s) => s.step)).size).toBe(STEPS.length);
    for (const m of MODULES) expect(STEPS.some((s) => s.step === m.step)).toBe(true);
  });

  it("هیچ نقض مرزی در کد فعلی نیست", () => {
    expect(checkBoundaries(loadSources(), MODULES)).toEqual([]);
  });

  it("هر ماژول «done» پوشهٔ خودش، index.ts، README و تست دارد", () => {
    for (const m of MODULES.filter((x) => x.status === "done")) {
      const dir = join(ROOT, "src/modules", m.name);
      const names = readdirSync(dir);
      expect(names, `${m.name}: index.ts`).toContain("index.ts");
      expect(names, `${m.name}: README.md`).toContain("README.md");
      if (m.name !== "shared-types") {
        expect(names.some((n) => n.endsWith(".test.ts")), `${m.name}: تست`).toBe(true);
      }
    }
  });

  it("ماژول‌های روی دیسک همه در registry هستند", () => {
    const names = new Set(MODULES.map((m) => m.name));
    for (const dir of readdirSync(join(ROOT, "src/modules"))) {
      if (statSync(join(ROOT, "src/modules", dir)).isDirectory()) expect(names.has(dir), dir).toBe(true);
    }
  });
});

describe("tooling: خود بررسی‌گر نقض‌ها را می‌گیرد", () => {
  const modules = [
    mod({ name: "low", layer: 0 }),
    mod({ name: "mid", layer: 1, dependsOn: ["low"] }),
    mod({ name: "high", layer: 2, dependsOn: ["mid"], pure: false }),
  ];
  const file = (path: string, content: string): SourceFile => ({ path, content });
  const rules = (files: SourceFile[]) => checkBoundaries(files, modules).map((v) => v.rule);

  it("import مجاز و تمیز", () => {
    expect(rules([file("src/modules/mid/a.ts", `import { x } from "@/modules/low";\nimport { y } from "./b";`)])).toEqual([]);
  });

  it("import عمیق از ماژول دیگر", () => {
    expect(rules([file("src/modules/mid/a.ts", `import { x } from "@/modules/low/internal";`)])).toEqual(["deep-import"]);
    expect(rules([file("src/app/page.tsx", `import { x } from "@/modules/mid/calendar";`)])).toEqual(["deep-import"]);
  });

  it("وابستگی اعلام‌نشده و رو به بالا", () => {
    expect(rules([file("src/modules/low/a.ts", `import { x } from "@/modules/mid";`)])).toEqual(["undeclared-dependency"]);
    expect(rules([file("src/modules/mid/a.ts", `import { x } from "@/modules/high";`)])).toEqual(["undeclared-dependency"]);
  });

  it("ماژول ناشناخته", () => {
    expect(rules([file("src/modules/mid/a.ts", `import { x } from "@/modules/ghost";`)])).toEqual(["unknown-module"]);
  });

  it("خروج از ماژول با import نسبی", () => {
    expect(rules([file("src/modules/mid/a.ts", `import { x } from "../low/index";`)])).toEqual(["escapes-module"]);
    expect(rules([file("src/modules/mid/sub/a.ts", `import { x } from "../b";`)])).toEqual([]);
  });

  it("ماژول خالص نباید I/O یا فریم‌ورک import کند", () => {
    expect(rules([file("src/modules/mid/a.ts", `import fs from "node:fs";`)])).toEqual(["impure-import"]);
    expect(rules([file("src/modules/mid/a.ts", `import { db } from "@/db";`)])).toEqual(["impure-import"]);
    expect(rules([file("src/modules/mid/a.ts", `import React from "react";`)])).toEqual(["impure-import"]);
    expect(rules([file("src/modules/high/a.ts", `import fs from "node:fs";`)])).toEqual([]); // ناخالص مجاز است
  });

  it("registry: وابستگی دایره‌ای، رو به بالا و ناشناخته", () => {
    const cyc = [mod({ name: "a", dependsOn: ["b"] }), mod({ name: "b", dependsOn: ["a"] })];
    expect(checkRegistry(cyc).map((v) => v.rule)).toContain("cycle");
    const up = [mod({ name: "a", layer: 0, dependsOn: ["b"] }), mod({ name: "b", layer: 2 })];
    expect(checkRegistry(up).map((v) => v.rule)).toContain("upward-dependency");
    expect(checkRegistry([mod({ name: "a", dependsOn: ["zzz"] })]).map((v) => v.rule)).toContain("unknown-dependency");
  });

  it("extractImports انواع import/export/dynamic را می‌شناسد", () => {
    const src = `
      import a from "x1";
      import { b } from 'x2';
      export { c } from "x3";
      export * from "x4";
      const d = await import("x5");
      import "x6";
      import type { T } from "x7";
      // import z from "commented"  (فقط متن)
    `;
    expect(extractImports(src)).toEqual(expect.arrayContaining(["x1", "x2", "x3", "x4", "x5", "x6", "x7"]));
  });
});

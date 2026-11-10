import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function packageJson() {
  return JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  ) as {
    bin?: Record<string, string>;
    scripts?: Record<string, string>;
  };
}

function entryFromBunBuild(script: string) {
  const match = script.match(/bun build(?: --compile)? (\S+)/);
  return match?.[1];
}

describe("package entrypoints", () => {
  test("bin and build scripts point at files that exist", () => {
    const pkg = packageJson();
    const missing: string[] = [];

    for (const target of Object.values(pkg.bin ?? {})) {
      const resolved = path.resolve(repoRoot, target);
      if (!existsSync(resolved)) {
        missing.push(`bin:${target}`);
      }
    }

    for (const name of ["build", "compile"] as const) {
      const script = pkg.scripts?.[name];
      expect(script, `${name} script`).toBeTruthy();
      const entry = entryFromBunBuild(script ?? "");
      expect(entry, `${name} entry`).toBeTruthy();
      const resolved = path.resolve(repoRoot, entry ?? "");
      if (!existsSync(resolved)) {
        missing.push(`${name}:${entry}`);
      }
    }

    expect(missing).toEqual([]);
  });

  test("bun run build exits 0", () => {
    const result = Bun.spawnSync(["bun", "run", "build"], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(
      existsSync(path.join(repoRoot, "dist", "index.js")),
    ).toBe(true);
  });
});

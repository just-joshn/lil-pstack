#!/usr/bin/env bun
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const source =
  process.env.PSTACK_SOURCE ??
  path.join(process.env.HOME ?? "", ".cursor", "plugins", "local", "pstack");
const pluginRoot = path.join(repoRoot, "vendor", "pstack");
const hostRoot = path.join(repoRoot, "vendor", "pstack-host");

if (!existsSync(path.join(source, "plugin.json"))) {
  throw new Error(`pstack source not found at ${source}`);
}

mkdirSync(path.dirname(pluginRoot), { recursive: true });

const rsync = Bun.spawn(
  [
    "rsync",
    "-a",
    "--delete",
    "--exclude",
    "node_modules",
    "--exclude",
    ".DS_Store",
    "--exclude",
    "**/node_modules/**",
    `${source}/`,
    `${pluginRoot}/`,
  ],
  { stdout: "inherit", stderr: "inherit" },
);
const rsyncCode = await rsync.exited;
if (rsyncCode !== 0) {
  throw new Error(`rsync failed with exit code ${rsyncCode}`);
}

const plugin = JSON.parse(
  readFileSync(path.join(pluginRoot, "plugin.json"), "utf8"),
) as {
  name?: string;
  version?: string;
};

writeFileSync(
  path.join(pluginRoot, "VENDOR.json"),
  `${JSON.stringify(
    {
      name: plugin.name ?? "pstack",
      version: plugin.version ?? "unknown",
      sourcePath: source,
      syncedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
);

rebuildHost(pluginRoot, hostRoot);
console.log(`synced pstack ${plugin.version ?? "unknown"} -> ${pluginRoot}`);
console.log(`host workspace -> ${hostRoot}`);

function rebuildHost(plugin: string, host: string) {
  const skillsDir = path.join(host, ".cursor", "skills");
  const agentsDir = path.join(host, ".cursor", "agents");
  const rulesDir = path.join(host, ".cursor", "rules");

  mkdirSync(skillsDir, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(path.dirname(rulesDir), { recursive: true });

  clearDirectory(skillsDir);
  clearDirectory(agentsDir);
  if (existsSync(rulesDir)) {
    clearDirectory(rulesDir);
    rmSync(rulesDir, { recursive: true, force: true });
  }

  for (const entry of readdirSync(path.join(plugin, "skills"), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const target = path.join(skillsDir, entry.name);
    const relative = path.relative(
      skillsDir,
      path.join(plugin, "skills", entry.name),
    );
    symlinkSync(relative, target);
  }

  for (const entry of readdirSync(path.join(plugin, "agents"))) {
    if (!entry.endsWith(".md")) {
      continue;
    }
    const target = path.join(agentsDir, entry);
    const relative = path.relative(
      agentsDir,
      path.join(plugin, "agents", entry),
    );
    symlinkSync(relative, target);
  }
}

function clearDirectory(dir: string) {
  for (const entry of readdirSync(dir)) {
    rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

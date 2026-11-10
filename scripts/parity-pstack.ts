#!/usr/bin/env bun
/**
 * Rerunnable pstack feature-parity checks for lil-pstack.
 * Compares the vendored plugin to the local Cursor source when present,
 * and checks the always-on poteto wiring that replaces /poteto-mode.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadPstackAgents,
  resolvePstackPaths,
  wrapPromptWithAlwaysOnPoteto,
} from "../src/pstack.ts";

type Check = { name: string; ok: boolean; detail: string };

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sourceRoot =
  process.env.PSTACK_SOURCE ??
  path.join(process.env.HOME ?? "", ".cursor", "plugins", "local", "pstack");

const EXPECTED_PLAYBOOKS = 23;
const EXPECTED_AGENTS = ["poteto-agent", "comment-sicko"] as const;
const SOFT_EXTERNAL = [
  {
    name: "create-skill",
    path: path.join(
      process.env.HOME ?? "",
      ".cursor",
      "skills-cursor",
      "create-skill",
      "SKILL.md",
    ),
    required: false,
    note: "Cursor built-in; authoring-a-skill playbook reads it when present",
  },
] as const;

function listSkillDirs(root: string) {
  const skills = path.join(root, "skills");
  if (!existsSync(skills)) {
    return [] as string[];
  }
  return readdirSync(skills, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function listPlaybooks(pluginRoot: string) {
  const dir = path.join(pluginRoot, "skills", "poteto-mode", "playbooks");
  if (!existsSync(dir)) {
    return [] as string[];
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort();
}

function listAgentNames(pluginRoot: string) {
  const dir = path.join(pluginRoot, "agents");
  if (!existsSync(dir)) {
    return [] as string[];
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.replace(/\.md$/, ""))
    .sort();
}

function check(name: string, ok: boolean, detail: string): Check {
  return { name, ok, detail };
}

function main() {
  const paths = resolvePstackPaths(repoRoot);
  const checks: Check[] = [];

  checks.push(
    check(
      "vendor-plugin-json",
      existsSync(path.join(paths.pluginRoot, "plugin.json")),
      paths.pluginRoot,
    ),
  );
  checks.push(
    check(
      "poteto-skill",
      existsSync(paths.potetoSkillPath),
      paths.potetoSkillPath,
    ),
  );
  checks.push(
    check(
      "vendor-version",
      paths.version !== "unknown" && paths.version.length > 0,
      paths.version,
    ),
  );

  const vendorSkills = listSkillDirs(paths.pluginRoot);
  checks.push(
    check(
      "skill-count",
      vendorSkills.length === 58,
      `${vendorSkills.length} skills`,
    ),
  );

  const playbooks = listPlaybooks(paths.pluginRoot);
  checks.push(
    check(
      "playbook-count",
      playbooks.length === EXPECTED_PLAYBOOKS,
      `${playbooks.length}/${EXPECTED_PLAYBOOKS}`,
    ),
  );

  const agentNames = listAgentNames(paths.pluginRoot);
  for (const agent of EXPECTED_AGENTS) {
    checks.push(
      check(`agent-${agent}`, agentNames.includes(agent), agentNames.join(",")),
    );
  }

  const hostSkills = path.join(paths.hostRoot, ".cursor", "skills");
  const hostAgents = path.join(paths.hostRoot, ".cursor", "agents");
  const hostRule = path.join(
    paths.hostRoot,
    ".cursor",
    "rules",
    "pstack-always-on.mdc",
  );
  checks.push(check("host-skills-dir", existsSync(hostSkills), hostSkills));
  checks.push(check("host-agents-dir", existsSync(hostAgents), hostAgents));
  checks.push(check("host-always-on-rule", existsSync(hostRule), hostRule));

  const missingHostSkills = vendorSkills.filter(
    (name) => !existsSync(path.join(hostSkills, name)),
  );
  checks.push(
    check(
      "host-skill-symlinks",
      missingHostSkills.length === 0,
      missingHostSkills.length === 0
        ? `${vendorSkills.length} linked`
        : `missing ${missingHostSkills.join(",")}`,
    ),
  );

  const potetoHost = path.join(hostSkills, "poteto-mode");
  if (existsSync(potetoHost)) {
    const linked =
      realpathSync(potetoHost) ===
      realpathSync(path.join(paths.pluginRoot, "skills", "poteto-mode"));
    checks.push(check("host-poteto-realpath", linked, potetoHost));
  } else {
    checks.push(check("host-poteto-realpath", false, "missing"));
  }

  const scriptsDir = path.join(
    paths.pluginRoot,
    "skills",
    "poteto-mode",
    "scripts",
  );
  checks.push(
    check(
      "poteto-scripts-manifest",
      existsSync(path.join(scriptsDir, "package.json")) &&
        existsSync(path.join(scriptsDir, "bun.lock")) &&
        existsSync(path.join(scriptsDir, "bootstrap.ts")),
      scriptsDir,
    ),
  );

  if (existsSync(path.join(sourceRoot, "plugin.json"))) {
    const sourceSkills = listSkillDirs(sourceRoot);
    const onlySource = sourceSkills.filter((n) => !vendorSkills.includes(n));
    const onlyVendor = vendorSkills.filter((n) => !sourceSkills.includes(n));
    checks.push(
      check(
        "source-skill-inventory",
        onlySource.length === 0 && onlyVendor.length === 0,
        onlySource.length === 0 && onlyVendor.length === 0
          ? `match ${sourceSkills.length}`
          : `source-only=${onlySource.join(",") || "-"} vendor-only=${onlyVendor.join(",") || "-"}`,
      ),
    );

    const sourcePlaybooks = listPlaybooks(sourceRoot);
    checks.push(
      check(
        "source-playbook-inventory",
        sourcePlaybooks.join("\0") === playbooks.join("\0"),
        `${sourcePlaybooks.length} vs ${playbooks.length}`,
      ),
    );

    const sourceAgents = listAgentNames(sourceRoot);
    checks.push(
      check(
        "source-agent-inventory",
        sourceAgents.join("\0") === agentNames.join("\0"),
        `${sourceAgents.join(",")} vs ${agentNames.join(",")}`,
      ),
    );
  } else {
    checks.push(
      check(
        "source-skill-inventory",
        true,
        `skip: source missing at ${sourceRoot}`,
      ),
    );
  }

  const wrapped = wrapPromptWithAlwaysOnPoteto(
    "fix the scroll bug",
    paths.potetoSkillPath,
  );
  checks.push(
    check(
      "always-on-no-slash-required",
      wrapped.includes("slash command is not required") &&
        !/^\/poteto-mode/m.test(wrapped),
      "wrapper text",
    ),
  );
  checks.push(
    check(
      "always-on-skill-body",
      wrapped.includes('<skill name="poteto-mode"') &&
        wrapped.includes("Non-negotiables") &&
        wrapped.includes("User task:") &&
        wrapped.includes("fix the scroll bug"),
      "skill body injected",
    ),
  );
  checks.push(
    check(
      "always-on-absolute-path",
      wrapped.includes(paths.potetoSkillPath),
      paths.potetoSkillPath,
    ),
  );

  const agents = loadPstackAgents(repoRoot);
  for (const agent of EXPECTED_AGENTS) {
    const def = agents[agent];
    checks.push(
      check(
        `loaded-agent-${agent}`,
        Boolean(def?.description && def.prompt),
        def ? "ok" : "missing",
      ),
    );
  }

  for (const soft of SOFT_EXTERNAL) {
    const present = existsSync(soft.path);
    checks.push(
      check(
        `soft-dep-${soft.name}`,
        soft.required ? present : true,
        present ? `present (${soft.note})` : `absent (${soft.note})`,
      ),
    );
  }

  const cursorTeamKitRefs = [
    path.join(paths.pluginRoot, "skills", "poteto-mode", "SKILL.md"),
  ].filter(
    (p) => existsSync(p) && readFileSync(p, "utf8").includes("cursor-team-kit"),
  );
  checks.push(
    check(
      "soft-dep-cursor-team-kit",
      true,
      cursorTeamKitRefs.length > 0
        ? "referenced by poteto-mode; optional external plugin (deslop/control-*), same soft dep as Cursor CLI"
        : "not referenced",
    ),
  );

  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) {
    const mark = c.ok ? "PASS" : "FAIL";
    console.log(`${mark}\t${c.name}\t${c.detail}`);
  }
  console.log(
    `\n${checks.length - failed.length}/${checks.length} passed; version=${paths.version}`,
  );

  if (failed.length > 0) {
    process.exit(1);
  }
}

main();

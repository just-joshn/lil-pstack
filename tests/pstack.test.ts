import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { buildPrompt } from "../src/agent.ts";
import {
  loadPstackAgents,
  pstackLocalOptions,
  resolvePstackPaths,
  wrapPromptWithAlwaysOnPoteto,
} from "../src/pstack.ts";

describe("vendored pstack", () => {
  test("plugin and poteto skill exist", () => {
    const paths = resolvePstackPaths();
    expect(existsSync(path.join(paths.pluginRoot, "plugin.json"))).toBe(true);
    expect(existsSync(paths.potetoSkillPath)).toBe(true);
    expect(paths.version).toBe("0.15.36");
  });

  test("host skill symlink resolves to vendored poteto-mode", () => {
    const paths = resolvePstackPaths();
    const hostSkill = path.join(
      paths.hostRoot,
      ".cursor",
      "skills",
      "poteto-mode",
    );
    expect(existsSync(hostSkill)).toBe(true);
    expect(realpathSync(hostSkill)).toBe(
      realpathSync(path.join(paths.pluginRoot, "skills", "poteto-mode")),
    );
  });

  test("local options mount the pstack host workspace", () => {
    const cwd = "/tmp/lil-pstack-workspace";
    const options = pstackLocalOptions(cwd);
    expect(options.cwd).toBe(path.resolve(cwd));
    expect(options.dirs).toContain(path.resolve(cwd));
    expect(options.dirs).toContain(resolvePstackPaths().hostRoot);
    expect(options.settingSources).toEqual(["project", "user", "plugins"]);
  });

  test("always-on wrapper injects poteto skill body without requiring a slash", () => {
    const paths = resolvePstackPaths();
    const wrapped = wrapPromptWithAlwaysOnPoteto(
      "fix the scroll bug",
      paths.potetoSkillPath,
    );
    expect(wrapped).toContain("slash command is not required");
    expect(wrapped).toContain(paths.potetoSkillPath);
    expect(wrapped).toContain('<skill name="poteto-mode"');
    expect(wrapped).toContain("User task:");
    expect(wrapped).toContain("fix the scroll bug");
    expect(wrapped).not.toMatch(/^\/poteto-mode/m);
  });

  test("buildPrompt keeps always-on poteto on every send", () => {
    const prompt = buildPrompt("refactor the parser");
    expect(prompt).toContain("refactor the parser");
    expect(prompt).toContain("poteto-mode is always on");
    expect(prompt).toContain(resolvePstackPaths().potetoSkillPath);
  });

  test("loadPstackAgents includes poteto-agent", () => {
    const agents = loadPstackAgents();
    expect(agents["poteto-agent"]?.description.length).toBeGreaterThan(0);
    expect(agents["poteto-agent"]?.prompt.length).toBeGreaterThan(0);
    expect(agents["comment-sicko"]?.prompt.length).toBeGreaterThan(0);
  });

  test("host exposes every vendored skill and both agents", () => {
    const paths = resolvePstackPaths();
    const skillsRoot = path.join(paths.pluginRoot, "skills");
    const hostSkills = path.join(paths.hostRoot, ".cursor", "skills");
    const hostAgents = path.join(paths.hostRoot, ".cursor", "agents");
    const skillNames = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(skillNames.length).toBe(58);
    for (const name of skillNames) {
      expect(existsSync(path.join(hostSkills, name))).toBe(true);
    }
    expect(existsSync(path.join(hostAgents, "poteto-agent.md"))).toBe(true);
    expect(existsSync(path.join(hostAgents, "comment-sicko.md"))).toBe(true);
    expect(
      existsSync(
        path.join(paths.hostRoot, ".cursor", "rules", "pstack-always-on.mdc"),
      ),
    ).toBe(true);
  });

  test("poteto-mode ships all 23 playbooks", () => {
    const playbooks = path.join(
      resolvePstackPaths().pluginRoot,
      "skills",
      "poteto-mode",
      "playbooks",
    );
    const files = readdirSync(playbooks).filter((name) => name.endsWith(".md"));
    expect(files.length).toBe(23);
  });
});

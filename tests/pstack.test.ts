import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { buildPrompt } from "../src/agent.ts";
import { getSlashCommand } from "../src/commands.ts";
import {
  loadPstackAgents,
  pstackLocalOptions,
  readSkillBlock,
  resolvePstackPaths,
  resolveSlashSkillPath,
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

  test("slash skill names resolve to vendored SKILL.md files", () => {
    const paths = resolvePstackPaths();
    const help = resolveSlashSkillPath("/poteto-help how do I start");
    expect(help?.name).toBe("poteto-help");
    expect(help?.skillPath).toBe(
      path.join(paths.pluginRoot, "skills", "poteto-help", "SKILL.md"),
    );
    expect(resolveSlashSkillPath("/not-a-real-skill please")).toBeUndefined();
  });

  test("slash skill invocation attaches that skill without dropping always-on poteto", () => {
    const wrapped = wrapPromptWithAlwaysOnPoteto(
      "/how explain the prompt wrapper",
    );
    expect(wrapped).toContain('<skill name="how"');
    expect(wrapped).toContain('<skill name="poteto-mode"');
    expect(wrapped).toContain("User task:");
    expect(wrapped).toContain("/how explain the prompt wrapper");
  });

  test("slash poteto-mode does not attach the poteto skill twice", () => {
    const wrapped = wrapPromptWithAlwaysOnPoteto("/poteto-mode fix the bug");
    expect(wrapped.match(/<skill name="poteto-mode"/g)?.length).toBe(1);
  });

  test("local TUI commands stay local while plugin slashes are not local", () => {
    expect(getSlashCommand("/help")).toBe("/help");
    expect(getSlashCommand("/model")).toBe("/model");
    expect(getSlashCommand("/poteto-help")).toBeUndefined();
    expect(getSlashCommand("/how explain")).toBeUndefined();
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
    ).toBe(false);
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

describe("pstack paths outside the vendored tree", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function tempRepo() {
    const root = mkdtempSync(path.join(tmpdir(), "lil-pstack-"));
    roots.push(root);
    return root;
  }

  test("a repo without the vendor tree has no agents and an unknown version", () => {
    const root = tempRepo();
    const paths = resolvePstackPaths(root);
    expect(paths.version).toBe("unknown");
    expect(loadPstackAgents(root)).toEqual({});
    expect(pstackLocalOptions("/tmp/work", root).dirs).toEqual([
      path.resolve("/tmp/work"),
    ]);
    expect(
      readSkillBlock("poteto-mode", paths.potetoSkillPath),
    ).toBeUndefined();
    expect(
      wrapPromptWithAlwaysOnPoteto("fix it", paths.potetoSkillPath),
    ).toContain(`Read and follow poteto-mode at: ${paths.potetoSkillPath}`);
  });

  test("version falls back from VENDOR.json to plugin.json to unknown", () => {
    const vendor = tempRepo();
    const plugin = path.join(vendor, "vendor", "pstack");
    mkdirSync(plugin, { recursive: true });
    expect(resolvePstackPaths(vendor).version).toBe("unknown");

    writeFileSync(path.join(plugin, "plugin.json"), "{");
    expect(resolvePstackPaths(vendor).version).toBe("unknown");

    writeFileSync(
      path.join(plugin, "plugin.json"),
      JSON.stringify({ version: "1.2.3" }),
    );
    expect(resolvePstackPaths(vendor).version).toBe("1.2.3");

    writeFileSync(
      path.join(plugin, "VENDOR.json"),
      JSON.stringify({ version: "9.9.9" }),
    );
    expect(resolvePstackPaths(vendor).version).toBe("9.9.9");
  });

  test("agent files without a usable frontmatter are skipped", () => {
    const root = tempRepo();
    const agents = path.join(root, "vendor", "pstack", "agents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(path.join(agents, "notes.txt"), "ignore");
    writeFileSync(path.join(agents, "plain.md"), "no frontmatter");
    writeFileSync(
      path.join(agents, "broken.md"),
      "---\nname: only-name\n---\nbody\n",
    );
    writeFileSync(
      path.join(agents, "empty.md"),
      "---\nname: empty\ndescription: blank\n---\n",
    );
    writeFileSync(
      path.join(agents, "ready.md"),
      "---\nname: \"ready\"\ndescription: 'does work'\n---\nDo the work.\n",
    );

    expect(loadPstackAgents(root)).toEqual({
      ready: { description: "does work", prompt: "Do the work." },
    });
  });

  test("a skill file without a body or a closing frontmatter is not injected", () => {
    const root = tempRepo();
    const skill = path.join(root, "SKILL.md");
    writeFileSync(skill, "---\nname: poteto-mode\n---\n");
    expect(readSkillBlock("poteto-mode", skill)).toBeUndefined();
    expect(wrapPromptWithAlwaysOnPoteto("task", skill)).toContain(
      "Read and follow poteto-mode",
    );

    writeFileSync(skill, "---\nname: poteto-mode\n");
    expect(readSkillBlock("poteto-mode", skill)).toContain(
      "---\nname: poteto-mode",
    );

    writeFileSync(skill, "Follow the playbook.\n");
    const block = readSkillBlock("poteto-mode", skill);
    expect(block).toContain("Follow the playbook.");
    expect(block).toContain('<skill name="poteto-mode"');
  });

  test("local options omit the host directory when the workspace is the host", () => {
    const root = tempRepo();
    const host = path.join(root, "vendor", "pstack-host");
    mkdirSync(host, { recursive: true });
    const options = pstackLocalOptions(host, root);
    expect(options.dirs).toEqual([path.resolve(host)]);
  });
});

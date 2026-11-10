import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentDefinition,
  LocalAgentOptions,
  SettingSource,
} from "@cursor/sdk";

export type PstackPaths = {
  pluginRoot: string;
  hostRoot: string;
  potetoSkillPath: string;
  version: string;
};

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const DEFAULT_SETTING_SOURCES: SettingSource[] = ["project", "user", "plugins"];

export function resolvePackageRoot(repoRoot = PACKAGE_ROOT) {
  return path.resolve(repoRoot);
}

export function resolvePstackPaths(repoRoot = PACKAGE_ROOT): PstackPaths {
  const pluginRoot = path.join(
    resolvePackageRoot(repoRoot),
    "vendor",
    "pstack",
  );
  const hostRoot = path.join(
    resolvePackageRoot(repoRoot),
    "vendor",
    "pstack-host",
  );
  const potetoSkillPath = path.join(
    pluginRoot,
    "skills",
    "poteto-mode",
    "SKILL.md",
  );
  const version = readVendorVersion(pluginRoot);
  return { pluginRoot, hostRoot, potetoSkillPath, version };
}

export function pstackLocalOptions(
  cwd: string,
  repoRoot = PACKAGE_ROOT,
): Pick<LocalAgentOptions, "cwd" | "dirs" | "settingSources"> {
  const { hostRoot } = resolvePstackPaths(repoRoot);
  const resolvedCwd = path.resolve(cwd);
  const dirs = [resolvedCwd];
  if (existsSync(hostRoot) && path.resolve(hostRoot) !== resolvedCwd) {
    dirs.push(path.resolve(hostRoot));
  }
  return {
    cwd: resolvedCwd,
    dirs,
    settingSources: DEFAULT_SETTING_SOURCES,
  };
}

export function loadPstackAgents(
  repoRoot = PACKAGE_ROOT,
): Record<string, AgentDefinition> {
  const agentsDir = path.join(
    resolvePstackPaths(repoRoot).pluginRoot,
    "agents",
  );
  if (!existsSync(agentsDir)) {
    return {};
  }

  const agents: Record<string, AgentDefinition> = {};
  for (const entry of readdirSync(agentsDir)) {
    if (!entry.endsWith(".md")) {
      continue;
    }
    const parsed = parseAgentMarkdown(
      readFileSync(path.join(agentsDir, entry), "utf8"),
    );
    if (parsed) {
      agents[parsed.name] = {
        description: parsed.description,
        prompt: parsed.prompt,
      };
    }
  }
  return agents;
}

export function wrapPromptWithAlwaysOnPoteto(
  userPrompt: string,
  potetoSkillPath = resolvePstackPaths().potetoSkillPath,
) {
  const skill = readSkillBlock("poteto-mode", potetoSkillPath);
  const parts = [
    "pstack poteto-mode is always on for this session. A slash command is not required.",
    "Treat the user task below as a /poteto-mode invocation.",
    "Match a playbook, open its todos, and read other pstack skills as poteto-mode directs.",
    `Put this absolute path in every poteto-agent Task prompt: ${potetoSkillPath}`,
  ];

  if (skill) {
    parts.push("", skill);
  } else {
    parts.push("", `Read and follow poteto-mode at: ${potetoSkillPath}`);
  }

  parts.push("", "User task:", userPrompt);
  return parts.join("\n");
}

export function readSkillBlock(name: string, skillPath: string) {
  if (!existsSync(skillPath)) {
    return undefined;
  }
  const body = stripFrontmatter(readFileSync(skillPath, "utf8")).trim();
  if (!body) {
    return undefined;
  }
  return [
    `<skill name="${name}" location="${skillPath}">`,
    `References are relative to ${path.dirname(skillPath)}.`,
    "",
    body,
    "</skill>",
  ].join("\n");
}

function readVendorVersion(pluginRoot: string) {
  const vendorPath = path.join(pluginRoot, "VENDOR.json");
  if (existsSync(vendorPath)) {
    try {
      const vendor = JSON.parse(readFileSync(vendorPath, "utf8")) as {
        version?: string;
      };
      if (vendor.version) {
        return vendor.version;
      }
    } catch {
      // fall through to plugin.json
    }
  }

  const pluginPath = path.join(pluginRoot, "plugin.json");
  if (!existsSync(pluginPath)) {
    return "unknown";
  }
  try {
    const plugin = JSON.parse(readFileSync(pluginPath, "utf8")) as {
      version?: string;
    };
    return plugin.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function parseAgentMarkdown(source: string) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return undefined;
  }

  const frontmatter = match[1] ?? "";
  const body = (match[2] ?? "").trim();
  const name = readFrontmatterValue(frontmatter, "name");
  const description = readFrontmatterValue(frontmatter, "description");
  if (!name || !description || !body) {
    return undefined;
  }

  return { name, description, prompt: body };
}

function readFrontmatterValue(frontmatter: string, key: string) {
  const line = frontmatter
    .split(/\r?\n/)
    .find((entry) => entry.startsWith(`${key}:`));
  if (!line) {
    return undefined;
  }
  return line
    .slice(key.length + 1)
    .trim()
    .replace(/^["']|["']$/g, "");
}

function stripFrontmatter(source: string) {
  if (!source.startsWith("---")) {
    return source;
  }
  const match = source.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  return match?.[1] ?? source;
}

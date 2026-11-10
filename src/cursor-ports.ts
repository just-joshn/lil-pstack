import { execFileSync } from "node:child_process";
import { Agent, Cursor, type SDKAgent } from "@cursor/sdk";
import type { AgentClient, AgentPorts, OpenAgentSpec } from "./agent.js";

export const cursorPorts: AgentPorts = {
  listModels: (apiKey) => Cursor.models.list({ apiKey }),
  openAgent: (spec) => openAgent(spec),
  git: (cwd, args) => runGit(cwd, args),
};

async function openAgent(spec: OpenAgentSpec): Promise<AgentClient> {
  const agent = await Agent.create(createOptions(spec));
  return wrapAgent(agent);
}

function createOptions(spec: OpenAgentSpec) {
  const options = {
    apiKey: spec.apiKey,
    name: spec.name,
    model: spec.model,
    agents: spec.agents,
  };

  if (spec.place.kind === "cloud") {
    return {
      ...options,
      cloud: { repos: [spec.place.repository] },
    };
  }

  return {
    ...options,
    local: {
      cwd: spec.place.cwd,
      dirs: spec.place.dirs,
      settingSources: spec.place.settingSources,
    },
  };
}

function wrapAgent(agent: SDKAgent): AgentClient {
  return {
    send(prompt, request) {
      return agent.send(prompt, {
        ...(request.model ? { model: request.model } : {}),
        ...(request.force ? { local: { force: true } } : {}),
      });
    },
    dispose: () => agent[Symbol.asyncDispose](),
  };
}

function runGit(cwd: string, args: string[]) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

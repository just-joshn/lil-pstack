#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "@cursor/sdk";
import {
  loadPstackAgents,
  pstackLocalOptions,
  resolvePstackPaths,
  wrapPromptWithAlwaysOnPoteto,
} from "../src/pstack.ts";

const POTETO_AGENT_TYPE = "poteto-agent";

const USER_TASK = [
  "Plan two stacked PRs for the TUI.",
  "The first PR adds a status footer that shows the active run id and elapsed time.",
  "The second PR adds a pause control that depends on that footer.",
  "This is a multi-phase plan, not an implementation.",
  "Do the matched playbook's explore step in subagents, then stop.",
  "Do not edit application source.",
  "Do not write the plan file.",
].join(" ");

type TaskObservationSource = "assistant_tool_use" | "sdk_tool_call";

type TaskLaunch = {
  readonly source: TaskObservationSource;
  readonly toolName: string;
  readonly subagentType: string;
  readonly callId: string | undefined;
};

type TaskObserveResult = {
  readonly launch: TaskLaunch | undefined;
  readonly truncatedWithoutType: boolean;
};

type LiveReport = {
  readonly status: string;
  readonly durationMs: number | undefined;
  readonly version: string;
  readonly launches: readonly TaskLaunch[];
  readonly truncatedTaskArgs: number;
  readonly ok: boolean;
};

function readSubagentType(args: unknown): string | undefined {
  if (!args || typeof args !== "object") {
    return undefined;
  }
  const record = args as Record<string, unknown>;
  for (const key of ["subagent_type", "subagentType"] as const) {
    const value = record[key];
    if (typeof value === "string") {
      if (value.length > 0) {
        return value;
      }
      continue;
    }
    if (value && typeof value === "object") {
      const name = (value as Record<string, unknown>).name;
      if (typeof name === "string" && name.length > 0) {
        return name;
      }
    }
  }
  return undefined;
}

function observeTaskArgs(
  source: TaskObservationSource,
  name: string,
  args: unknown,
  callId: string | undefined,
  truncatedArgs: boolean | undefined,
): TaskObserveResult {
  if (name.toLowerCase() !== "task") {
    return { launch: undefined, truncatedWithoutType: false };
  }
  const subagentType = readSubagentType(args);
  if (subagentType) {
    return {
      launch: { source, toolName: name, subagentType, callId },
      truncatedWithoutType: false,
    };
  }
  return {
    launch: undefined,
    truncatedWithoutType: truncatedArgs === true,
  };
}

function provePotetoAgentLaunch(
  status: string,
  launches: readonly TaskLaunch[],
): boolean {
  return (
    status === "finished" &&
    launches.some((launch) => launch.subagentType === POTETO_AGENT_TYPE)
  );
}

function formatReport(report: LiveReport, assistantText: string): string {
  const potetoAgentLaunchCount = report.launches.filter(
    (launch) => launch.subagentType === POTETO_AGENT_TYPE,
  ).length;
  return [
    `status=${report.status}`,
    `durationMs=${report.durationMs}`,
    `version=${report.version}`,
    `settingSources=project`,
    `launchCount=${report.launches.length}`,
    `potetoAgentLaunchCount=${potetoAgentLaunchCount}`,
    `truncatedTaskArgs=${report.truncatedTaskArgs}`,
    `launches=${JSON.stringify(report.launches)}`,
    "",
    assistantText.trim(),
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) {
    throw new Error("Set CURSOR_API_KEY to run the live poteto-agent check.");
  }

  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const outDir = path.join(repoRoot, ".audit");
  const outPath = path.join(outDir, "live-poteto-agent.txt");
  const paths = resolvePstackPaths(repoRoot);
  const prompt = wrapPromptWithAlwaysOnPoteto(USER_TASK, paths.potetoSkillPath);
  const agents = loadPstackAgents(repoRoot);
  const potetoAgent = agents["poteto-agent"];
  if (!potetoAgent || potetoAgent.prompt.length === 0) {
    throw new Error(
      "loadPstackAgents is missing poteto-agent or its prompt is empty.",
    );
  }

  const agent = await Agent.create({
    apiKey,
    name: "lil-pstack-live-poteto-agent",
    model: { id: process.env.CURSOR_MODEL ?? "composer-2" },
    agents,
    local: {
      ...pstackLocalOptions(repoRoot, repoRoot),
      settingSources: ["project"],
    },
  });

  const launches: TaskLaunch[] = [];
  let truncatedTaskArgs = 0;
  const textChunks: string[] = [];

  function record(observed: TaskObserveResult) {
    if (observed.launch) {
      launches.push(observed.launch);
    }
    if (observed.truncatedWithoutType) {
      truncatedTaskArgs += 1;
    }
  }

  try {
    const run = await agent.send(prompt, {
      local: { force: true },
    });
    for await (const event of run.stream()) {
      if (event.type === "assistant") {
        for (const block of event.message.content) {
          if (block.type === "text") {
            textChunks.push(block.text);
          } else if (block.type === "tool_use") {
            record(
              observeTaskArgs(
                "assistant_tool_use",
                block.name,
                block.input,
                block.id,
                undefined,
              ),
            );
          }
        }
      } else if (event.type === "tool_call") {
        record(
          observeTaskArgs(
            "sdk_tool_call",
            event.name,
            event.args,
            event.call_id,
            event.truncated?.args,
          ),
        );
      }
    }
    const result = await run.wait();
    const ok = provePotetoAgentLaunch(result.status, launches);
    const report = formatReport(
      {
        status: result.status,
        durationMs: result.durationMs,
        version: paths.version,
        launches,
        truncatedTaskArgs,
        ok,
      },
      textChunks.join(""),
    );
    mkdirSync(outDir, { recursive: true });
    writeFileSync(outPath, report);
    console.log(report);
    console.log(ok ? "LIVE_PASS" : "LIVE_FAIL");
    if (!ok) {
      process.exit(1);
    }
  } finally {
    await agent[Symbol.asyncDispose]();
  }
}

void main();

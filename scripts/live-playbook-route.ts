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

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const outDir = path.join(repoRoot, ".audit");
const outPath = path.join(outDir, "live-playbook-route.txt");
const expectedPlaybook = "runtime-forensics.md";

const apiKey = process.env.CURSOR_API_KEY;
if (!apiKey) {
  throw new Error("Set CURSOR_API_KEY to run the live playbook-route check.");
}

const paths = resolvePstackPaths(repoRoot);
const userTask = [
  "There is an idle-CPU spin in the OpenTUI scroll path when the terminal is idle.",
  "Diagnose it with live instrumentation evidence.",
  "Stop as soon as you have matched a poteto-mode playbook, opened its todos, and read that playbook file.",
  "Do not edit application source files.",
  "Do not spawn subagents.",
].join(" ");

const prompt = wrapPromptWithAlwaysOnPoteto(userTask, paths.potetoSkillPath);

const agent = await Agent.create({
  apiKey,
  name: "lil-pstack-live-playbook-route",
  model: { id: process.env.CURSOR_MODEL ?? "composer-2" },
  agents: loadPstackAgents(repoRoot),
  local: {
    ...pstackLocalOptions(repoRoot, repoRoot),
    settingSources: ["project"],
  },
});

const toolReads: string[] = [];
const toolNames: string[] = [];
const textChunks: string[] = [];

function collectPath(args: unknown) {
  if (!args || typeof args !== "object") {
    return;
  }
  const record = args as Record<string, unknown>;
  for (const key of [
    "path",
    "filePath",
    "target_file",
    "absolutePath",
    "file",
  ]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      toolReads.push(value);
    }
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
          toolNames.push(block.name);
          collectPath(block.input);
        }
      }
    } else if (event.type === "tool_call") {
      toolNames.push(event.name);
      collectPath(event.args);
    }
  }
  const result = await run.wait();

  const playbookReads = toolReads.filter((entry) =>
    entry.replaceAll("\\", "/").includes(`/playbooks/${expectedPlaybook}`),
  );
  const anyPlaybookRead = toolReads.filter((entry) =>
    /\/playbooks\/[^/]+\.md$/i.test(entry.replaceAll("\\", "/")),
  );

  mkdirSync(outDir, { recursive: true });
  const report = [
    `status=${result.status}`,
    `durationMs=${result.durationMs}`,
    `version=${paths.version}`,
    `settingSources=project`,
    `expectedPlaybook=${expectedPlaybook}`,
    `toolNameCount=${toolNames.length}`,
    `toolReadCount=${toolReads.length}`,
    `playbookReadCount=${anyPlaybookRead.length}`,
    `expectedPlaybookReadCount=${playbookReads.length}`,
    `toolNames=${JSON.stringify(toolNames.slice(0, 40))}`,
    `toolReads=${JSON.stringify(toolReads.slice(0, 40))}`,
    "",
    textChunks.join("").trim(),
    "",
  ].join("\n");
  writeFileSync(outPath, report);

  const ok = result.status === "finished" && playbookReads.length > 0;

  console.log(report);
  console.log(ok ? "LIVE_PASS" : "LIVE_FAIL");
  if (!ok) {
    process.exit(1);
  }
} finally {
  await agent[Symbol.asyncDispose]();
}

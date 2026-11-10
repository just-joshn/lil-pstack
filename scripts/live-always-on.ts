#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const outPath = path.join(outDir, "live-always-on.txt");

const apiKey = process.env.CURSOR_API_KEY;
if (!apiKey) {
  throw new Error("Set CURSOR_API_KEY to run the live always-on check.");
}

const paths = resolvePstackPaths(repoRoot);
const skillBody = readFileSync(paths.potetoSkillPath, "utf8");
const afterHeading = skillBody.split("\n# Poteto mode\n")[1] ?? "";
const quoteNeedle = afterHeading
  .split(/\r?\n/)
  .map((line) => line.trim())
  .find((line) => line.length > 0);
if (!quoteNeedle) {
  throw new Error("Could not read the first poteto-mode body sentence.");
}

const userTask = [
  "Do no file edits and do not spawn subagents.",
  'In the poteto-mode skill already in this request, find the first sentence under the heading that is exactly "# Poteto mode".',
  "Reply with that sentence on line 1.",
  "On line 2, print only the absolute poteto-mode SKILL.md path that the always-on instructions say to put in every poteto-agent Task prompt.",
  "Reply with exactly those two lines and nothing else.",
].join(" ");

const prompt = wrapPromptWithAlwaysOnPoteto(userTask, paths.potetoSkillPath);

const agent = await Agent.create({
  apiKey,
  name: "lil-pstack-live-always-on",
  model: { id: process.env.CURSOR_MODEL ?? "composer-2" },
  agents: loadPstackAgents(repoRoot),
  local: {
    ...pstackLocalOptions(repoRoot, repoRoot),
    settingSources: ["project"],
  },
});

const chunks: string[] = [];
try {
  const run = await agent.send(prompt);
  for await (const event of run.stream()) {
    if (event.type === "assistant") {
      for (const block of event.message.content) {
        if (block.type === "text") {
          chunks.push(block.text);
        }
      }
    }
  }
  const result = await run.wait();
  const text = chunks.join("");
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  mkdirSync(outDir, { recursive: true });
  const report = [
    `status=${result.status}`,
    `durationMs=${result.durationMs}`,
    `version=${paths.version}`,
    `potetoSkillPath=${paths.potetoSkillPath}`,
    `lineCount=${lines.length}`,
    `settingSources=project`,
    `expectedLine1=${quoteNeedle}`,
    "",
    text.trim(),
    "",
  ].join("\n");
  writeFileSync(outPath, report);

  const ok =
    result.status === "finished" &&
    lines.length === 2 &&
    lines[0] === quoteNeedle &&
    lines[1] === paths.potetoSkillPath;

  console.log(report);
  console.log(ok ? "LIVE_PASS" : "LIVE_FAIL");
  if (!ok) {
    process.exit(1);
  }
} finally {
  await agent[Symbol.asyncDispose]();
}

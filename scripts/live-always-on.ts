#!/usr/bin/env bun
/**
 * Live proof that a plain-language prompt runs under always-on poteto-mode
 * without a slash command. Writes a short transcript artifact.
 */
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
const outPath = path.join(outDir, "live-always-on.txt");

const apiKey = process.env.CURSOR_API_KEY;
if (!apiKey) {
  throw new Error("Set CURSOR_API_KEY to run the live always-on check.");
}

const paths = resolvePstackPaths(repoRoot);
const userTask =
  "Do no file edits and do not spawn subagents. Reply with exactly three lines then stop:\nPLAYBOOK=<kebab-case playbook name poteto-mode matched for this task>\nSLASH=no\nACTIVE=poteto-mode\nThe task is a read-only question: how does wrapPromptWithAlwaysOnPoteto activate poteto-mode without a slash?";

const prompt = [
  "You are running inside lil-pstack.",
  "Answer only with the three required lines.",
  "",
  wrapPromptWithAlwaysOnPoteto(userTask, paths.potetoSkillPath),
].join("\n");

const agent = await Agent.create({
  apiKey,
  name: "lil-pstack-live-always-on",
  model: { id: process.env.CURSOR_MODEL ?? "composer-2" },
  agents: loadPstackAgents(repoRoot),
  local: pstackLocalOptions(repoRoot, repoRoot),
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
  mkdirSync(outDir, { recursive: true });
  const report = [
    `status=${result.status}`,
    `durationMs=${result.durationMs}`,
    `version=${paths.version}`,
    `potetoSkillPath=${paths.potetoSkillPath}`,
    "",
    text.trim(),
    "",
  ].join("\n");
  writeFileSync(outPath, report);

  const ok =
    result.status === "finished" &&
    /PLAYBOOK=investigation/i.test(text) &&
    /SLASH=no/i.test(text) &&
    /ACTIVE=poteto-mode/i.test(text);

  console.log(report);
  console.log(ok ? "LIVE_PASS" : "LIVE_FAIL");
  if (!ok) {
    process.exit(1);
  }
} finally {
  await agent[Symbol.asyncDispose]();
}

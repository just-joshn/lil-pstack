#!/usr/bin/env bun
import {
  CliRenderEvents,
  type CliRenderer,
  createCliRenderer,
} from "@opentui/core";
import { createRoot } from "@opentui/react";
import React from "react";

import { CodingAgentSession } from "./agent.js";
import { runCli, type CliIo, type TuiLaunch } from "./cli.js";
import { cursorPorts } from "./cursor-ports.js";
import { App } from "./tui/App.js";

async function readStdin() {
  let input = "";
  process.stdin.setEncoding("utf8");

  for await (const chunk of process.stdin) {
    input += chunk;
  }

  return input;
}

async function startTui(input: TuiLaunch) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    maxFps: 30,
    screenMode: "alternate-screen",
  });
  const root = createRoot(renderer);

  try {
    root.render(
      React.createElement(App, {
        apiKey: input.apiKey,
        cwd: input.cwd,
        force: input.force,
        initialModel: input.model,
      }),
    );
    await waitUntilDestroyed(renderer);
  } finally {
    root.unmount();

    if (!renderer.isDestroyed) {
      renderer.destroy();
    }
  }
}

function waitUntilDestroyed(renderer: CliRenderer) {
  if (renderer.isDestroyed) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    renderer.once(CliRenderEvents.DESTROY, () => resolve());
  });
}

const io: CliIo = {
  stdinIsTTY: Boolean(process.stdin.isTTY),
  stdoutIsTTY: Boolean(process.stdout.isTTY),
  readStdin,
  writeStdout: (text) => {
    process.stdout.write(text);
  },
  writeStderr: (text) => {
    process.stderr.write(text);
  },
  startTui,
  openSession: (input) =>
    new CodingAgentSession({
      apiKey: input.apiKey,
      cwd: input.cwd,
      force: input.force,
      model: input.model,
      ports: cursorPorts,
    }),
};

const result = await runCli(process.argv.slice(2), process.env, io);
process.exitCode = result.exitCode;

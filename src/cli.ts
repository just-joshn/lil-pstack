import path from "node:path";
import type { ModelSelection } from "@cursor/sdk";
import { formatDuration, type AgentEvent } from "./agent.js";

export type CliResult = { exitCode: number };

export type TuiLaunch = {
  apiKey: string;
  cwd: string;
  force: boolean;
  model: ModelSelection;
};

export type SessionLaunch = TuiLaunch;

export type CliSession = {
  sendPrompt(input: {
    prompt: string;
    onEvent: (event: AgentEvent) => void;
  }): Promise<void>;
  dispose(): Promise<void>;
};

export type CliIo = {
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  readStdin(): Promise<string>;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
  startTui(input: TuiLaunch): Promise<void>;
  openSession(input: SessionLaunch): CliSession;
};

type CliOptions = {
  cwd: string;
  force: boolean;
  help: boolean;
  model: string;
  prompt: string;
};

const HELP_TEXT = `Lightweight coding agent CLI

Usage:
  code-agent [options] "your task"
  code-agent [options]

Options:
  -C, --cwd <path>       Workspace directory for the local agent. Defaults to cwd.
  -m, --model <id>      Model id. Defaults to CURSOR_MODEL or composer-2.
      --force           Expire a stuck active local run before starting.
  -h, --help            Show this help.

Interactive commands:
  /local                 Run future prompts in the local workspace.
  /cloud                 Run future prompts in Cursor cloud.
  /model                 Open the model picker.
  /reset                 Start a fresh agent in the current execution mode.

Examples:
  code-agent "Explain the auth flow"
  code-agent --cwd ../my-app "Add a regression test for the parser"
  code-agent
  printf "Review the recent changes" | code-agent
`;

export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<CliResult> {
  try {
    const options = parseArgs(argv, {
      cwd: process.cwd(),
      model: env.CURSOR_MODEL ?? "composer-2",
    });

    if (options.help) {
      io.writeStdout(`${HELP_TEXT}\n`);
      return { exitCode: 0 };
    }

    const apiKey = env.CURSOR_API_KEY;
    if (!apiKey) {
      throw new Error("Set CURSOR_API_KEY before running the CLI.");
    }

    if (options.prompt) {
      await runPlainPrompt(apiKey, options, options.prompt, io);
      return { exitCode: 0 };
    }

    if (!io.stdinIsTTY) {
      const prompt = (await io.readStdin()).trim();
      if (!prompt) {
        throw new Error("No prompt provided on stdin.");
      }
      await runPlainPrompt(apiKey, options, prompt, io);
      return { exitCode: 0 };
    }

    if (!io.stdoutIsTTY) {
      throw new Error("Interactive mode requires a TTY stdout.");
    }

    await io.startTui({
      apiKey,
      cwd: options.cwd,
      force: options.force,
      model: { id: options.model },
    });
    return { exitCode: 0 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.writeStderr(`Error: ${message}\n`);
    return { exitCode: 1 };
  }
}

function parseArgs(
  argv: string[],
  defaults: { cwd: string; model: string },
): CliOptions {
  const promptParts: string[] = [];
  let cwd = defaults.cwd;
  let force = false;
  let help = false;
  let model = defaults.model;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }

    if (arg === "--") {
      promptParts.push(...argv.slice(index + 1));
      break;
    }

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg === "--force") {
      force = true;
      continue;
    }

    if (arg === "--cwd" || arg === "-C") {
      cwd = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--cwd=")) {
      cwd = arg.slice("--cwd=".length);
      continue;
    }

    if (arg === "--model" || arg === "-m") {
      model = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length);
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    promptParts.push(arg, ...argv.slice(index + 1));
    break;
  }

  return {
    cwd: path.resolve(cwd),
    force,
    help,
    model,
    prompt: promptParts.join(" ").trim(),
  };
}

function readOptionValue(argv: string[], index: number, option: string) {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`Expected a value after ${option}.`);
  }
  return value;
}

async function runPlainPrompt(
  apiKey: string,
  options: CliOptions,
  prompt: string,
  io: CliIo,
) {
  const session = io.openSession({
    apiKey,
    cwd: options.cwd,
    force: options.force,
    model: { id: options.model },
  });
  let assistantEndedWithNewline = true;

  const annotate = (message: string) => {
    if (!assistantEndedWithNewline) {
      io.writeStderr("\n");
    }
    io.writeStderr(`${message}\n`);
    assistantEndedWithNewline = true;
  };

  try {
    await session.sendPrompt({
      prompt,
      onEvent: (event) => {
        renderPlainEvent(event, annotate, (text) => {
          io.writeStdout(text);
          assistantEndedWithNewline = text.endsWith("\n");
        });
      },
    });
  } finally {
    await session.dispose();
  }
}

function renderPlainEvent(
  event: AgentEvent,
  annotate: (message: string) => void,
  writeAssistant: (text: string) => void,
) {
  switch (event.type) {
    case "assistant_delta":
      writeAssistant(event.text);
      break;
    case "thinking": {
      const text = compactText(event.text);
      if (text) {
        annotate(`[thinking] ${text}`);
      }
      break;
    }
    case "tool":
      annotate(`[tool] ${event.status} ${event.name}`);
      break;
    case "status":
      if (event.status !== "FINISHED") {
        annotate(
          `[status] ${event.status}${event.message ? ` ${event.message}` : ""}`,
        );
      }
      break;
    case "task":
      if (event.text || event.status) {
        annotate(
          `[task] ${compactText([event.status, event.text].filter(Boolean).join(" "))}`,
        );
      }
      break;
    case "result": {
      const details = [
        `status=${event.status}`,
        event.durationMs
          ? `duration=${formatDuration(event.durationMs)}`
          : undefined,
        event.usage?.inputTokens
          ? `input=${event.usage.inputTokens}`
          : undefined,
        event.usage?.outputTokens
          ? `output=${event.usage.outputTokens}`
          : undefined,
      ].filter(Boolean);

      annotate(`[done] ${details.join(" ")}`);
      break;
    }
    default:
      break;
  }
}

function compactText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

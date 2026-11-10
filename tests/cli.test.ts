import { describe, expect, test, vi } from "vitest";
import type { AgentEvent } from "../src/agent.ts";
import {
  runCli,
  type CliIo,
  type SessionLaunch,
  type TuiLaunch,
} from "../src/cli.ts";

const HELP_STDOUT = `Lightweight coding agent CLI

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
\n`;

type RecordedPrompt = {
  prompt: string;
  cwd: string;
  modelId: string;
  force: boolean;
};

function fakeCliIo(options: {
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  stdin?: string;
  onSend?: (
    prompt: string,
    onEvent: (event: AgentEvent) => void,
  ) => Promise<void> | void;
}) {
  let stdout = "";
  let stderr = "";
  const prompts: RecordedPrompt[] = [];
  let disposed = 0;
  let tui: TuiLaunch | undefined;

  const io: CliIo = {
    stdinIsTTY: options.stdinIsTTY,
    stdoutIsTTY: options.stdoutIsTTY,
    readStdin: vi.fn(async () => options.stdin ?? ""),
    writeStdout(text) {
      stdout += text;
    },
    writeStderr(text) {
      stderr += text;
    },
    startTui: vi.fn(async (input: TuiLaunch) => {
      tui = {
        apiKey: input.apiKey,
        cwd: input.cwd,
        force: input.force,
        model: { ...input.model },
      };
    }),
    openSession: vi.fn((input: SessionLaunch) => {
      return {
        sendPrompt: vi.fn(async ({ prompt, onEvent }) => {
          prompts.push({
            prompt,
            cwd: input.cwd,
            modelId: input.model.id,
            force: input.force,
          });
          await options.onSend?.(prompt, onEvent);
        }),
        dispose: vi.fn(async () => {
          disposed += 1;
        }),
      };
    }),
  };

  return {
    io,
    read: () => ({
      stdout,
      stderr,
      prompts,
      disposed,
      tui,
    }),
  };
}

describe("runCli", () => {
  test.for([{ flag: "--help" }, { flag: "-h" }])(
    "$flag writes today's help text and does not launch",
    async ({ flag }) => {
      const harness = fakeCliIo({ stdinIsTTY: true, stdoutIsTTY: true });
      const result = await runCli([flag, "ignored task"], {}, harness.io);

      expect(result.exitCode).toBe(0);
      expect(harness.read().stdout).toBe(HELP_STDOUT);
      expect(harness.read().stdout).not.toContain("/exit");
      expect(harness.read().stdout).not.toContain("/quit");
      expect(harness.io.startTui).not.toHaveBeenCalled();
      expect(harness.io.openSession).not.toHaveBeenCalled();
      expect(harness.io.readStdin).not.toHaveBeenCalled();
    },
  );

  test("missing api key exits 1 without starting the TUI", async () => {
    const harness = fakeCliIo({ stdinIsTTY: false, stdoutIsTTY: true });
    const result = await runCli([], {}, harness.io);

    expect(result.exitCode).toBe(1);
    expect(harness.read().stderr).toBe(
      "Error: Set CURSOR_API_KEY before running the CLI.\n",
    );
    expect(harness.read().tui).toBeUndefined();
    expect(harness.io.openSession).not.toHaveBeenCalled();
  });

  test.for([
    {
      name: "cwd flag",
      argv: ["--cwd", "/tmp/work", "fix the parser"],
      env: { CURSOR_API_KEY: "cursor_test" },
      cwd: "/tmp/work",
      modelId: "composer-2",
      force: false,
      prompt: "fix the parser",
    },
    {
      name: "short cwd",
      argv: ["-C", "/tmp/work", "fix the parser"],
      env: { CURSOR_API_KEY: "cursor_test" },
      cwd: "/tmp/work",
      modelId: "composer-2",
      force: false,
      prompt: "fix the parser",
    },
    {
      name: "cwd equals",
      argv: ["--cwd=/tmp/work", "fix the parser"],
      env: { CURSOR_API_KEY: "cursor_test" },
      cwd: "/tmp/work",
      modelId: "composer-2",
      force: false,
      prompt: "fix the parser",
    },
    {
      name: "model flag",
      argv: ["--model", "gpt-5", "--cwd", "/tmp/work", "fix"],
      env: { CURSOR_API_KEY: "cursor_test", CURSOR_MODEL: "composer-2" },
      cwd: "/tmp/work",
      modelId: "gpt-5",
      force: false,
      prompt: "fix",
    },
    {
      name: "short model",
      argv: ["-m", "gpt-5", "--cwd", "/tmp/work", "fix"],
      env: { CURSOR_API_KEY: "cursor_test" },
      cwd: "/tmp/work",
      modelId: "gpt-5",
      force: false,
      prompt: "fix",
    },
    {
      name: "model equals",
      argv: ["--model=gpt-5", "--cwd", "/tmp/work", "fix"],
      env: { CURSOR_API_KEY: "cursor_test" },
      cwd: "/tmp/work",
      modelId: "gpt-5",
      force: false,
      prompt: "fix",
    },
    {
      name: "force and env model",
      argv: ["--force", "--cwd", "/tmp/work", "fix"],
      env: { CURSOR_API_KEY: "cursor_test", CURSOR_MODEL: "composer-9" },
      cwd: "/tmp/work",
      modelId: "composer-9",
      force: true,
      prompt: "fix",
    },
    {
      name: "end of options",
      argv: ["--cwd", "/tmp/work", "--", "fix", "the", "parser"],
      env: { CURSOR_API_KEY: "cursor_test" },
      cwd: "/tmp/work",
      modelId: "composer-2",
      force: false,
      prompt: "fix the parser",
    },
  ])(
    "$name sends one plain prompt and skips the TUI",
    async ({ argv, env, cwd, modelId, force, prompt }) => {
      const harness = fakeCliIo({ stdinIsTTY: true, stdoutIsTTY: true });
      const result = await runCli(argv, env, harness.io);

      expect(result.exitCode).toBe(0);
      expect(harness.read().prompts).toEqual([{ prompt, cwd, modelId, force }]);
      expect(harness.read().disposed).toBe(1);
      expect(harness.io.startTui).not.toHaveBeenCalled();
      expect(harness.io.readStdin).not.toHaveBeenCalled();
    },
  );

  test("a tty with no prompt starts the TUI once", async () => {
    const harness = fakeCliIo({ stdinIsTTY: true, stdoutIsTTY: true });
    const result = await runCli(
      ["--cwd", "/tmp/work", "--force", "--model", "composer-2"],
      { CURSOR_API_KEY: "cursor_test" },
      harness.io,
    );

    expect(result.exitCode).toBe(0);
    expect(harness.read().tui).toEqual({
      apiKey: "cursor_test",
      cwd: "/tmp/work",
      force: true,
      model: { id: "composer-2" },
    });
    expect(harness.io.openSession).not.toHaveBeenCalled();
  });

  test("stdin supplies the prompt when stdout is not a tty", async () => {
    const harness = fakeCliIo({
      stdinIsTTY: false,
      stdoutIsTTY: false,
      stdin: "  Review the recent changes  \n",
    });
    const result = await runCli(
      ["--cwd", "/tmp/work"],
      { CURSOR_API_KEY: "cursor_test" },
      harness.io,
    );

    expect(result.exitCode).toBe(0);
    expect(harness.read().prompts).toEqual([
      {
        prompt: "Review the recent changes",
        cwd: "/tmp/work",
        modelId: "composer-2",
        force: false,
      },
    ]);
    expect(harness.read().tui).toBeUndefined();
  });

  test.for([
    {
      name: "empty stdin",
      argv: ["--cwd", "/tmp/work"],
      stdinIsTTY: false,
      stdoutIsTTY: true,
      stdin: " \n",
      stderr: "Error: No prompt provided on stdin.\n",
    },
    {
      name: "stdout is not a tty",
      argv: ["--cwd", "/tmp/work"],
      stdinIsTTY: true,
      stdoutIsTTY: false,
      stdin: "",
      stderr: "Error: Interactive mode requires a TTY stdout.\n",
    },
    {
      name: "unknown option",
      argv: ["--bogus"],
      stdinIsTTY: true,
      stdoutIsTTY: true,
      stdin: "",
      stderr: "Error: Unknown option: --bogus\n",
    },
    {
      name: "cwd missing a value",
      argv: ["--cwd"],
      stdinIsTTY: true,
      stdoutIsTTY: true,
      stdin: "",
      stderr: "Error: Expected a value after --cwd.\n",
    },
    {
      name: "model value looks like a flag",
      argv: ["-m", "--force"],
      stdinIsTTY: true,
      stdoutIsTTY: true,
      stdin: "",
      stderr: "Error: Expected a value after -m.\n",
    },
  ])(
    "$name exits 1 with the error prefix",
    async ({ argv, stdinIsTTY, stdoutIsTTY, stdin, stderr }) => {
      const harness = fakeCliIo({ stdinIsTTY, stdoutIsTTY, stdin });
      const result = await runCli(
        argv,
        { CURSOR_API_KEY: "cursor_test" },
        harness.io,
      );

      expect(result.exitCode).toBe(1);
      expect(harness.read().stderr).toBe(stderr);
      expect(harness.read().tui).toBeUndefined();
      expect(harness.read().disposed).toBe(0);
    },
  );

  test("a rejected plain run still disposes the session", async () => {
    const harness = fakeCliIo({
      stdinIsTTY: true,
      stdoutIsTTY: true,
      onSend: () => {
        throw "transport down";
      },
    });
    const result = await runCli(
      ["--cwd", "/tmp/work", "fix"],
      { CURSOR_API_KEY: "cursor_test" },
      harness.io,
    );

    expect(result.exitCode).toBe(1);
    expect(harness.read().stderr).toBe("Error: transport down\n");
    expect(harness.read().disposed).toBe(1);
  });

  test("a rejected TUI launch exits 1", async () => {
    const harness = fakeCliIo({ stdinIsTTY: true, stdoutIsTTY: true });
    harness.io.startTui = vi.fn(async () => {
      throw new Error("renderer failed");
    });
    const result = await runCli(
      [],
      { CURSOR_API_KEY: "cursor_test" },
      harness.io,
    );

    expect(result.exitCode).toBe(1);
    expect(harness.read().stderr).toBe("Error: renderer failed\n");
  });

  test("a hole in argv is skipped and an unknown event is ignored", async () => {
    const harness = fakeCliIo({
      stdinIsTTY: true,
      stdoutIsTTY: true,
      onSend: (_prompt, onEvent) => {
        onEvent({ type: "nope" } as unknown as AgentEvent);
      },
    });
    const argv: string[] = ["--help"];
    argv[1] = undefined as unknown as string;

    const helped = await runCli(argv, {}, harness.io);
    expect(helped.exitCode).toBe(0);
    expect(harness.read().stdout).toBe(HELP_STDOUT);

    const plain = fakeCliIo({
      stdinIsTTY: true,
      stdoutIsTTY: true,
      onSend: (_prompt, onEvent) => {
        onEvent({ type: "nope" } as unknown as AgentEvent);
      },
    });
    const result = await runCli(
      ["fix"],
      { CURSOR_API_KEY: "cursor_test" },
      plain.io,
    );
    expect(result.exitCode).toBe(0);
    expect(plain.read().stdout).toBe("");
    expect(plain.read().stderr).toBe("");
  });

  test("plain mode writes assistant text and annotates the other events", async () => {
    const harness = fakeCliIo({
      stdinIsTTY: true,
      stdoutIsTTY: true,
      onSend: (_prompt, onEvent) => {
        onEvent({ type: "assistant_delta", text: "Hello" });
        onEvent({ type: "thinking", text: "  look \n around  " });
        onEvent({ type: "thinking", text: " \n" });
        onEvent({
          type: "tool",
          name: "read",
          status: "completed",
        });
        onEvent({ type: "status", status: "RUNNING", message: "planning" });
        onEvent({ type: "status", status: "FINISHED" });
        onEvent({ type: "status", status: "RUNNING" });
        onEvent({ type: "task", status: "running", text: "edit parser" });
        onEvent({ type: "task" });
        onEvent({
          type: "result",
          status: "finished",
          durationMs: 1500,
          usage: { inputTokens: 3, outputTokens: 4 },
        });
        onEvent({
          type: "result",
          status: "error",
          durationMs: 0,
          usage: { inputTokens: 0, outputTokens: 0 },
        });
        onEvent({ type: "assistant_delta", text: "tail\n" });
      },
    });

    const result = await runCli(
      ["fix"],
      { CURSOR_API_KEY: "cursor_test" },
      harness.io,
    );
    const recorded = harness.read();

    expect(result.exitCode).toBe(0);
    expect(recorded.stdout).toBe("Hellotail\n");
    expect(recorded.stderr).toBe(
      [
        "\n[thinking] look around",
        "[tool] completed read",
        "[status] RUNNING planning",
        "[status] RUNNING",
        "[task] running edit parser",
        "[done] status=finished duration=1.5s input=3 output=4",
        "[done] status=error",
        "",
      ].join("\n"),
    );
  });
});

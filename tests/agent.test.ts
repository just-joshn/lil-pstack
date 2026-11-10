import path from "node:path";
import type { SDKMessage, SDKModel } from "@cursor/sdk";
import { describe, expect, test, vi } from "vitest";
import {
  CodingAgentSession,
  buildPrompt,
  formatDuration,
  formatModelLabel,
  type AgentClient,
  type AgentEvent,
  type AgentPorts,
  type AgentRun,
  type OpenAgentSpec,
} from "../src/agent.ts";

const model = { id: "composer-2" };

function createRun(options?: {
  messages?: SDKMessage[];
  status?: string;
  durationMs?: number;
  usage?: { inputTokens?: number; outputTokens?: number };
  supportsCancel?: boolean;
  cancelReason?: string;
  hold?: Promise<void>;
  onStream?: () => void;
}): AgentRun & { cancel: ReturnType<typeof vi.fn> } {
  const cancel = vi.fn(async () => {});
  return {
    stream: async function* () {
      options?.onStream?.();
      if (options?.hold) {
        await options.hold;
      }
      for (const message of options?.messages ?? []) {
        yield message;
      }
    },
    wait: vi.fn(async () => ({
      status: options?.status ?? "finished",
      durationMs: options?.durationMs,
      usage: options?.usage,
    })),
    supports: vi.fn(() => options?.supportsCancel ?? false),
    unsupportedReason: vi.fn(() => options?.cancelReason),
    cancel,
  };
}

function createHarness(options?: {
  messages?: SDKMessage[];
  run?: ReturnType<typeof createRun>;
  models?: SDKModel[];
  git?: (cwd: string, args: string[]) => string | undefined;
  openError?: Error;
}) {
  const run = options?.run ?? createRun({ messages: options?.messages });
  const dispose = vi.fn(async () => {});
  const send = vi.fn(async () => run);
  const client: AgentClient = { send, dispose };
  const openAgent = vi.fn(async (spec: OpenAgentSpec) => {
    if (options?.openError && spec.place.kind === "cloud") {
      throw options.openError;
    }
    return client;
  });
  const listModels = vi.fn(async () => options?.models ?? []);
  const git = vi.fn((cwd: string, args: string[]) => options?.git?.(cwd, args));
  const ports: AgentPorts = { listModels, openAgent, git };
  return { ports, openAgent, listModels, git, send, dispose, run, client };
}

function createSession(
  harness: ReturnType<typeof createHarness>,
  overrides?: {
    force?: boolean;
    executionMode?: "cloud" | "local";
    cwd?: string;
  },
) {
  return new CodingAgentSession({
    apiKey: "cursor_test",
    cwd: overrides?.cwd ?? "/tmp/work",
    force: overrides?.force ?? false,
    model,
    executionMode: overrides?.executionMode,
    ports: harness.ports,
  });
}

describe("prompt and label helpers", () => {
  test("buildPrompt keeps the user task inside the always-on wrapper", () => {
    const prompt = buildPrompt("refactor the parser");
    expect(prompt).toContain("refactor the parser");
    expect(prompt).toContain("poteto-mode is always on");
  });

  test.for([
    { ms: 0, text: "0ms" },
    { ms: 999, text: "999ms" },
    { ms: 1000, text: "1.0s" },
    { ms: 1500, text: "1.5s" },
  ])("formatDuration($ms) is $text", ({ ms, text }) => {
    expect(formatDuration(ms)).toBe(text);
  });

  test.for([
    { model: { id: "composer-2" }, label: "composer-2" },
    {
      model: {
        id: "composer-2",
        params: [
          { id: "speed", value: "fast" },
          { id: "empty", value: "" },
        ],
      },
      label: "composer-2 (fast)",
    },
  ])("formatModelLabel renders $label", ({ model: selection, label }) => {
    expect(formatModelLabel(selection)).toBe(label);
  });
});

describe("CodingAgentSession", () => {
  test("local send keeps the model, reports the workspace, and disposes", async () => {
    const harness = createHarness();
    const session = createSession(harness, { force: true });
    const events: AgentEvent[] = [];

    await session.sendPrompt({
      prompt: "fix the parser",
      onEvent: (event) => events.push(event),
    });

    expect(session.executionMode).toBe("local");
    expect(session.executionTarget).toBe("/tmp/work");
    expect(session.model).toEqual(model);
    const spec = harness.openAgent.mock.calls[0]?.[0];
    expect(spec).toMatchObject({
      apiKey: "cursor_test",
      name: "lil-pstack",
      model,
      place: {
        kind: "local",
        cwd: path.resolve("/tmp/work"),
        settingSources: ["project", "user", "plugins"],
      },
    });
    expect(spec?.place.kind === "local" ? spec.place.dirs : []).toContain(
      path.resolve("/tmp/work"),
    );
    expect(spec?.agents["poteto-agent"]?.prompt.length).toBeGreaterThan(0);
    expect(harness.send).toHaveBeenCalledWith(
      expect.stringContaining("fix the parser"),
      { model, force: true },
    );
    expect(events).toEqual([
      {
        type: "result",
        status: "finished",
        durationMs: undefined,
        usage: undefined,
      },
    ]);
    expect(harness.dispose).not.toHaveBeenCalled();
    await session.dispose();
    expect(harness.dispose).toHaveBeenCalledOnce();
  });

  test("dispose with no agent returns", async () => {
    const harness = createHarness();
    const session = createSession(harness);
    await session.dispose();
    expect(harness.openAgent).not.toHaveBeenCalled();
  });

  test("an unchanged mode does not open another agent", async () => {
    const harness = createHarness();
    const session = createSession(harness);
    await session.setExecutionMode("local");
    expect(harness.openAgent).not.toHaveBeenCalled();
  });

  test.for([
    {
      name: "ssh remote and branch",
      remote: "git@github.com:acme/widgets.git",
      branch: "main",
      target: "https://github.com/acme/widgets#main",
      repository: {
        url: "https://github.com/acme/widgets",
        startingRef: "main",
      },
    },
    {
      name: "ssh url remote",
      remote: "ssh://git@github.com/acme/widgets.git",
      branch: "dev",
      target: "https://github.com/acme/widgets#dev",
      repository: {
        url: "https://github.com/acme/widgets",
        startingRef: "dev",
      },
    },
    {
      name: "https remote on a detached head",
      remote: "https://github.com/acme/widgets.git",
      branch: "HEAD",
      target: "https://github.com/acme/widgets",
      repository: { url: "https://github.com/acme/widgets" },
    },
    {
      name: "https remote without .git",
      remote: "https://github.com/acme/widgets",
      branch: "",
      target: "https://github.com/acme/widgets",
      repository: { url: "https://github.com/acme/widgets" },
    },
  ])(
    "cloud mode uses $name",
    async ({ remote, branch, target, repository }) => {
      const harness = createHarness({
        git: (_cwd, args) => (args[0] === "config" ? remote : branch),
      });
      const session = createSession(harness);

      await session.setExecutionMode("cloud");

      expect(harness.git).toHaveBeenCalledWith("/tmp/work", [
        "config",
        "--get",
        "remote.origin.url",
      ]);
      expect(harness.git).toHaveBeenCalledWith("/tmp/work", [
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ]);
      expect(session.executionMode).toBe("cloud");
      expect(session.executionTarget).toBe(target);
      expect(harness.openAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          place: { kind: "cloud", repository },
        }),
      );
      await session.sendPrompt({ prompt: "ship it", onEvent: () => {} });
      expect(harness.send).toHaveBeenCalledWith(expect.any(String), {
        force: false,
      });
    },
  );

  test.for([
    {
      name: "missing origin",
      remote: undefined,
      message:
        "Cloud mode requires a git repository with remote.origin.url set.",
    },
    {
      name: "non-github origin",
      remote: "https://gitlab.com/acme/widgets.git",
      message:
        "Cloud mode currently expects remote.origin.url to point at GitHub.",
    },
  ])(
    "cloud mode rejects a $name and keeps local",
    async ({ remote, message }) => {
      const harness = createHarness({
        git: () => remote,
      });
      const session = createSession(harness);

      await expect(session.setExecutionMode("cloud")).rejects.toThrow(message);
      expect(session.executionMode).toBe("local");
      expect(session.executionTarget).toBe("/tmp/work");
      expect(harness.openAgent).not.toHaveBeenCalled();
    },
  );

  test("a failed cloud open restores the previous mode", async () => {
    const harness = createHarness({
      git: (_cwd, args) =>
        args[0] === "config" ? "git@github.com:acme/widgets.git" : "main",
      openError: new Error("cloud down"),
    });
    const session = createSession(harness);

    await expect(session.setExecutionMode("cloud")).rejects.toThrow(
      "cloud down",
    );
    expect(session.executionMode).toBe("local");
  });

  test("switching mode during a run is rejected", async () => {
    let release = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let streaming = false;
    const harness = createHarness({
      run: createRun({
        hold,
        supportsCancel: true,
        onStream: () => {
          streaming = true;
        },
      }),
    });
    const session = createSession(harness);
    const pending = session.sendPrompt({ prompt: "hold", onEvent: () => {} });
    await vi.waitFor(() => {
      expect(streaming).toBe(true);
    });

    await expect(session.setExecutionMode("cloud")).rejects.toThrow(
      "Wait for the current run to finish before switching execution mode.",
    );

    await session.cancelCurrentRun();
    release();
    await pending;
  });

  test.for([
    {
      name: "no active run",
      setup: "idle" as const,
      supportsCancel: false,
      reason: undefined,
      result: { cancelled: false, reason: "No active run to cancel." },
    },
    {
      name: "unsupported with a reason",
      setup: "running" as const,
      supportsCancel: false,
      reason: "cloud runs stay up",
      result: { cancelled: false, reason: "cloud runs stay up" },
    },
    {
      name: "unsupported without a reason",
      setup: "running" as const,
      supportsCancel: false,
      reason: undefined,
      result: {
        cancelled: false,
        reason: "This run cannot be cancelled.",
      },
    },
  ])(
    "cancelCurrentRun reports $name",
    async ({ setup, supportsCancel, reason, result }) => {
      let release = () => {};
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      let streaming = false;
      const harness = createHarness({
        run: createRun({
          hold: setup === "running" ? hold : undefined,
          supportsCancel,
          cancelReason: reason,
          onStream: () => {
            streaming = true;
          },
        }),
      });
      const session = createSession(harness);
      let pending: Promise<void> | undefined;
      if (setup === "running") {
        pending = session.sendPrompt({ prompt: "hold", onEvent: () => {} });
        await vi.waitFor(() => {
          expect(streaming).toBe(true);
        });
      }

      await expect(session.cancelCurrentRun()).resolves.toEqual(result);
      release();
      await pending;
    },
  );

  test("cancelCurrentRun cancels a run that supports it", async () => {
    let release = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let streaming = false;
    const harness = createHarness({
      run: createRun({
        hold,
        supportsCancel: true,
        onStream: () => {
          streaming = true;
        },
      }),
    });
    const session = createSession(harness);
    const pending = session.sendPrompt({ prompt: "hold", onEvent: () => {} });
    await vi.waitFor(() => {
      expect(streaming).toBe(true);
    });

    await expect(session.cancelCurrentRun()).resolves.toEqual({
      cancelled: true,
    });
    expect(harness.run.cancel).toHaveBeenCalledOnce();
    release();
    await pending;
    await expect(session.cancelCurrentRun()).resolves.toEqual({
      cancelled: false,
      reason: "No active run to cancel.",
    });
  });

  test("reset replaces the agent and a later local send reuses it", async () => {
    const harness = createHarness();
    const session = createSession(harness);
    await session.reset();
    await session.sendPrompt({ prompt: "again", onEvent: () => {} });
    session.setModel({ id: "other" });
    await session.sendPrompt({ prompt: "third", onEvent: () => {} });
    expect(harness.openAgent).toHaveBeenCalledTimes(1);
    expect(session.model).toEqual({ id: "other" });
  });

  test("changing the cloud model opens a new agent", async () => {
    const harness = createHarness({
      git: (_cwd, args) =>
        args[0] === "config" ? "https://github.com/acme/widgets" : "main",
    });
    const session = createSession(harness, { executionMode: "cloud" });
    await session.sendPrompt({ prompt: "one", onEvent: () => {} });
    session.setModel({
      id: "gpt-5",
      params: [{ id: "effort", value: "high" }],
    });
    await session.sendPrompt({ prompt: "two", onEvent: () => {} });
    expect(harness.openAgent).toHaveBeenCalledTimes(2);
    expect(harness.dispose).toHaveBeenCalledOnce();
  });

  test("listModels falls back to the current selection when the catalog is empty", async () => {
    const harness = createHarness();
    const session = createSession(harness);
    await expect(session.listModels()).resolves.toEqual([
      { label: "composer-2", value: model },
    ]);
    expect(harness.listModels).toHaveBeenCalledWith("cursor_test");
  });

  test("listModels labels variants, drops duplicate selections, and disambiguates names", async () => {
    const models: SDKModel[] = [
      { id: "composer-2", displayName: "" },
      {
        id: "composer",
        displayName: "Composer",
        parameters: [
          {
            id: "effort",
            displayName: "Effort",
            values: [{ value: "low", displayName: "Low" }, { value: "high" }],
          },
        ],
        variants: [
          { displayName: "Fast", params: [{ id: "effort", value: "low" }] },
          { displayName: "Fast", params: [{ id: "effort", value: "high" }] },
          { displayName: "Composer", params: [{ id: "effort", value: "low" }] },
          { displayName: "  ", params: [{ id: "effort", value: "high" }] },
        ],
      },
      {
        id: "twin",
        displayName: "Twin",
        variants: [
          { displayName: "Same", params: [{ id: "speed", value: "fast" }] },
          {
            displayName: "Same",
            params: [{ id: "speed", value: "fast" }],
            description: "quick",
          },
        ],
      },
      { id: "composer-a", displayName: "Shared" },
      { id: "composer-b", displayName: "Shared" },
      {
        id: "max-mode",
        displayName: "Max Mode",
        variants: [
          {
            displayName: "Max Mode",
            params: [{ id: "mode", value: "max_mode" }],
          },
        ],
      },
    ];
    const harness = createHarness({ models });
    const session = createSession(harness);
    const choices = await session.listModels();

    expect(choices.map((choice) => choice.label)).toEqual([
      "composer-2",
      "Composer - Fast - Effort: Low",
      "Composer - Fast - Effort: High",
      "Twin - Same",
      "Shared - composer-a",
      "Shared - composer-b",
      "Max Mode",
    ]);
    expect(
      choices.find((choice) => choice.label === "Twin - Same")?.description,
    ).toBe("quick");
  });

  test("plain events and tool summaries are what the caller observes", async () => {
    const long = `${"x".repeat(77)}abcdef`;
    const messages: SDKMessage[] = [
      {
        type: "assistant",
        agent_id: "a",
        run_id: "r",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "hello" },
            {
              type: "tool_use",
              id: "call-1",
              name: "read",
              input: { path: "src/a.ts", offset: 10, limit: 20 },
            },
          ],
        },
      },
      { type: "thinking", agent_id: "a", run_id: "r", text: "hmm" },
      {
        type: "tool_call",
        agent_id: "a",
        run_id: "r",
        call_id: "call-2",
        name: "grep",
        status: "completed",
        args: { pattern: "foo", path: "src", glob: "*.ts", type: "ts" },
      },
      {
        type: "tool_call",
        agent_id: "a",
        run_id: "r",
        call_id: "call-3",
        name: "shell",
        status: "running",
        args: { command: "bun test", cwd: "/tmp/work" },
      },
      {
        type: "tool_call",
        agent_id: "a",
        run_id: "r",
        call_id: "call-4",
        name: "glob",
        status: "completed",
        args: { glob_pattern: "*.ts", target_directory: "src" },
      },
      {
        type: "tool_call",
        agent_id: "a",
        run_id: "r",
        call_id: "call-5",
        name: "edit",
        status: "completed",
        args: { file: "a.ts", instruction: "fix" },
      },
      {
        type: "tool_call",
        agent_id: "a",
        run_id: "r",
        call_id: "call-6",
        name: "other",
        status: "completed",
        args: { query: "name", file: "b.ts" },
      },
      {
        type: "tool_call",
        agent_id: "a",
        run_id: "r",
        call_id: "call-7",
        name: "read",
        status: "error",
        args: { path: `  ${long}  ` },
      },
      {
        type: "tool_call",
        agent_id: "a",
        run_id: "r",
        call_id: "call-8",
        name: "read",
        status: "completed",
        args: ["skip"],
      },
      {
        type: "tool_call",
        agent_id: "a",
        run_id: "r",
        call_id: "call-9",
        name: "search",
        status: "completed",
        args: {
          query: ["a", "b", "c", "d"],
          path: true,
          glob: "",
        },
      },
      {
        type: "status",
        agent_id: "a",
        run_id: "r",
        status: "RUNNING",
        message: "planning",
      },
      {
        type: "task",
        agent_id: "a",
        run_id: "r",
        status: "running",
        text: "edit",
      },
      { type: "system", agent_id: "a", run_id: "r" },
      {
        type: "user",
        agent_id: "a",
        run_id: "r",
        message: { role: "user", content: [] },
      },
    ];
    const harness = createHarness({
      messages,
      run: createRun({
        messages,
        status: "finished",
        durationMs: 1500,
        usage: { inputTokens: 3, outputTokens: 4 },
      }),
    });
    const session = createSession(harness);
    const events: AgentEvent[] = [];
    await session.sendPrompt({
      prompt: "look",
      onEvent: (event) => events.push(event),
    });

    expect(events).toEqual([
      { type: "assistant_delta", text: "hello" },
      {
        type: "tool",
        callId: "call-1",
        name: "read",
        params: "path=src/a.ts offset=10 limit=20",
        status: "requested",
      },
      { type: "thinking", text: "hmm" },
      {
        type: "tool",
        callId: "call-2",
        name: "grep",
        params: "pattern=foo path=src glob=*.ts type=ts",
        status: "completed",
      },
      {
        type: "tool",
        callId: "call-3",
        name: "shell",
        params: "command=bun test cwd=/tmp/work",
        status: "running",
      },
      {
        type: "tool",
        callId: "call-4",
        name: "glob",
        params: "glob_pattern=*.ts target_directory=src",
        status: "completed",
      },
      {
        type: "tool",
        callId: "call-5",
        name: "edit",
        params: "file=a.ts instruction=fix",
        status: "completed",
      },
      {
        type: "tool",
        callId: "call-6",
        name: "other",
        params: "file=b.ts query=name",
        status: "completed",
      },
      {
        type: "tool",
        callId: "call-7",
        name: "read",
        params: `path=${"x".repeat(77)}...`,
        status: "error",
      },
      {
        type: "tool",
        callId: "call-8",
        name: "read",
        params: undefined,
        status: "completed",
      },
      {
        type: "tool",
        callId: "call-9",
        name: "search",
        params: "query=[a,b,c] path=true",
        status: "completed",
      },
      { type: "status", status: "RUNNING", message: "planning" },
      { type: "task", status: "running", text: "edit" },
      {
        type: "result",
        status: "finished",
        durationMs: 1500,
        usage: { inputTokens: 3, outputTokens: 4 },
      },
    ]);
  });
});

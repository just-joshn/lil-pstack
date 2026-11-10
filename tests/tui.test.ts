import type { SDKMessage } from "@cursor/sdk";
import { describe, expect, test, vi } from "vitest";
import {
  CodingAgentSession,
  type AgentPorts,
  type AgentRun,
} from "../src/agent.ts";
import { performEffect } from "../src/tui/runtime.ts";
import {
  initialTuiState,
  reduceTui,
  type KeySnapshot,
  type TuiAction,
  type TuiState,
  type TuiStep,
} from "../src/tui/state.ts";

function boot(overrides?: { columns?: number; rows?: number }): TuiState {
  return initialTuiState({
    model: { id: "composer-2" },
    columns: overrides?.columns ?? 80,
    rows: overrides?.rows ?? 24,
    cwd: "/tmp/work",
  });
}

function key(
  name: string,
  extra?: Partial<KeySnapshot>,
): { type: "key"; key: KeySnapshot } {
  return {
    type: "key",
    key: { name, ctrl: false, meta: false, shift: false, ...extra },
  };
}

function textOf(step: TuiStep) {
  return step.view
    .map((line) => line.parts.map((part) => part.text).join(""))
    .join("\n");
}

describe("reduceTui", () => {
  test("ctrl-c exits when the agent is idle", () => {
    const step = reduceTui(boot(), key("c", { ctrl: true }));
    expect(step.effects).toEqual([{ id: 0, type: "exit" }]);
  });

  test("ctrl-c cancels a busy run once", () => {
    const sent = reduceTui(boot(), { type: "submit", value: "fix the parser" });
    const first = reduceTui(sent.state, key("c", { ctrl: true }));
    const second = reduceTui(first.state, key("c", { ctrl: true }));

    expect(first.effects).toEqual([{ id: 2, type: "cancel" }]);
    expect(second.effects).toEqual([]);
    expect(second.state.cancelRequested).toBe(true);
  });

  test("submit while busy clears the draft and sends nothing", () => {
    const sent = reduceTui(boot(), { type: "submit", value: "fix" });
    const step = reduceTui(sent.state, { type: "submit", value: "  again  " });

    expect(step.effects).toEqual([]);
    expect(step.state.input).toBe("");
    expect(step.state.transcript).toHaveLength(1);
  });

  test("a prompt sends once and paints the user line", () => {
    const step = reduceTui(boot(), {
      type: "submit",
      value: "  fix the parser  ",
    });

    expect(step.effects).toEqual([
      { id: 0, type: "send-prompt", text: "fix the parser", runId: 0 },
    ]);
    expect(step.state.busy).toBe(true);
    expect(textOf(step)).toContain("fix the parser");
    expect(textOf(step)).toContain("/tmp/work");
    expect(textOf(step)).toContain("composer-2");
  });

  test.for([
    { command: "/exit", effect: "exit" },
    { command: "/quit", effect: "exit" },
    { command: "/cloud", effect: "switch-mode" },
    { command: "/reset", effect: "reset" },
    { command: "/model", effect: "load-models" },
  ])("$command asks the runtime to $effect", ({ command, effect }) => {
    const step = reduceTui(boot(), { type: "submit", value: command });
    expect(step.effects.map((item) => item.type)).toEqual([effect]);
  });

  test("/local reports that local mode is already active", () => {
    const step = reduceTui(boot(), { type: "submit", value: "/local" });
    expect(step.effects).toEqual([]);
    expect(textOf(step)).toContain("Already using local execution.");
  });

  test("/help opens the command palette", () => {
    const step = reduceTui(boot(), { type: "submit", value: "/help" });
    expect(step.state.mode).toBe("command");
    expect(step.chrome.commandItems.map((item) => item.value)).toEqual([
      "/help",
      "/local",
      "/cloud",
      "/model",
      "/reset",
      "/exit",
      "/quit",
    ]);
  });

  test("an unknown slash prompt is sent to the agent", () => {
    const step = reduceTui(boot(), {
      type: "submit",
      value: "/how does auth work",
    });
    expect(textOf(step)).toContain("/how does auth work");
    expect(step.effects).toEqual([
      expect.objectContaining({
        type: "send-prompt",
        text: "/how does auth work",
      }),
    ]);
  });

  test("typing a slash opens the palette and escape closes it", () => {
    const opened = reduceTui(boot(), { type: "input", value: "/mo" });
    expect(opened.state.mode).toBe("command");
    expect(opened.chrome.commandItems.map((item) => item.value)).toEqual([
      "/model",
    ]);
    const closed = reduceTui(opened.state, key("escape"));
    expect(closed.state.mode).toBe("input");
    expect(closed.state.input).toBe("");
  });

  test("assistant markdown is wrapped into the visible lines", () => {
    const sent = reduceTui(boot({ columns: 40, rows: 40 }), {
      type: "submit",
      value: "look",
    });
    const runId =
      sent.effects[0]?.type === "send-prompt" ? sent.effects[0].runId : 0;
    const step = reduceTui(sent.state, {
      type: "resize",
      columns: 32,
      rows: 40,
    });
    const painted = reduceTui(step.state, {
      type: "agent-event",
      runId,
      event: {
        type: "assistant_delta",
        text: [
          "# Title",
          "> quoted `code` and [docs](https://example.com/docs)",
          "- item",
          "1. step",
          "```ts",
          `const value = "${"x".repeat(40)}"`,
          "```",
          "https://example.com",
        ].join("\n"),
      },
    });
    const paintedText = textOf(painted);

    expect(paintedText).toContain("# Title");
    expect(paintedText).toContain("> ");
    expect(paintedText).toContain("code");
    expect(paintedText).toContain("docs");
    expect(paintedText).toContain("- ");
    expect(paintedText).toContain("1. ");
    expect(paintedText).toContain("--- code: ts");
    expect(paintedText).toContain("| ");
    expect(paintedText).toContain("--- end code");
    expect(paintedText).toContain("https://example.com");
  });

  test("scroll keys move the window off the latest line", () => {
    let step = reduceTui(boot({ rows: 12 }), {
      type: "agent-event",
      runId: 1,
      event: {
        type: "assistant_delta",
        text: Array.from({ length: 40 }, (_, index) => `row ${index}`).join(
          "\n",
        ),
      },
    });
    expect(textOf(step)).toContain("row 39");
    step = reduceTui(step.state, key("up"));
    expect(textOf(step)).not.toContain("row 39");
    expect(step.state.scrollOffset).toBe(1);
    step = reduceTui(step.state, key("end"));
    expect(step.state.scrollOffset).toBe(0);
    expect(textOf(step)).toContain("row 39");
    step = reduceTui(step.state, key("home"));
    expect(step.state.scrollOffset).toBeGreaterThan(1);
    const high = step.state.scrollOffset;
    step = reduceTui(step.state, key("pagedown"));
    expect(step.state.scrollOffset).toBeLessThan(high);
    step = reduceTui(step.state, key("pageup"));
    expect(step.state.scrollOffset).toBeGreaterThan(0);
  });

  test.for([
    { name: "read", status: "requested", text: "[ ] [R] read" },
    { name: "grep", status: "running", text: "[~] [S] grep" },
    { name: "shell", status: "completed", text: "[x] $ shell" },
    { name: "edit", status: "error", text: "[!] [E] edit" },
    { name: "todo", status: "queued", text: "queued [T] todo" },
    { name: "other", status: "done", text: "done [*] other" },
  ])("a $name tool paints $text", ({ name, status, text }) => {
    const step = reduceTui(boot(), {
      type: "agent-event",
      runId: 4,
      event: { type: "tool", name, status, callId: name },
    });
    expect(textOf(step)).toContain(text);
  });

  test("plain events update the transcript the user sees", () => {
    let step = reduceTui(boot(), {
      type: "agent-event",
      runId: 3,
      event: { type: "thinking", text: "  think \n hard " },
    });
    step = reduceTui(step.state, {
      type: "agent-event",
      runId: 3,
      event: { type: "thinking", text: " \n" },
    });
    step = reduceTui(step.state, {
      type: "agent-event",
      runId: 3,
      event: { type: "status", status: "RUNNING", message: "planning" },
    });
    step = reduceTui(step.state, {
      type: "agent-event",
      runId: 3,
      event: { type: "status", status: "ERROR", message: "boom" },
    });
    step = reduceTui(step.state, {
      type: "agent-event",
      runId: 3,
      event: { type: "task", status: "running", text: "edit" },
    });
    step = reduceTui(step.state, {
      type: "agent-event",
      runId: 3,
      event: { type: "task" },
    });
    step = reduceTui(step.state, {
      type: "agent-event",
      runId: 3,
      event: {
        type: "result",
        status: "error",
        durationMs: 1500,
        usage: { inputTokens: 2, outputTokens: 3 },
      },
    });
    step = reduceTui(step.state, {
      type: "agent-event",
      runId: 3,
      event: { type: "result", status: "finished" },
    });
    const painted = textOf(step);
    expect(painted).toContain("think hard");
    expect(painted).toContain("error boom");
    expect(painted).toContain("running edit");
    expect(painted).toContain("status=error duration=1.5s input=2 output=3");
    expect(painted).not.toContain("status=finished");
  });

  test("model search, preference, and escape stay in the reducer", () => {
    const loaded = reduceTui(boot(), {
      type: "models-loaded",
      choices: [
        {
          label: "Fast",
          value: { id: "composer-2", params: [{ id: "speed", value: "fast" }] },
        },
        {
          label: "Slow",
          value: { id: "composer-2", params: [{ id: "speed", value: "slow" }] },
        },
      ],
    });
    const searching = reduceTui({ ...loaded.state, mode: "model" }, key("f"));
    expect(searching.state.modelSearch).toBe("f");
    expect(searching.chrome.filteredModels.map((item) => item.name)).toEqual([
      "Fast",
    ]);
    const cleared = reduceTui(searching.state, key("backspace"));
    expect(cleared.state.modelSearch).toBe("");
    const toggled = reduceTui(cleared.state, key("f", { shift: true }));
    expect(toggled.effects[0]).toMatchObject({ type: "set-model" });
    expect(toggled.state.model).toEqual({
      id: "composer-2",
      params: [{ id: "speed", value: "fast" }],
    });
    const closed = reduceTui(toggled.state, key("escape"));
    expect(closed.state.mode).toBe("input");
  });

  test("selecting a hidden model does nothing", () => {
    const loaded = reduceTui(boot(), {
      type: "models-loaded",
      choices: [{ label: "Composer", value: { id: "composer-2" } }],
    });
    const step = reduceTui(
      { ...loaded.state, mode: "model", modelSearch: "missing" },
      { type: "select-model", pick: { id: "composer-2" } },
    );
    expect(step.effects).toEqual([]);
    expect(step.state.mode).toBe("model");
  });

  test("run failure and a rejected cancel are visible", () => {
    const sent = reduceTui(boot(), { type: "submit", value: "fix" });
    const failed = reduceTui(sent.state, {
      type: "run-failed",
      message: "transport down",
    });
    expect(failed.state.busy).toBe(false);
    expect(textOf(failed)).toContain("transport down");

    const busy = reduceTui(boot(), { type: "submit", value: "fix" });
    const cancelling = reduceTui(busy.state, key("c", { ctrl: true }));
    const denied = reduceTui(cancelling.state, {
      type: "cancel-result",
      result: { cancelled: false, reason: "cloud runs stay up" },
    });
    expect(denied.state.cancelRequested).toBe(false);
    expect(textOf(denied)).toContain("cloud runs stay up");
  });
});

test("result actions and a second assistant chunk update the screen", () => {
  const sent = reduceTui(boot(), { type: "submit", value: "fix" });
  const runId =
    sent.effects[0]?.type === "send-prompt" ? sent.effects[0].runId : 0;
  let step = reduceTui(sent.state, {
    type: "agent-event",
    runId,
    event: { type: "assistant_delta", text: "hello" },
  });
  step = reduceTui(step.state, {
    type: "agent-event",
    runId,
    event: { type: "assistant_delta", text: " there" },
  });
  step = reduceTui(step.state, {
    type: "agent-event",
    runId,
    event: { type: "assistant_delta", text: "" },
  });
  step = reduceTui(step.state, {
    type: "agent-event",
    runId,
    event: { type: "thinking", text: "first" },
  });
  step = reduceTui(step.state, {
    type: "agent-event",
    runId,
    event: { type: "thinking", text: "second" },
  });
  step = reduceTui(step.state, {
    type: "agent-event",
    runId,
    event: { type: "tool", name: "write", status: "completed" },
  });
  step = reduceTui(step.state, {
    type: "agent-event",
    runId,
    event: { type: "status", status: "CANCELLED" },
  });
  expect(textOf(step)).toContain("cancelled");
  step = reduceTui(step.state, {
    type: "agent-event",
    runId,
    event: { type: "status", status: "EXPIRED", message: "stale" },
  });
  step = reduceTui(step.state, {
    type: "resize",
    columns: 20,
    rows: 24,
  });
  step = reduceTui(step.state, {
    type: "agent-event",
    runId,
    event: {
      type: "assistant_delta",
      text: `\n\`\`\`\n${"x".repeat(80)}\n\`\`\``,
    },
  });
  const painted = textOf(step);
  expect(painted).toContain("hello there");
  expect(painted).toContain("second");
  expect(painted).toContain("[E] write");
  expect(painted).not.toContain("cancelled");
  expect(painted).toContain("expired stale");
  expect(painted).toContain("--- code");
  expect(painted).toContain("| ");

  const picked = reduceTui(
    reduceTui(boot(), {
      type: "models-loaded",
      choices: [{ label: "Composer", value: { id: "composer-2" } }],
    }).state,
    { type: "select-model", pick: { id: "composer-2" } },
  );
  expect(picked.effects.map((effect) => effect.type)).toEqual(["set-model"]);
  expect(
    reduceTui(picked.state, {
      type: "select-model",
      pick: { id: 1 } as unknown as { id: string },
    }).effects,
  ).toEqual([]);

  expect(
    reduceTui(sent.state, {
      type: "select-command",
      name: "/exit",
    }).effects.map((effect) => effect.type),
  ).toEqual(["exit"]);
  const idle = reduceTui(boot(), { type: "select-command", name: "/exit" });
  expect(idle.effects.map((effect) => effect.type)).toEqual(["exit"]);
  expect(
    reduceTui(sent.state, { type: "input", value: "/help" }).state.mode,
  ).toBe("input");
  expect(
    reduceTui(sent.state, { type: "submit", value: "/reset" }).effects,
  ).toEqual([]);

  const switched = reduceTui(boot(), {
    type: "mode-switched",
    mode: "cloud",
    target: "https://github.com/acme/widgets#main",
  });
  expect(textOf(switched).replaceAll(/\s+/g, " ")).toContain(
    "Switched to cloud execution. Target: https://github.com/acme/widgets#main.",
  );
  expect(
    textOf(
      reduceTui(boot(), { type: "mode-switch-failed", message: "cloud down" }),
    ),
  ).toContain("cloud down");
  expect(
    textOf(reduceTui(boot(), { type: "models-failed", message: "no catalog" })),
  ).toContain("no catalog");
  const reset = reduceTui(
    reduceTui(boot(), {
      type: "agent-event",
      runId: 1,
      event: { type: "assistant_delta", text: "keep" },
    }).state,
    { type: "reset-done" },
  );
  expect(reset.state.transcript).toEqual([]);
  expect(
    textOf(reduceTui(boot(), { type: "reset-failed", message: "reset down" })),
  ).toContain("reset down");
  const cancelled = reduceTui(sent.state, {
    type: "cancel-result",
    result: { cancelled: true },
  });
  expect(textOf(cancelled)).toContain("Cancellation requested.");
  expect(
    textOf(
      reduceTui(sent.state, { type: "cancel-failed", message: "cancel down" }),
    ),
  ).toContain("cancel down");
  expect(reduceTui(sent.state, { type: "run-finished" }).state.busy).toBe(
    false,
  );
});

describe("performEffect", () => {
  function createRun(messages: SDKMessage[] = []): AgentRun {
    return {
      stream: async function* () {
        for (const message of messages) {
          yield message;
        }
      },
      wait: vi.fn(async () => ({ status: "finished" })),
      supports: vi.fn(() => false),
      unsupportedReason: vi.fn(() => undefined),
      cancel: vi.fn(async () => {}),
    };
  }

  function createRuntime(options?: {
    models?: AgentPorts["listModels"];
    git?: AgentPorts["git"];
    openAgent?: AgentPorts["openAgent"];
    messages?: SDKMessage[];
  }) {
    const openAgent =
      options?.openAgent ??
      vi.fn(async () => ({
        send: vi.fn(async () => createRun(options?.messages)),
        dispose: vi.fn(async () => {}),
      }));
    const ports: AgentPorts = {
      listModels: options?.models ?? vi.fn(async () => []),
      openAgent,
      git: options?.git ?? vi.fn(() => undefined),
    };
    const session = new CodingAgentSession({
      apiKey: "cursor_test",
      cwd: "/tmp/work",
      force: false,
      model: { id: "composer-2" },
      ports,
    });
    const actions: TuiAction[] = [];
    let exited = false;
    return {
      session,
      actions,
      runtime: {
        session,
        dispatch: (action: TuiAction) => {
          actions.push(action);
        },
        exit: () => {
          exited = true;
        },
      },
      exited: () => exited,
    };
  }

  test("exit destroys the screen", async () => {
    const harness = createRuntime();
    await performEffect({ id: 1, type: "exit" }, harness.runtime);
    expect(harness.exited()).toBe(true);
  });

  test("load-models dispatches the catalog", async () => {
    const harness = createRuntime({
      models: vi.fn(async () => [
        { id: "composer-2", displayName: "Composer" },
      ]),
    });
    await performEffect({ id: 1, type: "load-models" }, harness.runtime);
    expect(harness.actions[0]).toMatchObject({
      type: "models-loaded",
      choices: [{ label: "Composer", value: { id: "composer-2" } }],
    });
  });

  test.for([
    { thrown: new Error("catalog down"), message: "catalog down" },
    { thrown: "catalog down", message: "catalog down" },
  ])("load-models reports $message", async ({ thrown, message }) => {
    const harness = createRuntime({
      models: vi.fn(async () => {
        throw thrown;
      }),
    });
    await performEffect({ id: 1, type: "load-models" }, harness.runtime);
    expect(harness.actions).toEqual([{ type: "models-failed", message }]);
  });

  test("switch-mode dispatches the cloud target", async () => {
    const harness = createRuntime({
      git: (_cwd, args) =>
        args[0] === "config" ? "git@github.com:acme/widgets.git" : "main",
      openAgent: vi.fn(async () => ({
        send: vi.fn(async () => createRun()),
        dispose: vi.fn(async () => {}),
      })),
    });
    await performEffect(
      { id: 1, type: "switch-mode", mode: "cloud" },
      harness.runtime,
    );
    expect(harness.actions).toEqual([
      {
        type: "mode-switched",
        mode: "cloud",
        target: "https://github.com/acme/widgets#main",
      },
    ]);
  });

  test("switch-mode reports a rejected cloud move", async () => {
    const harness = createRuntime();
    await performEffect(
      { id: 1, type: "switch-mode", mode: "cloud" },
      harness.runtime,
    );
    expect(harness.actions[0]).toMatchObject({
      type: "mode-switch-failed",
      message:
        "Cloud mode requires a git repository with remote.origin.url set.",
    });
  });

  test("set-model updates the session the runtime holds", async () => {
    const harness = createRuntime();
    const pick = { id: "gpt-5", params: [{ id: "effort", value: "high" }] };
    await performEffect({ id: 1, type: "set-model", pick }, harness.runtime);
    expect(harness.session.model).toEqual(pick);
    expect(harness.actions).toEqual([]);
  });

  test("send-prompt forwards stream events and then finishes", async () => {
    const messages: SDKMessage[] = [
      {
        type: "assistant",
        agent_id: "a",
        run_id: "r",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
        },
      },
    ];
    const harness = createRuntime({ messages });
    await performEffect(
      { id: 1, type: "send-prompt", text: "fix", runId: 7 },
      harness.runtime,
    );
    expect(harness.actions).toEqual([
      {
        type: "agent-event",
        runId: 7,
        event: { type: "assistant_delta", text: "hello" },
      },
      {
        type: "agent-event",
        runId: 7,
        event: {
          type: "result",
          status: "finished",
          durationMs: undefined,
          usage: undefined,
        },
      },
      { type: "run-finished" },
    ]);
  });

  test("send-prompt reports a string rejection", async () => {
    const harness = createRuntime({
      openAgent: vi.fn(async () => {
        throw "transport down";
      }),
    });
    await performEffect(
      { id: 1, type: "send-prompt", text: "fix", runId: 1 },
      harness.runtime,
    );
    expect(harness.actions).toEqual([
      { type: "run-failed", message: "transport down" },
    ]);
  });

  test("reset and cancel dispatch the session result", async () => {
    const harness = createRuntime();
    await performEffect({ id: 1, type: "reset" }, harness.runtime);
    await performEffect({ id: 2, type: "cancel" }, harness.runtime);
    expect(harness.actions).toEqual([
      { type: "reset-done" },
      {
        type: "cancel-result",
        result: { cancelled: false, reason: "No active run to cancel." },
      },
    ]);
  });
});

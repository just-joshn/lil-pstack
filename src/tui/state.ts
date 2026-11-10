import type { ModelSelection } from "@cursor/sdk";
import {
  formatDuration,
  formatModelLabel,
  type AgentEvent,
  type CancelRunResult,
  type ExecutionMode,
  type ModelChoice,
} from "../agent.js";
import {
  getSlashCommand,
  getSlashCommandItems,
  type SlashCommandName,
} from "../commands.js";

export type KeySnapshot = {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  sequence?: string;
};

export type TuiAction =
  | { type: "key"; key: KeySnapshot }
  | { type: "input"; value: string }
  | { type: "submit"; value: string }
  | { type: "select-command"; name: string }
  | { type: "select-model"; pick: ModelSelection }
  | { type: "resize"; columns: number; rows: number }
  | { type: "agent-event"; event: AgentEvent; runId: number }
  | { type: "models-loaded"; choices: ModelChoice[] }
  | { type: "models-failed"; message: string }
  | { type: "mode-switched"; mode: ExecutionMode; target: string }
  | { type: "mode-switch-failed"; message: string }
  | { type: "reset-done" }
  | { type: "reset-failed"; message: string }
  | { type: "cancel-result"; result: CancelRunResult }
  | { type: "cancel-failed"; message: string }
  | { type: "run-finished" }
  | { type: "run-failed"; message: string };

export type TuiEffect =
  | { id: number; type: "exit" }
  | { id: number; type: "load-models" }
  | { id: number; type: "switch-mode"; mode: ExecutionMode }
  | { id: number; type: "reset" }
  | { id: number; type: "set-model"; pick: ModelSelection }
  | { id: number; type: "send-prompt"; text: string; runId: number }
  | { id: number; type: "cancel" };

export type TranscriptEntry = {
  id: string;
  kind: "assistant" | "error" | "meta" | "status" | "tool" | "user";
  label: string;
  text: string;
};

export type TranscriptPart = {
  text: string;
  bold?: boolean;
  color?:
    "blue" | "cyan" | "gray" | "green" | "magenta" | "red" | "white" | "yellow";
  dimColor?: boolean;
};

export type TranscriptViewLine = {
  id: string;
  kind: TranscriptEntry["kind"];
  label: string;
  parts: TranscriptPart[];
};

export type CommandSelectItem = {
  key: string;
  name: string;
  description: string;
  value: SlashCommandName;
};

export type ModelSelectItem = {
  key: string;
  name: string;
  description: string;
  value: ModelSelection;
};

export type ModelPreference = {
  fast: boolean;
  thinking: boolean;
};

export type ViewMode = "command" | "input" | "model";

export type TuiState = {
  cwd: string;
  columns: number;
  rows: number;
  executionMode: ExecutionMode;
  executionTarget: string;
  input: string;
  mode: ViewMode;
  model: ModelSelection;
  modelItems: ModelSelectItem[];
  modelSearch: string;
  modelPreference: ModelPreference;
  loadingModels: boolean;
  busy: boolean;
  cancelRequested: boolean;
  scrollOffset: number;
  transcript: TranscriptEntry[];
  nextId: number;
};

export type TuiChrome = {
  maxScrollOffset: number;
  viewportRows: number;
  commandRows: number;
  modelRows: number;
  commandItems: CommandSelectItem[];
  filteredModels: ModelSelectItem[];
};

export type TuiStep = {
  state: TuiState;
  view: TranscriptViewLine[];
  effects: TuiEffect[];
  chrome: TuiChrome;
};

export function initialTuiState(input: {
  model: ModelSelection;
  columns: number;
  rows: number;
  cwd: string;
}): TuiState {
  return {
    cwd: input.cwd,
    columns: input.columns,
    rows: input.rows,
    executionMode: "local",
    executionTarget: input.cwd,
    input: "",
    mode: "input",
    model: input.model,
    modelItems: [],
    modelSearch: "",
    modelPreference: { fast: false, thinking: false },
    loadingModels: false,
    busy: false,
    cancelRequested: false,
    scrollOffset: 0,
    transcript: [],
    nextId: 0,
  };
}

export function reduceTui(state: TuiState, action: TuiAction): TuiStep {
  switch (action.type) {
    case "key":
      return reduceKey(state, action.key);
    case "input":
      return reduceInput(state, action.value);
    case "submit":
      return reduceSubmit(state, action.value);
    case "select-command":
      return reduceCommand(state, action.name);
    case "select-model":
      return reduceSelectModel(state, action.pick);
    case "resize":
      return finish(
        { ...state, columns: action.columns, rows: action.rows },
        [],
      );
    case "agent-event":
      return reduceAgentEvent(state, action.event, action.runId);
    case "models-loaded":
      return finish(
        {
          ...state,
          loadingModels: false,
          modelItems: action.choices.map(toModelItem),
        },
        [],
      );
    case "models-failed":
      return finish(
        pushEntry(
          { ...state, loadingModels: false, mode: "input" },
          "error",
          "model",
          action.message,
        ),
        [],
      );
    case "mode-switched":
      return finish(
        pushEntry(
          {
            ...state,
            busy: false,
            executionMode: action.mode,
            executionTarget: action.target,
          },
          "status",
          "mode",
          `Switched to ${action.mode} execution. Target: ${action.target}.`,
        ),
        [],
      );
    case "mode-switch-failed":
      return finish(
        pushEntry({ ...state, busy: false }, "error", "mode", action.message),
        [],
      );
    case "reset-done":
      return finish(
        { ...state, busy: false, transcript: [], scrollOffset: 0 },
        [],
      );
    case "reset-failed":
      return finish(
        pushEntry({ ...state, busy: false }, "error", "reset", action.message),
        [],
      );
    case "cancel-result":
      return action.result.cancelled
        ? finish(
            pushEntry(state, "status", "run", "Cancellation requested."),
            [],
          )
        : finish(
            pushEntry(
              { ...state, cancelRequested: false },
              "error",
              "cancel",
              action.result.reason,
            ),
            [],
          );
    case "cancel-failed":
      return finish(
        pushEntry(
          { ...state, cancelRequested: false },
          "error",
          "cancel",
          action.message,
        ),
        [],
      );
    case "run-finished":
      return finish({ ...state, busy: false, cancelRequested: false }, []);
    case "run-failed":
      return finish(
        pushEntry(
          { ...state, busy: false, cancelRequested: false },
          "error",
          "run",
          action.message,
        ),
        [],
      );
  }
}

function reduceKey(state: TuiState, key: KeySnapshot): TuiStep {
  if (key.ctrl && key.name === "c") {
    if (!state.busy) {
      return withEffect(state, { id: state.nextId, type: "exit" });
    }
    if (state.cancelRequested) {
      return finish(state, []);
    }
    return withEffect(
      { ...state, cancelRequested: true },
      { id: state.nextId, type: "cancel" },
    );
  }

  if (state.mode === "model" && key.name === "escape") {
    return finish({ ...state, mode: "input" }, []);
  }

  if (state.mode === "model") {
    const character = inputCharacter(key);
    if (key.name === "backspace" || key.name === "delete") {
      return finish(
        { ...state, modelSearch: state.modelSearch.slice(0, -1) },
        [],
      );
    }
    if (character === "T") {
      return togglePreference(state, "thinking");
    }
    if (character === "F") {
      return togglePreference(state, "fast");
    }
    if (isSearchInput(character)) {
      return finish(
        { ...state, modelSearch: `${state.modelSearch}${character}` },
        [],
      );
    }
    return finish(state, []);
  }

  if (state.mode === "command" && key.name === "escape") {
    return finish({ ...state, input: "", mode: "input" }, []);
  }

  if (state.mode !== "input") {
    return finish(state, []);
  }

  const lines = transcriptLines(state);
  const viewport = layout(state).viewportRows;
  const maxScrollOffset = Math.max(0, lines.length - viewport);
  const pageSize = Math.max(1, viewport - 1);

  if (key.name === "up") {
    return finish(
      {
        ...state,
        scrollOffset: Math.min(maxScrollOffset, state.scrollOffset + 1),
      },
      [],
    );
  }
  if (key.name === "down") {
    return finish(
      { ...state, scrollOffset: Math.max(0, state.scrollOffset - 1) },
      [],
    );
  }
  if (key.name === "pageup") {
    return finish(
      {
        ...state,
        scrollOffset: Math.min(maxScrollOffset, state.scrollOffset + pageSize),
      },
      [],
    );
  }
  if (key.name === "pagedown") {
    return finish(
      {
        ...state,
        scrollOffset: Math.max(0, state.scrollOffset - pageSize),
      },
      [],
    );
  }
  if (key.name === "home") {
    return finish({ ...state, scrollOffset: maxScrollOffset }, []);
  }
  if (key.name === "end") {
    return finish({ ...state, scrollOffset: 0 }, []);
  }

  return finish(state, []);
}

function reduceInput(state: TuiState, value: string): TuiStep {
  return finish(
    {
      ...state,
      input: value,
      mode: !state.busy && value.startsWith("/") ? "command" : state.mode,
    },
    [],
  );
}

function reduceSubmit(state: TuiState, value: string): TuiStep {
  const prompt = value.trim();
  const cleared = { ...state, input: "" };
  if (!prompt || state.busy) {
    return finish(cleared, []);
  }
  if (prompt.startsWith("/")) {
    if (getSlashCommand(prompt)) {
      return reduceCommand(cleared, prompt);
    }
    return beginSend(cleared, prompt);
  }
  return beginSend(cleared, prompt);
}

function reduceCommand(state: TuiState, rawCommand: string): TuiStep {
  const command = getSlashCommand(rawCommand);
  const cleared = { ...state, mode: "input" as const, input: "" };

  switch (command) {
    case "/help":
      return finish({ ...cleared, input: "/", mode: "command" }, []);
    case "/model":
      return withEffect(
        {
          ...cleared,
          loadingModels: true,
          modelSearch: "",
          mode: "model",
          modelPreference: {
            fast: getSelectionPreference(state.model, "fast") === true,
            thinking: getSelectionPreference(state.model, "thinking") === true,
          },
        },
        { id: cleared.nextId, type: "load-models" },
      );
    case "/local":
    case "/cloud":
      return beginModeSwitch(cleared, command === "/local" ? "local" : "cloud");
    case "/reset":
      return beginReset(cleared);
    case "/exit":
    case "/quit":
      return withEffect(cleared, { id: cleared.nextId, type: "exit" });
    default:
      return beginSend(cleared, rawCommand);
  }
}

function beginModeSwitch(state: TuiState, mode: ExecutionMode): TuiStep {
  if (state.busy) {
    return finish(state, []);
  }
  if (state.executionMode === mode) {
    return finish(
      pushEntry(state, "status", "mode", `Already using ${mode} execution.`),
      [],
    );
  }
  return withEffect(
    { ...state, busy: true },
    { id: state.nextId, type: "switch-mode", mode },
  );
}

function beginReset(state: TuiState): TuiStep {
  if (state.busy) {
    return finish(state, []);
  }
  return withEffect(
    { ...state, busy: true },
    { id: state.nextId, type: "reset" },
  );
}

function beginSend(state: TuiState, prompt: string): TuiStep {
  const runId = state.nextId;
  const userId = state.nextId + 1;
  return finish(
    {
      ...state,
      nextId: state.nextId + 2,
      busy: true,
      cancelRequested: false,
      scrollOffset: 0,
      transcript: [
        ...state.transcript,
        { id: String(userId), kind: "user", label: "you", text: prompt },
      ],
    },
    [{ id: runId, type: "send-prompt", text: prompt, runId }],
  );
}

function reduceSelectModel(state: TuiState, pick: ModelSelection): TuiStep {
  const item = filterModelItems(
    state.modelItems,
    state.modelSearch,
    state.modelPreference,
  ).find((candidate) => modelSelectionEquals(candidate.value, pick));
  if (!item) {
    return finish(state, []);
  }

  const selection =
    findPreferredSelection(
      item.value,
      state.modelItems,
      state.modelPreference,
    ) ?? item.value;
  return withEffect(
    { ...state, model: selection, mode: "input" },
    { id: state.nextId, type: "set-model", pick: selection },
  );
}

function togglePreference(
  state: TuiState,
  preference: keyof ModelPreference,
): TuiStep {
  const modelPreference = {
    ...state.modelPreference,
    [preference]: !state.modelPreference[preference],
  };
  const selection = findPreferredSelection(
    state.model,
    state.modelItems,
    modelPreference,
  );
  if (!selection) {
    return finish({ ...state, modelPreference }, []);
  }
  return withEffect(
    { ...state, modelPreference, model: selection },
    { id: state.nextId, type: "set-model", pick: selection },
  );
}

function reduceAgentEvent(
  state: TuiState,
  event: AgentEvent,
  runId: number,
): TuiStep {
  const applied = applyAgentEvent(
    state.transcript,
    event,
    String(runId),
    state.nextId,
  );
  return finish(
    { ...state, transcript: applied.items, nextId: applied.nextId },
    [],
  );
}

function withEffect(state: TuiState, effect: TuiEffect): TuiStep {
  return finish({ ...state, nextId: effect.id + 1 }, [effect]);
}

function pushEntry(
  state: TuiState,
  kind: TranscriptEntry["kind"],
  label: string,
  text: string,
): TuiState {
  return {
    ...state,
    nextId: state.nextId + 1,
    transcript: [
      ...state.transcript,
      { id: String(state.nextId), kind, label, text },
    ],
  };
}

function finish(state: TuiState, effects: TuiEffect[]): TuiStep {
  const metrics = layout(state);
  const lines = transcriptLines(state);
  const maxScrollOffset = Math.max(0, lines.length - metrics.viewportRows);
  const scrollOffset = Math.min(state.scrollOffset, maxScrollOffset);
  const next =
    scrollOffset === state.scrollOffset ? state : { ...state, scrollOffset };
  const end = lines.length - scrollOffset;
  const start = Math.max(0, end - metrics.viewportRows);

  return {
    state: next,
    view: lines.slice(start, end),
    effects,
    chrome: {
      ...metrics,
      maxScrollOffset,
      commandItems: commandItems(state.input),
      filteredModels: filterModelItems(
        state.modelItems,
        state.modelSearch,
        state.modelPreference,
      ),
    },
  };
}

function layout(state: TuiState) {
  const commandRows = Math.min(6, Math.max(3, state.rows - 10));
  const modelRows = Math.min(8, Math.max(3, state.rows - 10));
  const commandPanelRows = 2 + commandRows;
  const modelPanelRows = 3 + modelRows;
  const viewportRows = Math.max(
    4,
    state.rows -
      (state.mode === "model"
        ? modelPanelRows + 4
        : state.mode === "command"
          ? commandPanelRows + 4
          : 6),
  );
  return { viewportRows, commandRows, modelRows };
}

function statusEntries(state: TuiState): TranscriptEntry[] {
  return [
    { id: "status-cwd", kind: "meta", label: "cwd", text: state.cwd },
    {
      id: "status-mode",
      kind: "meta",
      label: "mode",
      text: `${state.executionMode} - ${state.executionTarget}`,
    },
    {
      id: "status-model",
      kind: "meta",
      label: "model",
      text: formatModelLabel(state.model),
    },
    ...state.transcript,
  ];
}

function transcriptLines(state: TuiState) {
  return buildTranscriptLines(statusEntries(state), state.columns);
}

function commandItems(input: string): CommandSelectItem[] {
  return getSlashCommandItems(input).map((item) => {
    const [name, ...descriptionParts] = item.label.split(/\s{2,}/);
    return {
      key: item.key,
      name: name ?? item.value,
      description: descriptionParts.join(" "),
      value: item.value,
    };
  });
}

function toModelItem(choice: ModelChoice): ModelSelectItem {
  return {
    key: modelKeyFromSelection(choice.value),
    name: choice.label,
    description: choice.description ?? "",
    value: choice.value,
  };
}

function inputCharacter(key: KeySnapshot) {
  if (key.ctrl || key.meta || key.name.length !== 1) {
    return "";
  }
  return key.shift ? key.name.toUpperCase() : key.name;
}

function isSearchInput(input: string) {
  return input.length > 0 && !/[\u0000-\u001F\u007F]/.test(input);
}

function buildTranscriptLines(entries: TranscriptEntry[], columns: number) {
  const labelWidth = 7;
  const textWidth = Math.max(20, columns - labelWidth - 4);

  return entries.flatMap((entry) => {
    const renderedLines = trimTrailingBlankLines(
      entry.kind === "assistant"
        ? renderMarkdownLines(entry.text || "...", textWidth)
        : wrapText(entry.text || "...", textWidth).map((text) => ({
            parts: [{ text }],
          })),
    );

    return renderedLines.map((line, index) => ({
      id: `${entry.id}-${index}`,
      kind: entry.kind,
      label: index === 0 ? entry.label : "",
      parts: line.parts,
    }));
  });
}

function trimTrailingBlankLines(lines: Array<{ parts: TranscriptPart[] }>) {
  let end = lines.length;

  while (end > 1) {
    const line = lines[end - 1];
    if (!line || !isBlankRenderedLine(line)) {
      break;
    }
    end -= 1;
  }

  return lines.slice(0, end);
}

function isBlankRenderedLine(line: { parts: TranscriptPart[] }) {
  return line.parts.every((part) => part.text.trim() === "");
}

function renderMarkdownLines(value: string, width: number) {
  const lines: Array<{ parts: TranscriptPart[] }> = [];
  let inCodeBlock = false;

  for (const rawLine of value.split("\n")) {
    const line = rawLine.trimEnd();
    const fence = line.match(/^```\s*(.*)$/);

    if (fence) {
      inCodeBlock = !inCodeBlock;
      const language = fence[1]?.trim();
      lines.push({
        parts: [
          {
            text: inCodeBlock
              ? `--- code${language ? `: ${language}` : ""}`
              : "--- end code",
            color: "gray",
            dimColor: true,
          },
        ],
      });
      continue;
    }

    if (inCodeBlock) {
      for (const text of wrapText(line || " ", width - 2)) {
        lines.push({
          parts: [{ text: `| ${text}`, color: "gray" }],
        });
      }
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      for (const text of wrapText(heading[2] ?? "", width - 2)) {
        lines.push({
          parts: [{ text: `# ${text}`, bold: true, color: "cyan" }],
        });
      }
      continue;
    }

    const blockquote = line.match(/^>\s?(.*)$/);
    if (blockquote) {
      for (const text of wrapText(blockquote[1] || " ", width - 2)) {
        lines.push({
          parts: [
            { text: "> ", color: "gray", dimColor: true },
            ...parseInlineMarkdown(text),
          ],
        });
      }
      continue;
    }

    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    if (unordered) {
      for (const [index, text] of wrapText(
        unordered[1] ?? "",
        width - 2,
      ).entries()) {
        lines.push({
          parts: [
            { text: index === 0 ? "- " : "  ", color: "cyan" },
            ...parseInlineMarkdown(text),
          ],
        });
      }
      continue;
    }

    const ordered = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
    if (ordered) {
      const marker = `${ordered[1]}. `;
      for (const [index, text] of wrapText(
        ordered[2] ?? "",
        width - marker.length,
      ).entries()) {
        lines.push({
          parts: [
            {
              text: index === 0 ? marker : " ".repeat(marker.length),
              color: "cyan",
            },
            ...parseInlineMarkdown(text),
          ],
        });
      }
      continue;
    }

    for (const text of wrapText(line, width)) {
      lines.push({ parts: parseInlineMarkdown(text) });
    }
  }

  return lines;
}

function wrapText(value: string, width: number) {
  const lines: string[] = [];

  for (const rawLine of value.split("\n")) {
    let line = rawLine;

    if (!line) {
      lines.push("");
      continue;
    }

    while (line.length > width) {
      let breakAt = line.lastIndexOf(" ", width);
      if (breakAt < width * 0.5) {
        breakAt = width;
      }

      lines.push(line.slice(0, breakAt).trimEnd());
      line = line.slice(breakAt).trimStart();
    }

    lines.push(line);
  }

  return lines;
}

function parseInlineMarkdown(value: string): TranscriptPart[] {
  const parts: TranscriptPart[] = [];
  const pattern = /(`[^`]+`|\[([^\]]+)\]\(([^)]+)\)|(https?:\/\/\S+))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(value))) {
    if (match.index > lastIndex) {
      parts.push({ text: value.slice(lastIndex, match.index) });
    }

    const token = match[0];
    if (token.startsWith("`")) {
      parts.push({
        text: token.slice(1, -1),
        color: "yellow",
      });
    } else if (match[2] && match[3]) {
      parts.push({ text: match[2], color: "blue" });
      parts.push({ text: ` (${match[3]})`, color: "gray", dimColor: true });
    } else {
      parts.push({ text: token, color: "blue" });
    }

    lastIndex = match.index + token.length;
  }

  if (lastIndex < value.length) {
    parts.push({ text: value.slice(lastIndex) });
  }

  return parts.length > 0 ? parts : [{ text: "" }];
}

function applyAgentEvent(
  items: TranscriptEntry[],
  event: AgentEvent,
  assistantId: string,
  nextId: number,
): { items: TranscriptEntry[]; nextId: number } {
  switch (event.type) {
    case "assistant_delta":
      return {
        items: appendAssistantDelta(items, assistantId, event.text),
        nextId,
      };
    case "thinking": {
      const text = compactText(event.text);
      return {
        items: text
          ? upsertEntry(
              items,
              `thinking-${assistantId}`,
              "status",
              "think",
              text,
            )
          : items,
        nextId,
      };
    }
    case "tool": {
      const id = event.callId
        ? `tool-${event.callId}`
        : `tool-${assistantId}-${event.name}`;
      return {
        items: upsertEntry(
          items,
          id,
          "tool",
          "tool",
          [
            formatToolStatus(event.status),
            formatToolIcon(event.name),
            event.name,
            event.params,
          ]
            .filter(Boolean)
            .join(" "),
        ),
        nextId,
      };
    }
    case "status":
      return {
        items: ["CREATING", "RUNNING", "FINISHED"].includes(event.status)
          ? items
          : upsertEntry(
              items,
              `status-${assistantId}`,
              event.status === "ERROR" ? "error" : "status",
              "run",
              `${formatRunStatus(event.status)}${event.message ? ` ${event.message}` : ""}`,
            ),
        nextId,
      };
    case "task": {
      const text = compactText(
        [event.status, event.text].filter(Boolean).join(" "),
      );
      return {
        items: text
          ? upsertEntry(items, `task-${assistantId}`, "status", "task", text)
          : items,
        nextId,
      };
    }
    case "result": {
      const details = [
        event.status !== "finished" ? `status=${event.status}` : undefined,
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

      if (details.length === 0) {
        return { items, nextId };
      }

      return {
        items: [
          ...items,
          {
            id: String(nextId),
            kind: "meta",
            label: "done",
            text: details.join(" "),
          },
        ],
        nextId: nextId + 1,
      };
    }
  }
}

function appendAssistantDelta(
  items: TranscriptEntry[],
  assistantId: string,
  text: string,
) {
  const last = items.at(-1);

  if (
    last?.kind === "assistant" &&
    last.id.startsWith(`assistant-${assistantId}`)
  ) {
    return items.map((item, index) =>
      index === items.length - 1 ? { ...item, text: item.text + text } : item,
    );
  }

  const segmentCount = items.filter((item) =>
    item.id.startsWith(`assistant-${assistantId}`),
  ).length;

  return [
    ...items,
    {
      id: `assistant-${assistantId}-${segmentCount}`,
      kind: "assistant" as const,
      label: "agent",
      text,
    },
  ];
}

function upsertEntry(
  items: TranscriptEntry[],
  id: string,
  kind: TranscriptEntry["kind"],
  label: string,
  text: string,
) {
  const existingIndex = items.findIndex((item) => item.id === id);

  if (existingIndex === -1) {
    return [...items, { id, kind, label, text }];
  }

  return items.map((item, index) =>
    index === existingIndex ? { ...item, kind, label, text } : item,
  );
}

function compactText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function formatToolStatus(status: string) {
  switch (status) {
    case "requested":
      return "[ ]";
    case "running":
      return "[~]";
    case "completed":
      return "[x]";
    case "error":
      return "[!]";
    default:
      return status.toLowerCase();
  }
}

function formatToolIcon(name: string) {
  const key = name.toLowerCase();

  if (key.includes("read")) {
    return "[R]";
  }

  if (key.includes("glob") || key.includes("grep") || key.includes("search")) {
    return "[S]";
  }

  if (
    key.includes("shell") ||
    key.includes("terminal") ||
    key.includes("command")
  ) {
    return "$";
  }

  if (
    key.includes("edit") ||
    key.includes("write") ||
    key.includes("patch") ||
    key.includes("delete")
  ) {
    return "[E]";
  }

  if (key.includes("todo") || key.includes("task")) {
    return "[T]";
  }

  return "[*]";
}

function formatRunStatus(status: string) {
  switch (status) {
    case "ERROR":
      return "error";
    case "CANCELLED":
      return "cancelled";
    case "EXPIRED":
      return "expired";
    default:
      return status.toLowerCase();
  }
}

function filterModelItems(
  items: ModelSelectItem[],
  search: string,
  preference: ModelPreference,
) {
  const normalizedSearch = normalizeToken(search);

  return items.filter((item) => {
    const matchesSearch =
      !normalizedSearch ||
      normalizeToken(
        `${item.name} ${item.description} ${selectionSearchText(item.value)}`,
      ).includes(normalizedSearch);
    const matchesThinking =
      !preference.thinking ||
      getSelectionPreference(item.value, "thinking") === true;
    const matchesFast =
      !preference.fast || getSelectionPreference(item.value, "fast") === true;

    return matchesSearch && matchesThinking && matchesFast;
  });
}

function findPreferredSelection(
  current: ModelSelection,
  items: ModelSelectItem[],
  preference: ModelPreference,
) {
  const sameModelItems = items.filter((item) => item.value.id === current.id);

  if (sameModelItems.length === 0) {
    return undefined;
  }

  let candidates = sameModelItems;
  for (const key of ["thinking", "fast"] as const) {
    if (!modelSupportsPreference(sameModelItems, key)) {
      continue;
    }

    const desired = preference[key];
    const matching = candidates.filter((item) => {
      const value = getSelectionPreference(item.value, key);
      return desired ? value === true : value !== true;
    });

    if (matching.length > 0) {
      candidates = matching;
    }
  }

  return candidates.sort(
    (left, right) =>
      selectionOverlapScore(right.value, current) -
      selectionOverlapScore(left.value, current),
  )[0]?.value;
}

function modelSupportsPreference(
  items: ModelSelectItem[],
  preference: keyof ModelPreference,
) {
  return items.some(
    (item) => getSelectionPreference(item.value, preference) !== undefined,
  );
}

function getSelectionPreference(
  selection: ModelSelection,
  preference: keyof ModelPreference,
) {
  for (const param of selection.params ?? []) {
    const key = normalizeToken(`${param.id} ${param.value}`);
    if (key.includes(preference)) {
      return !isFalseValue(key);
    }
  }

  const idKey = normalizeToken(selection.id);
  return idKey.includes(preference) ? !isFalseValue(idKey) : undefined;
}

function selectionOverlapScore(left: ModelSelection, right: ModelSelection) {
  const rightParams = new Set(
    (right.params ?? []).map((param) => `${param.id}=${param.value}`),
  );

  return (left.params ?? []).filter((param) =>
    rightParams.has(`${param.id}=${param.value}`),
  ).length;
}

function selectionSearchText(selection: ModelSelection) {
  return [
    selection.id,
    ...(selection.params ?? []).flatMap((param) => [param.id, param.value]),
  ].join(" ");
}

function modelSelectionEquals(left: ModelSelection, right: unknown) {
  return (
    isModelSelection(right) &&
    modelKeyFromSelection(left) === modelKeyFromSelection(right)
  );
}

function modelKeyFromSelection(selection: ModelSelection) {
  return JSON.stringify({
    id: selection.id,
    params: [...(selection.params ?? [])].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
  });
}

function isModelSelection(value: unknown): value is ModelSelection {
  if (!hasStringProperty(value, "id")) {
    return false;
  }

  if (!("params" in value)) {
    return true;
  }

  const params = value.params;
  return (
    params === undefined ||
    (Array.isArray(params) &&
      params.every(
        (param) =>
          hasStringProperty(param, "id") && hasStringProperty(param, "value"),
      ))
  );
}

function hasStringProperty<K extends string>(
  value: unknown,
  key: K,
): value is Record<K, string> {
  if (typeof value !== "object" || value === null || !(key in value)) {
    return false;
  }

  return typeof Object.getOwnPropertyDescriptor(value, key)?.value === "string";
}

function isFalseValue(value: string) {
  return (
    value.includes("false") ||
    value.includes("off") ||
    value.includes("disabled") ||
    value.includes("disable") ||
    value.includes("none") ||
    value.includes("no")
  );
}

function normalizeToken(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9.]+/g, "");
}

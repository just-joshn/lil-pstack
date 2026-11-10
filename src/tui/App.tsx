import { InputRenderable, TextAttributes } from "@opentui/core";
import {
  extend,
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/react";
import { createElement, useEffect, useRef, useState } from "react";

import { CodingAgentSession } from "../agent.js";
import { cursorPorts } from "../cursor-ports.js";
import { performEffect } from "./runtime.js";
import {
  initialTuiState,
  reduceTui,
  type TranscriptViewLine,
  type TuiAction,
  type TuiState,
  type TuiStep,
} from "./state.js";
import type { ModelSelection } from "@cursor/sdk";

extend({ "tui-input": InputRenderable });

type TuiInputProps = {
  focused: boolean;
  placeholder: string;
  value: string;
  onInput: (value: string) => void;
  onSubmit: (value: string) => void;
};

function TuiInput(props: TuiInputProps) {
  return createElement("tui-input", props);
}

type TuiAppProps = {
  apiKey: string;
  cwd: string;
  force: boolean;
  initialModel: ModelSelection;
};

export function App({ apiKey, cwd, force, initialModel }: TuiAppProps) {
  const renderer = useRenderer();
  const { width: columns, height: rows } = useTerminalDimensions();
  const sessionRef = useRef<CodingAgentSession | null>(null);
  const bootRef = useRef<TuiStep | null>(null);
  const dimensionsRef = useRef({ columns, rows });

  if (!sessionRef.current) {
    sessionRef.current = new CodingAgentSession({
      apiKey,
      cwd,
      force,
      model: initialModel,
      ports: cursorPorts,
    });
  }

  if (!bootRef.current) {
    bootRef.current = reduceTui(
      initialTuiState({ model: initialModel, columns, rows, cwd }),
      { type: "resize", columns, rows },
    );
  }

  const stateRef = useRef<TuiState>(bootRef.current.state);
  const [step, setStep] = useState(bootRef.current);

  const dispatch = (action: TuiAction) => {
    const session = sessionRef.current;
    if (!session) {
      return;
    }

    const next = reduceTui(stateRef.current, action);
    stateRef.current = next.state;
    setStep(next);

    for (const effect of next.effects) {
      void performEffect(effect, {
        session,
        dispatch,
        exit: () => {
          renderer.destroy();
        },
      });
    }
  };

  useEffect(() => {
    const session = sessionRef.current;
    return () => {
      void session?.dispose();
    };
  }, []);

  useKeyboard((key) => {
    dispatch({
      type: "key",
      key: {
        name: key.name,
        ctrl: key.ctrl,
        meta: key.meta,
        shift: key.shift,
        sequence: key.sequence,
      },
    });
  });

  useEffect(() => {
    if (
      dimensionsRef.current.columns === columns &&
      dimensionsRef.current.rows === rows
    ) {
      return;
    }

    dimensionsRef.current = { columns, rows };
    dispatch({ type: "resize", columns, rows });
  }, [columns, rows]);

  const { state, view, chrome } = step;
  const placeholder = state.busy
    ? state.cancelRequested
      ? "Cancelling the current run..."
      : "Waiting for the current run... Ctrl+C to cancel"
    : "Ask or type /help";

  return (
    <box flexDirection="column" height={rows} paddingX={1}>
      <box flexDirection="column" height={chrome.viewportRows}>
        {view.map((line) => (
          <TranscriptLine key={line.id} line={line} />
        ))}
      </box>

      {chrome.maxScrollOffset > 0 ? (
        <text fg="gray">
          Scroll: Up/Down PgUp/PgDn Home/End -{" "}
          {state.scrollOffset === 0
            ? "at bottom"
            : `${state.scrollOffset} lines up`}
        </text>
      ) : null}

      {state.mode === "command" ? (
        <box
          border
          borderStyle="single"
          borderColor="cyan"
          flexDirection="column"
          marginTop={1}
          paddingX={1}
        >
          <text attributes={TextAttributes.BOLD}>Commands</text>
          <text fg="gray">Use arrows and Enter, or Escape to cancel.</text>
          <select
            focused
            height={chrome.commandRows}
            options={chrome.commandItems}
            onSelect={(_index, option) => {
              if (typeof option?.value === "string") {
                dispatch({ type: "select-command", name: option.value });
              }
            }}
            showDescription={false}
          />
        </box>
      ) : state.mode === "model" ? (
        <box
          border
          borderStyle="single"
          borderColor="magenta"
          flexDirection="column"
          marginTop={1}
          paddingX={1}
        >
          <text attributes={TextAttributes.BOLD}>Select a model</text>
          <text fg="gray">
            Type to search - T thinking{" "}
            {state.modelPreference.thinking ? "on" : "off"} - F fast{" "}
            {state.modelPreference.fast ? "on" : "off"} - Enter choose - Escape
            cancel
          </text>
          <text fg="gray">Search: {state.modelSearch || "all models"}</text>
          {state.loadingModels ? (
            <text fg="yellow">Loading models...</text>
          ) : chrome.filteredModels.length === 0 ? (
            <text fg="yellow">No matching models.</text>
          ) : (
            <select
              focused
              height={chrome.modelRows}
              options={chrome.filteredModels}
              onSelect={(_index, option) => {
                const pick = modelPick(option?.value);
                if (pick) {
                  dispatch({ type: "select-model", pick });
                }
              }}
              showScrollIndicator
            />
          )}
        </box>
      ) : (
        <box
          border
          borderStyle="single"
          borderColor={state.busy ? "yellow" : "green"}
          marginTop={1}
          paddingX={1}
        >
          <TuiInput
            focused={!state.busy}
            placeholder={placeholder}
            value={state.input}
            onInput={(value) => {
              dispatch({ type: "input", value });
            }}
            onSubmit={(value) => {
              dispatch({ type: "submit", value });
            }}
          />
        </box>
      )}
    </box>
  );
}

function modelPick(value: unknown): ModelSelection | undefined {
  if (!value || typeof value !== "object" || !("id" in value)) {
    return undefined;
  }
  if (typeof value.id !== "string") {
    return undefined;
  }
  return value as ModelSelection;
}

function TranscriptLine({ line }: { line: TranscriptViewLine }) {
  const color = {
    assistant: "white",
    error: "red",
    meta: "cyan",
    status: "yellow",
    tool: "magenta",
    user: "green",
  }[line.kind];

  return (
    <box>
      <text fg={color} attributes={TextAttributes.BOLD}>
        {line.label.padEnd(7)}
      </text>
      <text>
        {line.parts.map((part, index) => (
          <span key={index} attributes={partAttributes(part)} fg={part.color}>
            {part.text}
          </span>
        ))}
      </text>
    </box>
  );
}

function partAttributes(part: TranscriptViewLine["parts"][number]) {
  let attributes = TextAttributes.NONE;
  if (part.bold) {
    attributes |= TextAttributes.BOLD;
  }
  if (part.dimColor) {
    attributes |= TextAttributes.DIM;
  }
  return attributes;
}

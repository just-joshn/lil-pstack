import type { CodingAgentSession } from "../agent.js";
import type { TuiAction, TuiEffect } from "./state.js";

export type TuiRuntime = {
  session: CodingAgentSession;
  dispatch: (action: TuiAction) => void;
  exit: () => void;
};

export async function performEffect(
  effect: TuiEffect,
  runtime: TuiRuntime,
): Promise<void> {
  try {
    switch (effect.type) {
      case "exit":
        runtime.exit();
        return;
      case "load-models": {
        const choices = await runtime.session.listModels();
        runtime.dispatch({ type: "models-loaded", choices });
        return;
      }
      case "switch-mode": {
        await runtime.session.setExecutionMode(effect.mode);
        runtime.dispatch({
          type: "mode-switched",
          mode: effect.mode,
          target: runtime.session.executionTarget,
        });
        return;
      }
      case "reset":
        await runtime.session.reset();
        runtime.dispatch({ type: "reset-done" });
        return;
      case "set-model":
        runtime.session.setModel(effect.pick);
        return;
      case "send-prompt":
        await runtime.session.sendPrompt({
          prompt: effect.text,
          onEvent: (event) => {
            runtime.dispatch({
              type: "agent-event",
              event,
              runId: effect.runId,
            });
          },
        });
        runtime.dispatch({ type: "run-finished" });
        return;
      case "cancel": {
        const result = await runtime.session.cancelCurrentRun();
        runtime.dispatch({ type: "cancel-result", result });
        return;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    switch (effect.type) {
      case "load-models":
        runtime.dispatch({ type: "models-failed", message });
        return;
      case "switch-mode":
        runtime.dispatch({ type: "mode-switch-failed", message });
        return;
      case "reset":
        runtime.dispatch({ type: "reset-failed", message });
        return;
      case "send-prompt":
        runtime.dispatch({ type: "run-failed", message });
        return;
      case "cancel":
        runtime.dispatch({ type: "cancel-failed", message });
        return;
      default:
        return;
    }
  }
}

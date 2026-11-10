import { describe, expect, test } from "bun:test";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import React from "react";

describe("opentui 0.8.3", () => {
  test("createRoot can render a box and text", async () => {
    const renderer = await createCliRenderer({
      exitOnCtrlC: true,
      maxFps: 30,
      screenMode: "alternate-screen",
    });
    const root = createRoot(renderer);

    try {
      root.render(
        React.createElement(
          "box",
          { flexGrow: 1 },
          React.createElement("text", null, "opentui-smoke-ok"),
        ),
      );
      await Bun.sleep(50);
      expect(renderer.isDestroyed).toBe(false);
    } finally {
      root.unmount();
      if (!renderer.isDestroyed) {
        renderer.destroy();
      }
    }
  });
});

import { describe, expect, test } from "vitest";
import config from "../vitest.config.ts";

describe("coverage denominator", () => {
  test("counts every runtime src file and requires 80% branches", () => {
    const coverage = config.test?.coverage;
    expect(coverage).toMatchObject({
      enabled: true,
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.d.ts"],
      thresholds: { branches: 80 },
    });
    expect(config.test?.exclude).toEqual([
      "vendor/**",
      "node_modules/**",
      "dist/**",
    ]);
  });
});

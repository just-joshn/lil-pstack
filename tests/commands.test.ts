import { describe, expect, test } from "vitest";
import {
  formatSlashCommandHelp,
  getSlashCommand,
  getSlashCommandItems,
  slashCommands,
} from "../src/commands.ts";

describe("slash commands", () => {
  test.for(slashCommands)("$name is a command", ({ name, summary }) => {
    expect(getSlashCommand(`${name} now`)).toBe(name);
    expect(getSlashCommandItems(name).map((item) => item.value)).toContain(
      name,
    );
    expect(formatSlashCommandHelp()).toContain(`${name} - ${summary}`);
  });

  test.for(["", "   ", "/nope"])("%j is not a command", (input) => {
    expect(getSlashCommand(input)).toBeUndefined();
  });

  test("an empty query lists every command", () => {
    expect(getSlashCommandItems("").map((item) => item.value)).toEqual(
      slashCommands.map((command) => command.name),
    );
  });
});

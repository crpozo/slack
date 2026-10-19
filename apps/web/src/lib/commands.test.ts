import { describe, expect, it } from "vitest";
import {
  applyCommand,
  commandQuery,
  matchCommands,
  parseCommand,
  SLASH_COMMANDS,
} from "./commands";

describe("slash commands", () => {
  it("knows when a command is being typed and filters as you go", () => {
    expect(commandQuery("/")).toBe("");
    expect(commandQuery("/se")).toBe("se");
    expect(commandQuery("/secret hi")).toBeNull(); // chosen: the popover closes
    expect(commandQuery("hello /secret")).toBeNull();
    expect(matchCommands("").map((c) => c.name)).toEqual(SLASH_COMMANDS.map((c) => c.name));
    expect(matchCommands("s").map((c) => c.name)).toEqual(["secret", "shrug"]);
    expect(matchCommands("x")).toEqual([]);
  });

  it("parses and applies a complete command", () => {
    expect(parseCommand("/shrug it works")).toMatchObject({ rest: "it works" });
    expect(applyCommand(parseCommand("/shrug it works")!.command, "it works")).toBe(
      "it works ¯\\_(ツ)_/¯",
    );
    expect(applyCommand(parseCommand("/clear")!.command, "")).toBe("");
    expect(parseCommand("/nope x")).toBeNull();
    expect(parseCommand("plain")).toBeNull();
  });
});

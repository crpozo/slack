/**
 * Slash commands the composer offers when a message starts with `/`. Each
 * one either changes how the message is sent (`mode`) or runs at once.
 * Adding a command here is all it takes for it to show in the popover.
 */
export interface SlashCommand {
  /** Without the slash. */
  name: string;
  description: string;
  /** Shown after the name, e.g. "[text]". */
  usage?: string;
  /**
   * `secret`: the rest of the line is sent as a secret (masked, 24-hour TTL).
   * `shrug`: appends ¯\_(ツ)_/¯ to the text. `clear`: empties the composer.
   */
  effect: "secret" | "shrug" | "clear";
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: "secret",
    description: "Send a password or key masked, deleted after 24 hours",
    usage: "[text]",
    effect: "secret",
  },
  {
    name: "shrug",
    description: "Add ¯\\_(ツ)_/¯ to your message",
    usage: "[text]",
    effect: "shrug",
  },
  { name: "clear", description: "Clear what you've typed", effect: "clear" },
];

/**
 * The command being typed: `text` starts with `/` and has no space yet (the
 * command is still being chosen). Returns the partial name, lowercased.
 */
export function commandQuery(text: string): string | null {
  const m = /^\/([a-z0-9-]*)$/i.exec(text);
  return m ? m[1]!.toLowerCase() : null;
}

/** Commands whose name starts with `query` (all of them for an empty query). */
export function matchCommands(query: string): SlashCommand[] {
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(query));
}

/** A complete command at the start of `text`: its definition and the text after it. */
export function parseCommand(text: string): { command: SlashCommand; rest: string } | null {
  const m = /^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/i.exec(text.trimStart());
  if (!m) return null;
  const command = SLASH_COMMANDS.find((c) => c.name === m[1]!.toLowerCase());
  return command ? { command, rest: m[2] ?? "" } : null;
}

/** Text with `command` applied: `/shrug hi` → "hi ¯\_(ツ)_/¯", `/clear` → "". */
export function applyCommand(command: SlashCommand, rest: string): string {
  switch (command.effect) {
    case "shrug":
      return `${rest.trim()} ¯\\_(ツ)_/¯`.trim();
    case "clear":
      return "";
    case "secret":
      return rest;
  }
}

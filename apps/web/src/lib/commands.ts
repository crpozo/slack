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
   * `secret` (Phase 45): `/secret <title> <password>` saves to the Vault and
   * posts a 🔒 card; `/secret` alone turns on secret mode (masked, 24-hour TTL).
   * `shrug`: appends ¯\_(ツ)_/¯ to the text. `clear`: empties the composer.
   * `ventas` (Phase 73): opens the sales assistant where the words after it say.
   */
  effect: "secret" | "shrug" | "clear" | "ventas";
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: "secret",
    description: "Save a password to the Vault and share it here",
    usage: "[title] [password]",
    effect: "secret",
  },
  {
    name: "shrug",
    description: "Add ¯\\_(ツ)_/¯ to your message",
    usage: "[text]",
    effect: "shrug",
  },
  { name: "clear", description: "Clear what you've typed", effect: "clear" },
  {
    name: "ventas",
    description: "Asistente de ventas: pronóstico, cuenta, preparar, seguimiento, estrategia, demo",
    usage: "[acción] [cuenta]",
    effect: "ventas",
  },
];

const SALES_TABS_BY_WORD: Record<string, string> = {
  panel: "panel",
  cuentas: "cuentas",
  pronostico: "pronostico",
  liderazgo: "liderazgo",
  prospeccion: "prospeccion",
  respuestas: "conocimiento",
  coaching: "coaching",
  demo: "demo",
};
/** What `/ventas preparar Acme` starts, by its first word. */
export const SALES_ACTIONS = [
  "cuenta",
  "preparar",
  "seguimiento",
  "estrategia",
  "senales",
] as const;
export type SalesAction = (typeof SALES_ACTIONS)[number];

/**
 * Where `/ventas <words>` goes (Phase 73): a section ("pronóstico", "demo"),
 * or an action on an account by name ("preparar Farmacias Andina": the view
 * finds the account and starts that flow). Anything else: the panel.
 */
export function salesCommandPath(rest: string): string {
  const words = rest.trim().split(/\s+/).filter(Boolean);
  const first = (words[0] ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const tab = SALES_TABS_BY_WORD[first];
  if (tab) return `/app/sales?tab=${tab}`;
  if ((SALES_ACTIONS as readonly string[]).includes(first) && words.length > 1) {
    const params = new URLSearchParams({ tab: "cuentas", q: words.slice(1).join(" ") });
    if (first !== "cuenta") params.set("do", first);
    return `/app/sales?${params.toString()}`;
  }
  return words.length
    ? `/app/sales?${new URLSearchParams({ tab: "cuentas", q: words.join(" ") }).toString()}`
    : "/app/sales";
}

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
  const m = /^\/([a-z0-9-]+)(?:\s+(?!\s)([\s\S]*))?$/i.exec(text.trimStart());
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
    case "ventas":
      return "";
  }
}

/**
 * Goes to a path of the app from outside a route component (the composer is
 * also rendered on its own): the address changes and the router, which
 * listens for it, follows.
 */
export function openAppPath(path: string): void {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

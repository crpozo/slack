// @vitest-environment jsdom
import type { Channel } from "@mindfultech/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../store";
import { Composer } from "./Composer";

const ME = { userId: "u-me", email: "me@example.com", role: "member" as const };
const CH = "ch_01M5AX1ZE3W7YWWKGMD47X55B4";
const channel: Channel = {
  channelId: CH,
  name: "proyecto-x",
  type: "public",
  createdBy: ME.userId,
  createdAt: 1,
  archived: false,
};

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    })),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  localStorage.clear();
  useChat.setState({
    me: ME,
    channels: [channel],
    channelsLoaded: true,
    users: {
      [ME.userId]: { userId: ME.userId, email: ME.email, displayName: "me", updatedAt: 1 },
      "u-martin": {
        userId: "u-martin",
        email: "martin@client.com",
        displayName: "martin",
        updatedAt: 1,
        role: "guest",
      },
      "u-rene": { userId: "u-rene", email: "rene@example.com", displayName: "René", updatedAt: 1 },
    },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const clipboard = (data: Record<string, string>) => ({
  files: [] as unknown as FileList,
  getData: (type: string) => data[type] ?? "",
});

describe("pasting into the composer (Phase 54)", () => {
  it("turns formatted text into the markdown messages render", () => {
    render(<Composer channelId={CH} placeholder="Message" />);
    const box = screen.getByPlaceholderText("Message") as HTMLTextAreaElement;
    fireEvent.paste(box, {
      clipboardData: clipboard({
        "text/plain": "Plan\nInventario: tabla",
        "text/html": "<p>Plan</p><ol><li><strong>Inventario</strong>: tabla</li></ol>",
      }),
    });
    expect(box.value).toBe("Plan\n1. **Inventario**: tabla");
  });

  it("leaves a plain paste to the browser", () => {
    render(<Composer channelId={CH} placeholder="Message" />);
    const box = screen.getByPlaceholderText("Message") as HTMLTextAreaElement;
    const event = fireEvent.paste(box, {
      clipboardData: clipboard({ "text/plain": "hola", "text/html": "<p>hola</p>" }),
    });
    // Not cancelled: the browser inserts the plain text itself.
    expect(event).toBe(true);
    expect(box.value).toBe("");
  });
});

describe("a message over the limit (Phase 55)", () => {
  it("shows the count and why, and can't be sent, instead of failing after", () => {
    render(<Composer channelId={CH} placeholder="Message" />);
    const box = screen.getByPlaceholderText("Message") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "a".repeat(9_000) } });
    expect(screen.getByText(/9,000 \/ 10,000/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(box, { target: { value: "a".repeat(10_001) } });
    expect(screen.getByRole("alert").textContent).toMatch(/Too long to send/);
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("mentioning someone (Phase 56)", () => {
  const type = (box: HTMLTextAreaElement, value: string) => {
    fireEvent.change(box, { target: { value, selectionStart: value.length } });
    box.setSelectionRange(value.length, value.length);
    fireEvent.select(box);
  };

  it("suggests the conversation's people as you type @, and Enter writes the handle", () => {
    // A private channel with an external in it: only its members are suggested.
    useChat.setState({
      channels: [{ ...channel, type: "private", members: [ME.userId, "u-martin"] }],
    });
    render(<Composer channelId={CH} placeholder="Message" />);
    const box = screen.getByPlaceholderText("Message") as HTMLTextAreaElement;
    type(box, "hola @mar");
    const menu = screen.getByRole("listbox", { name: "Mention someone" });
    expect(menu.textContent).toContain("martin");
    expect(menu.textContent).toContain("External");
    expect(menu.textContent).not.toContain("René");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box.value).toBe("hola @martin ");
    expect(screen.queryByRole("listbox", { name: "Mention someone" })).toBeNull();
  });

  it("in a public channel, suggests the team, never an external", () => {
    render(<Composer channelId={CH} placeholder="Message" />);
    const box = screen.getByPlaceholderText("Message") as HTMLTextAreaElement;
    type(box, "@");
    const menu = screen.getByRole("listbox", { name: "Mention someone" });
    expect(menu.textContent).toContain("René");
    expect(menu.textContent).not.toContain("martin");
  });

  it("Escape closes the list; an email address never opens it", () => {
    render(<Composer channelId={CH} placeholder="Message" />);
    const box = screen.getByPlaceholderText("Message") as HTMLTextAreaElement;
    type(box, "@");
    expect(screen.getByRole("listbox", { name: "Mention someone" })).toBeTruthy();
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Mention someone" })).toBeNull();
    type(box, "rene@exam");
    expect(screen.queryByRole("listbox", { name: "Mention someone" })).toBeNull();
  });
});

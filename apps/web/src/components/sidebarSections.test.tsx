// @vitest-environment jsdom
import type { Channel } from "@mindfultech/shared";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chat } from "../lib/chat";
import { useChat } from "../store";
import { Sidebar } from "./Sidebar";

const ME = { userId: "u-ana", email: "ana@example.com", role: "admin" as const };
const channel = (channelId: string, name: string, extra: Partial<Channel> = {}): Channel => ({
  channelId,
  name,
  type: "private",
  createdBy: ME.userId,
  createdAt: 1,
  archived: false,
  members: [ME.userId],
  ...extra,
});

beforeEach(() => {
  // jsdom has no ResizeObserver (the ⋯ menu's popover places itself with one).
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
  useChat.setState({
    me: ME,
    pinned: [],
    channelsLoaded: true,
    channels: [
      channel("ch_general", "general", { type: "public" }),
      channel("ch_news", "News/Tools"),
      channel("ch_web", "Paymerch Website", { isProject: true }),
      channel("ch_clinic", "ClinicAI"),
    ],
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderSidebar() {
  render(
    <MemoryRouter>
      <Sidebar
        activeChannelId=""
        collapsed={false}
        onOpenSwitcher={() => {}}
        onCreateChannel={() => {}}
        onNewDm={() => {}}
        onOpenSettings={() => {}}
        onSignOut={() => {}}
      />
    </MemoryRouter>,
  );
}
const names = (list: HTMLElement) =>
  within(list)
    .getAllByRole("listitem")
    .map((li) => li.textContent?.trim());

describe("the sidebar's Updates section (Phase 53)", () => {
  it("lists News/Tools apart from the project channels", () => {
    renderSidebar();
    const info = screen.getByRole("list", { name: "Updates" });
    expect(names(info)).toEqual([expect.stringContaining("News/Tools")]);
    expect(screen.getByRole("heading", { name: "Channels" })).toBeTruthy();
    expect(within(info).queryByText("ClinicAI")).toBeNull();
  });

  it("moves a channel in or out from its ⋯ menu", () => {
    const update = vi.spyOn(chat, "updateChannel").mockImplementation(() => {});
    renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "More options for News/Tools" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Move to Channels/ }));
    expect(update).toHaveBeenCalledWith("ch_news", { informational: false });

    fireEvent.click(screen.getByRole("button", { name: "More options for ClinicAI" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Move to Updates/ }));
    expect(update).toHaveBeenCalledWith("ch_clinic", { informational: true });
  });

  it("follows the stored choice", () => {
    useChat.setState((s) => ({
      channels: s.channels.map((c) =>
        c.channelId === "ch_news" ? { ...c, informational: false } : c,
      ),
    }));
    renderSidebar();
    expect(screen.queryByRole("list", { name: "Updates" })).toBeNull();
  });
});

describe("your own channel order (Phase 53)", () => {
  const channelRows = () =>
    within(screen.getByRole("heading", { name: "Channels" }).closest("section")!)
      .getAllByRole("listitem")
      .map((li) => li.textContent?.trim());

  it("lists the channels in your order", () => {
    useChat.setState({ channelOrder: ["ch_clinic", "ch_web", "ch_general"] });
    renderSidebar();
    expect(channelRows()).toEqual([
      expect.stringContaining("ClinicAI"),
      expect.stringContaining("Paymerch Website"),
      expect.stringContaining("general"),
    ]);
  });

  it("moves a channel up or down from its ⋯ menu (phones too), within its section", () => {
    useChat.setState({ channelOrder: ["ch_general", "ch_web", "ch_clinic"] });
    const save = vi.spyOn(chat, "setChannelOrder").mockImplementation(() => {});
    renderSidebar();
    // ClinicAI is last in Channels (News/Tools is in Updates): only Move up.
    fireEvent.click(screen.getByRole("button", { name: "More options for ClinicAI" }));
    expect(screen.queryByRole("menuitem", { name: /Move down/ })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: /Move up/ }));
    expect(save).toHaveBeenLastCalledWith(["ch_general", "ch_clinic", "ch_web", "ch_news"]);
  });

  it("drags a channel onto another to take its place", () => {
    useChat.setState({ channelOrder: ["ch_general", "ch_web", "ch_clinic"] });
    const save = vi.spyOn(chat, "setChannelOrder").mockImplementation(() => {});
    renderSidebar();
    const row = (name: string) => screen.getByRole("button", { name }).closest("li")!;
    const dataTransfer = { setData: () => {}, effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(row("ClinicAI"), { dataTransfer });
    fireEvent.dragOver(row("general"), { dataTransfer });
    fireEvent.drop(row("general"), { dataTransfer });
    expect(save).toHaveBeenLastCalledWith(["ch_clinic", "ch_general", "ch_web", "ch_news"]);
    // Not across sections: Updates and Channels keep their own lists.
    save.mockClear();
    fireEvent.dragStart(row("News/Tools"), { dataTransfer });
    fireEvent.dragOver(row("general"), { dataTransfer });
    fireEvent.drop(row("general"), { dataTransfer });
    expect(save).not.toHaveBeenCalled();
  });
});

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

describe("the sidebar's Informational section (Phase 53)", () => {
  it("lists News/Tools apart from the project channels", () => {
    renderSidebar();
    const info = screen.getByRole("list", { name: "Informational channels" });
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
    fireEvent.click(screen.getByRole("menuitem", { name: /Move to Informational/ }));
    expect(update).toHaveBeenCalledWith("ch_clinic", { informational: true });
  });

  it("follows the stored choice", () => {
    useChat.setState((s) => ({
      channels: s.channels.map((c) =>
        c.channelId === "ch_news" ? { ...c, informational: false } : c,
      ),
    }));
    renderSidebar();
    expect(screen.queryByRole("list", { name: "Informational channels" })).toBeNull();
  });
});

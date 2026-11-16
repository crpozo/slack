// @vitest-environment jsdom
import type { Channel, Role } from "@mindfultech/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chat } from "../lib/chat";
import { DISCOVERY_URL } from "../lib/config";
import { useChat } from "../store";
import { useTasks } from "../store/tasks";
import { GuestLayout } from "./GuestLayout";
import { Sidebar } from "./Sidebar";

// Phase 68: the team's sidebar links to Discovery; guests never see it.

const me = (role: Role) => ({ userId: "u-ana", email: "ana@example.com", role });
const cambridge: Channel = {
  channelId: "ch_cambridge",
  name: "Cambridge",
  type: "private",
  createdBy: "u-bob",
  createdAt: 1,
  archived: false,
  members: ["u-bob", "u-ana"],
};

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
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
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
  useChat.setState({ pinned: [], channelsLoaded: true, channels: [cambridge] });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const renderSidebar = () =>
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

const discoveryLink = () => screen.queryByRole("link", { name: /Discovery/ });

describe("the Discovery link (Phase 68)", () => {
  it.each(["member", "admin"] as const)(
    "is in the sidebar's Apps for a %s, in a new tab",
    (role) => {
      useChat.setState({ me: me(role) });
      renderSidebar();
      const link = discoveryLink();
      expect(link).not.toBeNull();
      expect(link!.getAttribute("href")).toBe(DISCOVERY_URL);
      expect(DISCOVERY_URL).toBe("https://discovery.mindfultech.ec");
      expect(link!.getAttribute("target")).toBe("_blank");
      expect(link!.getAttribute("rel")).toMatch(/\bnoopener\b/);
    },
  );

  it("is not in the sidebar for a guest", () => {
    useChat.setState({ me: me("guest") });
    renderSidebar();
    expect(discoveryLink()).toBeNull();
    expect(document.querySelector(`a[href^="${DISCOVERY_URL}"]`)).toBeNull();
  });

  it("is nowhere in the guest layout", () => {
    vi.spyOn(chat, "start").mockImplementation(() => {});
    vi.spyOn(chat, "stop").mockImplementation(() => {});
    vi.spyOn(chat, "loadHistory").mockImplementation(() => {});
    vi.spyOn(chat, "viewed").mockImplementation(() => {});
    vi.spyOn(useTasks.getState(), "loadBoards").mockResolvedValue();
    useTasks.setState({ boards: [], boardsLoaded: true });
    useChat.setState({ me: me("guest") });
    render(
      <MemoryRouter initialEntries={["/app/ch_cambridge"]}>
        <Routes>
          <Route path="/app/:channelId" element={<GuestLayout wsUrl="ws://test" />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getAllByText("Cambridge").length).toBeGreaterThan(0);
    expect(discoveryLink()).toBeNull();
    expect(document.body.textContent).not.toMatch(/Discovery/);
    expect(document.querySelector(`a[href^="${DISCOVERY_URL}"]`)).toBeNull();
  });
});

// @vitest-environment jsdom
import { GENERAL_CHANNEL_ID, type Channel } from "@mindfultech/shared";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chat } from "../lib/chat";
import { loadRecents, recordVisit } from "../lib/recents";
import { useChat } from "../store";
import { ChannelView } from "./ChannelView";
import { EditChannelModal } from "./ChannelModals";
import { Sidebar } from "./Sidebar";
import { Composer } from "./Composer";

// Regression: archiving the open channel (or opening an archived channel's
// link) crashed the whole app to a blank screen. The composer returned its
// "archived" note early, before some of its hooks, so when a mounted
// composer's channel became archived React threw "Rendered fewer hooks than
// expected", and with no error boundary the root unmounted.

const ME = { userId: "u-me", email: "me@example.com", role: "member" as const };
const CH = "ch_01M5AX1ZE3W7YWWKGMD47X55B4";

const channel = (patch: Partial<Channel> = {}): Channel => ({
  channelId: CH,
  name: "proyecto-x",
  type: "public",
  createdBy: ME.userId,
  createdAt: 2,
  archived: false,
  ...patch,
});
const general: Channel = {
  channelId: GENERAL_CHANNEL_ID,
  name: "general",
  type: "public",
  createdBy: "system",
  createdAt: 1,
  archived: false,
};

/** Where the router is now. */
function Location() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

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
  // jsdom has <dialog> without its modal methods.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
  localStorage.clear();
  useChat.setState({ me: ME, channels: [], channelsLoaded: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the composer when its channel is archived", () => {
  it("turns into the archived note (with Unarchive) while on screen, and back", () => {
    useChat.setState({ channels: [channel()], channelsLoaded: true });
    const { rerender } = render(<Composer channelId={CH} placeholder="Message #proyecto-x" />);
    expect(screen.getByPlaceholderText("Message #proyecto-x")).toBeTruthy();

    // The crash: the same mounted composer told its channel is archived now.
    useChat.setState({ channels: [channel({ archived: true })] });
    rerender(<Composer channelId={CH} placeholder="Message #proyecto-x" readOnly />);
    expect(screen.getByText(/This channel is archived/)).toBeTruthy();
    expect(screen.queryByPlaceholderText("Message #proyecto-x")).toBeNull();

    // Its creator can restore it from right there.
    const update = vi.spyOn(chat, "updateChannel").mockImplementation(() => {});
    fireEvent.click(screen.getByRole("button", { name: "Unarchive" }));
    expect(update).toHaveBeenCalledWith(CH, { archived: false });

    useChat.setState({ channels: [channel()] });
    rerender(<Composer channelId={CH} placeholder="Message #proyecto-x" />);
    expect(screen.getByPlaceholderText("Message #proyecto-x")).toBeTruthy();
  });

  it("offers no Unarchive to someone who may not restore the channel", () => {
    useChat.setState({
      channels: [channel({ archived: true, createdBy: "u-someone-else" })],
      channelsLoaded: true,
    });
    render(<Composer channelId={CH} placeholder="x" readOnly />);
    expect(screen.getByText(/This channel is archived/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Unarchive" })).toBeNull();
  });
});

describe("opening a channel by its link", () => {
  const openAt = (path: string) =>
    render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/app/:channelId"
            element={<ChannelView channelId={path.split("/")[2]!} onOpenSidebar={() => {}} />}
          />
        </Routes>
      </MemoryRouter>,
    );

  it("shows an archived channel read-only once the list arrives (it used to crash)", () => {
    openAt(`/app/${CH}`); // before the channel list: the composer mounts
    act(() => useChat.getState().setChannels([general, channel({ archived: true })]));
    expect(screen.getAllByText(/This channel is archived/).length).toBeGreaterThan(0);
    expect(screen.queryByRole("textbox", { name: /message/i })).toBeNull();
  });

  it("says a channel that doesn't exist doesn't, with a way to #general", () => {
    openAt("/app/ch_DOESNOTEXIST");
    act(() => useChat.getState().setChannels([general]));
    expect(screen.getByText(/doesn't exist or you don't have access/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to #general" }).getAttribute("href")).toBe(
      `/app/${GENERAL_CHANNEL_ID}`,
    );
  });
});

describe("archiving the channel you're in", () => {
  function archiveFrom(path: string, channels: Channel[]) {
    useChat.setState({ channels, channelsLoaded: true });
    const update = vi.spyOn(chat, "updateChannel").mockImplementation(() => {});
    const onClose = vi.fn();
    render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <EditChannelModal
                  channel={channels.find((c) => c.channelId === CH)!}
                  onClose={onClose}
                />
                <Location />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Archive channel" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, archive" }));
    return { update, onClose, location: () => screen.getByTestId("location").textContent };
  }

  it("goes to #general, forgets it as a recent place, and says where it went", () => {
    recordVisit(ME.userId, GENERAL_CHANNEL_ID, 1);
    recordVisit(ME.userId, CH, 2);
    const { update, onClose, location } = archiveFrom(`/app/${CH}`, [general, channel()]);
    expect(update).toHaveBeenCalledWith(CH, { archived: true });
    expect(onClose).toHaveBeenCalled();
    expect(location()).toBe(`/app/${GENERAL_CHANNEL_ID}`);
    expect(loadRecents(ME.userId).map((r) => r.channelId)).toEqual([GENERAL_CHANNEL_ID]);
    expect(useChat.getState().toast?.message).toMatch(/#proyecto-x archived/);
  });

  it("from one of its threads too; elsewhere, you stay where you are", () => {
    expect(archiveFrom(`/app/${CH}/thread/m1`, [general, channel()]).location()).toBe(
      `/app/${GENERAL_CHANNEL_ID}`,
    );
    cleanup();
    expect(archiveFrom("/app/tasks", [general, channel()]).location()).toBe("/app/tasks");
  });

  it("without #general, to the first channel that's still active", () => {
    const other: Channel = { ...general, channelId: "ch_other", name: "other" };
    const old: Channel = { ...general, channelId: "ch_old", name: "old", archived: true };
    expect(archiveFrom(`/app/${CH}`, [old, other, channel()]).location()).toBe("/app/ch_other");
  });
});

describe("archiving from the sidebar's ⋯ menu", () => {
  function renderSidebar(path: string, channels: Channel[], me = ME) {
    useChat.setState({ me, channels, channelsLoaded: true });
    return render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <Sidebar
                  activeChannelId={CH}
                  collapsed={false}
                  onOpenSwitcher={() => {}}
                  onCreateChannel={() => {}}
                  onNewDm={() => {}}
                  onOpenSettings={() => {}}
                  onSignOut={() => {}}
                />
                <Location />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
  }
  const openMenu = (name: string) =>
    fireEvent.click(screen.getByRole("button", { name: `More options for ${name}` }));

  it("offers Archive channel next to Pin, Edit and Delete, and archives with the safe redirect", () => {
    recordVisit(ME.userId, CH, 2);
    const update = vi.spyOn(chat, "updateChannel").mockImplementation(() => {});
    renderSidebar(`/app/${CH}`, [general, channel()]);
    openMenu("proyecto-x");
    const items = screen.getAllByRole("menuitem").map((i) => i.textContent?.trim());
    expect(items).toEqual([
      "Pin to the top",
      "Move up",
      "Edit channel",
      "Move to Knowledge",
      "Archive channel",
      "Delete channel",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: /Archive channel/ }));
    // A confirmation first: nothing happens until it's confirmed.
    expect(update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^Archive$/ }));
    expect(update).toHaveBeenCalledWith(CH, { archived: true });
    expect(screen.getByTestId("location").textContent).toBe(`/app/${GENERAL_CHANNEL_ID}`);
    expect(loadRecents(ME.userId).map((r) => r.channelId)).not.toContain(CH);
    expect(useChat.getState().toast?.message).toMatch(/#proyecto-x archived/);
  });

  it("stays where you are when you archive another channel, and Cancel archives nothing", () => {
    const update = vi.spyOn(chat, "updateChannel").mockImplementation(() => {});
    const other: Channel = { ...channel(), channelId: "ch_other", name: "other" };
    renderSidebar(`/app/${CH}`, [general, channel(), other]);
    openMenu("other");
    fireEvent.click(screen.getByRole("menuitem", { name: /Archive channel/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(update).not.toHaveBeenCalled();
    openMenu("other");
    fireEvent.click(screen.getByRole("menuitem", { name: /Archive channel/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Archive$/ }));
    expect(update).toHaveBeenCalledWith("ch_other", { archived: true });
    expect(screen.getByTestId("location").textContent).toBe(`/app/${CH}`);
  });

  it("isn't offered to someone who may not archive the channel, nor on #general", () => {
    renderSidebar(`/app/${CH}`, [general, channel({ createdBy: "u-someone" })]);
    openMenu("proyecto-x");
    expect(screen.queryByRole("menuitem", { name: /Archive channel/ })).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    cleanup();
    renderSidebar(`/app/${CH}`, [general, channel()], { ...ME, role: "admin" as never });
    openMenu("general");
    expect(screen.queryByRole("menuitem", { name: /Archive channel/ })).toBeNull();
  });
});

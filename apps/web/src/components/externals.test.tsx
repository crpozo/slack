// @vitest-environment jsdom
import type { Channel } from "@mindfultech/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chat } from "../lib/chat";
import { channelsApi, configureTasksApi } from "../lib/tasksApi";
import { useChat } from "../store";
import { InviteModal } from "./ChannelModals";
import { ConversationDetailsModal } from "./ConversationPanels";
import { GuestLayout } from "./GuestLayout";
import { useTasks } from "../store/tasks";

// Phase 55: people from outside MindfulTech in private channels.

const ME = { userId: "u-ana", email: "ana@example.com", role: "member" as const };
const CLIENT = {
  userId: "u-client",
  email: "client@acme.com",
  displayName: "client",
  updatedAt: 1,
  role: "guest" as const,
};
const BOB = { userId: "u-bob", email: "bob@example.com", displayName: "bob", updatedAt: 1 };
const cambridge: Channel = {
  channelId: "ch_cambridge",
  name: "Cambridge",
  type: "private",
  createdBy: ME.userId,
  createdAt: 1,
  archived: false,
  members: [ME.userId, BOB.userId, CLIENT.userId],
};

beforeEach(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
  configureTasksApi("https://api.fake.example");
  useChat.setState({
    me: ME,
    channels: [cambridge],
    channelsLoaded: true,
    users: {
      [ME.userId]: { userId: ME.userId, email: ME.email, displayName: "ana", updatedAt: 1 },
      [BOB.userId]: BOB,
      [CLIENT.userId]: CLIENT,
    },
    online: {},
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("inviting someone from outside MindfulTech", () => {
  it("sends the invite by email and says they'll only see this channel", async () => {
    const invite = vi.spyOn(channelsApi, "inviteByEmail").mockResolvedValue({
      channel: cambridge,
      invited: { userId: "u-new", role: "guest", created: true },
    });
    vi.spyOn(chat, "refreshUsers").mockImplementation(() => {});
    render(<InviteModal channel={{ ...cambridge, members: [ME.userId] }} onClose={() => {}} />);
    expect(screen.getByText(/they see only/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Invite someone outside MindfulTech"), {
      target: { value: "  new@client.com " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
    await waitFor(() => expect(invite).toHaveBeenCalledWith("ch_cambridge", "new@client.com"));
    await waitFor(() => expect(useChat.getState().toast?.message).toMatch(/only see #Cambridge/));
  });

  it("marks externals in the list and warns before adding one", () => {
    render(<InviteModal channel={{ ...cambridge, members: [ME.userId] }} onClose={() => {}} />);
    expect(screen.getByText("External")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /client/ }));
    expect(screen.getByRole("note").textContent).toMatch(/outside MindfulTech/);
  });
});

describe("a channel's members, with externals", () => {
  const open = () =>
    render(
      <MemoryRouter>
        <ConversationDetailsModal
          channelId="ch_cambridge"
          title="#Cambridge"
          initialTab="members"
          onClose={() => {}}
          onJump={() => {}}
          onEdit={() => {}}
        />
      </MemoryRouter>,
    );

  it("says who's from outside, and lets the creator take them out (two taps)", () => {
    const remove = vi.spyOn(chat, "removeMember").mockImplementation(() => {});
    open();
    expect(screen.getByText(/from outside\s+MindfulTech can read everything here/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove client from the channel" }));
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(remove).toHaveBeenCalledWith("ch_cambridge", CLIENT.userId);
  });

  it("offers no removal to other members", () => {
    useChat.setState({ me: { userId: BOB.userId, email: BOB.email, role: "member" } });
    open();
    expect(screen.queryByRole("button", { name: /Remove .* from the channel/ })).toBeNull();
  });
});

describe("what an external sees: the chat they're invited to, nothing else", () => {
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
    vi.spyOn(chat, "start").mockImplementation(() => {});
    vi.spyOn(chat, "stop").mockImplementation(() => {});
    vi.spyOn(chat, "loadHistory").mockImplementation(() => {});
    vi.spyOn(chat, "viewed").mockImplementation(() => {});
    vi.spyOn(useTasks.getState(), "loadBoards").mockResolvedValue();
    useTasks.setState({ boards: [], boardsLoaded: true });
    useChat.setState({
      me: { userId: CLIENT.userId, email: CLIENT.email, role: "guest" },
      channels: [cambridge],
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const renderAt = (path: string) =>
    render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/app/tasks/:boardId?" element={<GuestLayout wsUrl="ws://test" />} />
          <Route path="/app/:channelId" element={<GuestLayout wsUrl="ws://test" />} />
          <Route path="/app" element={<GuestLayout wsUrl="ws://test" />} />
        </Routes>
      </MemoryRouter>,
    );

  it("lists their channel and no Boards, calls or invites", () => {
    renderAt("/app/ch_cambridge");
    const nav = screen.getAllByRole("navigation", { name: "Your channels and boards" })[0]!;
    expect(nav.textContent).toContain("Cambridge");
    expect(nav.textContent).not.toMatch(/Boards/);
    expect(screen.queryByRole("button", { name: /Invite/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /call/i })).toBeNull();
  });

  it("sends the Task Manager back to their channel when they have no board", () => {
    renderAt("/app/tasks");
    expect(screen.queryByText(/Loading boards/)).toBeNull();
    expect(screen.getAllByText("Cambridge").length).toBeGreaterThan(0);
  });
});

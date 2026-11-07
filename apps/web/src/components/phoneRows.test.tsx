// @vitest-environment jsdom
import type { Channel } from "@mindfultech/shared";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../store";
import { Sidebar } from "./Sidebar";

/** jsdom has no PointerEvent: a MouseEvent that carries `pointerType`. */
class FakePointerEvent extends MouseEvent {
  pointerType: string;
  pointerId: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? "mouse";
    this.pointerId = init.pointerId ?? 1;
  }
}

const ME = { userId: "u-ana", email: "ana@example.com", role: "admin" as const };
const channel = (channelId: string, name: string): Channel => ({
  channelId,
  name,
  type: "public",
  createdBy: ME.userId,
  createdAt: 1,
  archived: false,
});

beforeEach(() => {
  vi.stubGlobal("PointerEvent", FakePointerEvent);
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
  useChat.setState({
    me: ME,
    channels: [channel("general", "general"), channel("ch_web", "web")],
    channelsLoaded: true,
  });
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderHome() {
  render(
    <MemoryRouter>
      <Sidebar
        phone
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
  return screen.getByRole("button", { name: /^web$/ });
}
const touchDown = (el: Element) =>
  fireEvent.pointerDown(el, { pointerType: "touch", clientX: 50, clientY: 100 });
const optionsOpen = () => !!screen.queryByRole("menu", { name: "Options for web" });

describe("phone Home rows: swiping the list never opens a row's options", () => {
  it("a finger resting briefly before a swipe is not a long press", () => {
    const row = renderHome();
    touchDown(row);
    act(() => vi.advanceTimersByTime(450));
    expect(optionsOpen()).toBe(false);
  });

  it("the list scrolling (even without pointer moves) cancels the long press", () => {
    const row = renderHome();
    touchDown(row);
    act(() => {
      vi.advanceTimersByTime(200);
      window.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(1000);
    });
    expect(optionsOpen()).toBe(false);
  });

  it("a deliberate hold still opens the options", () => {
    const row = renderHome();
    touchDown(row);
    act(() => vi.advanceTimersByTime(700));
    expect(optionsOpen()).toBe(true);
  });
});

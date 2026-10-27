import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadPhoneSections,
  loadSidebarPrefs,
  savePhoneSections,
  saveSidebarPrefs,
  SIDEBAR_DEFAULT_WIDTH,
} from "./sidebar";

describe("phone sections", () => {
  let stored: Record<string, string>;
  beforeEach(() => {
    stored = {};
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => stored[k] ?? null,
      setItem: (k: string, v: string) => {
        stored[k] = v;
      },
    });
  });

  it("are all open until folded, and remembered on this device", () => {
    expect(loadPhoneSections()).toEqual({
      pinned: false,
      channels: false,
      dms: false,
      apps: false,
    });
    savePhoneSections({ pinned: true, channels: false, dms: true, apps: false });
    expect(loadPhoneSections()).toEqual({ pinned: true, channels: false, dms: true, apps: false });
  });

  it("ignore junk", () => {
    stored["slack.phone.collapsed"] = '{"dms":"yes","apps":true}';
    expect(loadPhoneSections()).toEqual({ pinned: false, channels: false, dms: false, apps: true });
    stored["slack.phone.collapsed"] = "nope";
    expect(loadPhoneSections()).toEqual({
      pinned: false,
      channels: false,
      dms: false,
      apps: false,
    });
  });
});

describe("sidebar width", () => {
  let stored: Record<string, string>;
  beforeEach(() => {
    stored = {};
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => stored[k] ?? null,
      setItem: (k: string, v: string) => {
        stored[k] = v;
      },
    });
  });

  it("opens at 288 px, wide enough for the logo and the name", () => {
    expect(loadSidebarPrefs()).toEqual({ width: SIDEBAR_DEFAULT_WIDTH, collapsed: false });
    expect(SIDEBAR_DEFAULT_WIDTH).toBe(288);
  });

  it("keeps a width the person chose, but moves the old default (256) to the new one", () => {
    saveSidebarPrefs({ width: 320, collapsed: true });
    expect(loadSidebarPrefs()).toEqual({ width: 320, collapsed: true });
    saveSidebarPrefs({ width: 256, collapsed: false });
    expect(loadSidebarPrefs()).toEqual({ width: 288, collapsed: false });
    saveSidebarPrefs({ width: 10, collapsed: false });
    expect(loadSidebarPrefs().width).toBe(200);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadPhoneSections, savePhoneSections } from "./sidebar";

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
    expect(loadPhoneSections()).toEqual({ channels: false, dms: false, apps: false });
    savePhoneSections({ channels: false, dms: true, apps: false });
    expect(loadPhoneSections()).toEqual({ channels: false, dms: true, apps: false });
  });

  it("ignore junk", () => {
    stored["slack.phone.collapsed"] = '{"dms":"yes","apps":true}';
    expect(loadPhoneSections()).toEqual({ channels: false, dms: false, apps: true });
    stored["slack.phone.collapsed"] = "nope";
    expect(loadPhoneSections()).toEqual({ channels: false, dms: false, apps: false });
  });
});

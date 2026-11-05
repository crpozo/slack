import type { VaultSecret } from "@mindfultech/shared";
import { describe, expect, it, vi } from "vitest";
import { CLIPBOARD_CLEAR_SECONDS, copySecret, filterSecrets } from "./vault";

const secret = (patch: Partial<VaultSecret>): VaultSecret => ({
  secretId: "vs_1",
  channelId: "ch_general",
  name: "AWS root",
  createdBy: "u1",
  allowedUserIds: [],
  createdAt: 1,
  ...patch,
});

describe("filterSecrets", () => {
  const list = [
    secret({ secretId: "a", name: "AWS root", username: "root@mindfultech.ec" }),
    secret({ secretId: "b", name: "Figma", channelId: "ch_design", website: "https://figma.com/" }),
    secret({ secretId: "c", name: "Stripe live", channelId: "ch_billing" }),
  ];
  const names: Record<string, string> = {
    ch_general: "#general",
    ch_design: "#design",
    ch_billing: "#billing",
  };
  const ids = (q: string, channel = "") =>
    filterSecrets(list, q, channel, (id) => names[id]!).map((s) => s.secretId);

  it("matches every word against name, username, website and channel", () => {
    expect(ids("")).toEqual(["a", "b", "c"]);
    expect(ids("ROOT")).toEqual(["a"]);
    expect(ids("figma.com")).toEqual(["b"]);
    expect(ids("billing live")).toEqual(["c"]);
    expect(ids("aws figma")).toEqual([]);
  });

  it("narrows to one project", () => {
    expect(ids("", "ch_design")).toEqual(["b"]);
  });
});

describe("copySecret", () => {
  it("uses the desktop app's clipboard, which wipes it after 30 s", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn();
    expect(await copySecret("hunter2", { desktop: true, invoke, writeText })).toBe("desktop");
    expect(invoke).toHaveBeenCalledWith("copy_secret", {
      text: "hunter2",
      clearAfterSecs: CLIPBOARD_CLEAR_SECONDS,
    });
    expect(CLIPBOARD_CLEAR_SECONDS).toBe(30);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("falls back to the web clipboard in an older desktop app, and in the browser", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const invoke = vi.fn().mockRejectedValue("Command copy_secret not found");
    const writeText = vi.fn().mockResolvedValue(undefined);
    expect(await copySecret("hunter2", { desktop: true, invoke, writeText })).toBe("web");
    expect(writeText).toHaveBeenCalledWith("hunter2");
    expect(await copySecret("pw", { desktop: false, invoke, writeText })).toBe("web");
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

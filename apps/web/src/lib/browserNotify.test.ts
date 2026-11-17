// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { notifyBrowser } from "./alerts";

// Phase 69: a system notification from the open tab when Chrome isn't in front.

const alert = {
  kind: "message" as const,
  title: "René",
  body: "Lo puedo pedir ahorita?",
  url: "/app/ch_paymerch",
  channelId: "ch_paymerch",
};

afterEach(() => vi.unstubAllGlobals());

describe("notifications from the open tab", () => {
  it("show through the service worker, tagged by conversation like the push", async () => {
    const showNotification = vi.fn(async () => {});
    vi.stubGlobal("Notification", { permission: "granted" });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { getRegistration: async () => ({ showNotification }) },
    });
    expect(await notifyBrowser(alert)).toBe(true);
    expect(showNotification).toHaveBeenCalledWith(
      "René",
      expect.objectContaining({
        body: "Lo puedo pedir ahorita?",
        tag: "ch_paymerch",
        data: { url: "/app/ch_paymerch", channelId: "ch_paymerch" },
      }),
    );
  });

  it("never without permission", async () => {
    vi.stubGlobal("Notification", { permission: "default" });
    expect(await notifyBrowser(alert)).toBe(false);
  });
});

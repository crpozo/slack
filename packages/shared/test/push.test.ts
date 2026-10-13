import { describe, expect, it } from "vitest";
import { findMentions, isAllowedPushEndpoint, mentionHandle, PushSubscriptionSchema } from "../src";

describe("push endpoints", () => {
  it("accepts the browsers' push services only", () => {
    for (const ok of [
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://web.push.apple.com/QGx",
      "https://wns2-by3p.notify.windows.com/w/?token=x",
    ]) {
      expect(isAllowedPushEndpoint(ok), ok).toBe(true);
    }
    for (const bad of [
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://evil.example.com/fcm.googleapis.com",
      "https://fcm.googleapis.com.evil.com/x",
      "https://push.apple.com.evil.com/x",
      "https://fcm.googleapis.com:8443/x",
      "https://user:pw@fcm.googleapis.com/x",
      "https://169.254.169.254/latest/meta-data",
      "not a url",
    ]) {
      expect(isAllowedPushEndpoint(bad), bad).toBe(false);
    }
  });

  it("validates a browser subscription", () => {
    const subscription = {
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      expirationTime: null,
      keys: {
        p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0",
        auth: "tBHItJI5svbpez7KI4CCXg",
      },
    };
    expect(PushSubscriptionSchema.safeParse(subscription).success).toBe(true);
    expect(
      PushSubscriptionSchema.safeParse({ ...subscription, keys: { p256dh: "x y", auth: "z" } })
        .success,
    ).toBe(false);
  });
});

describe("mentions", () => {
  it("finds @handles, lowercased, without trailing punctuation or emails", () => {
    expect(findMentions("@Ana can you check? cc @bob.smith. Thanks @ana")).toEqual([
      "ana",
      "bob.smith",
    ]);
    expect(findMentions("mail me at carlos@mindfultech.ec")).toEqual([]);
    expect(findMentions("(@José) and @maría_p!")).toEqual(["josé", "maría_p"]);
    expect(findMentions("no mentions here")).toEqual([]);
  });

  it("stays fast on long runs of punctuation", () => {
    const started = performance.now();
    findMentions(`@a${"-".repeat(100_000)}x ${"@".repeat(50_000)}`);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("derives a handle from a display name", () => {
    expect(mentionHandle("Ana María")).toBe("anamaría");
  });
});

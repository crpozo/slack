import { describe, expect, it, vi } from "vitest";
import {
  base64UrlToBytes,
  isValidVapidKey,
  PushServiceError,
  sameKey,
  subscribeWithRetry,
} from "./push";

describe("push key helpers", () => {
  it("decodes base64url without padding", () => {
    expect([...base64UrlToBytes("AQID_-8")]).toEqual([1, 2, 3, 255, 239]);
    expect([...base64UrlToBytes("AA")]).toEqual([0]);
  });

  it("detects whether a subscription was made with the current key", () => {
    const key =
      "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";
    const buffer = base64UrlToBytes(key).buffer;
    expect(sameKey(buffer, key)).toBe(true);
    expect(sameKey(buffer, key.replace("BEl", "BEm"))).toBe(false); // rotated
    expect(sameKey(null, key)).toBe(false);
  });
});

describe("isValidVapidKey", () => {
  it("accepts an uncompressed P-256 key only", () => {
    const key =
      "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";
    expect(isValidVapidKey(key)).toBe(true);
    expect(isValidVapidKey(key.slice(0, 40))).toBe(false); // truncated
    expect(isValidVapidKey(`A${key.slice(1)}`)).toBe(false); // not 0x04
    expect(isValidVapidKey("")).toBe(false);
    expect(isValidVapidKey("not base64!!")).toBe(false);
  });
});

describe("subscribeWithRetry", () => {
  const key = new Uint8Array(new ArrayBuffer(65));
  const fakeSubscription = { endpoint: "https://fcm.googleapis.com/x" } as PushSubscription;
  const noSleep = vi.fn(async () => {});

  function manager(failures: DOMException[]) {
    const stale = { unsubscribe: vi.fn(async () => true) };
    return {
      stale,
      subscribe: vi.fn(async () => {
        const err = failures.shift();
        if (err) throw err;
        return fakeSubscription;
      }),
      getSubscription: vi.fn(async () => stale as unknown as PushSubscription),
    };
  }

  it("retries push service errors with backoff, clearing leftovers, then succeeds", async () => {
    const m = manager([
      new DOMException("Registration failed - push service error", "AbortError"),
      new DOMException(
        "A subscription with a different applicationServerKey already exists.",
        "InvalidStateError",
      ),
    ]);
    await expect(subscribeWithRetry(m, key, [1000, 3000, 8000], noSleep)).resolves.toBe(
      fakeSubscription,
    );
    expect(m.subscribe).toHaveBeenCalledTimes(3);
    expect(noSleep.mock.calls.map((c) => (c as unknown[])[0])).toEqual([1000, 3000]);
    expect(m.stale.unsubscribe).toHaveBeenCalledTimes(2);
  });

  it("gives up after the last retry with an actionable error", async () => {
    const m = manager(
      Array.from({ length: 4 }, () => new DOMException("push service error", "AbortError")),
    );
    await expect(subscribeWithRetry(m, key, [1, 2, 3], noSleep)).rejects.toBeInstanceOf(
      PushServiceError,
    );
    expect(m.subscribe).toHaveBeenCalledTimes(4);
  });

  it("never retries a permission refusal", async () => {
    const m = manager([new DOMException("denied", "NotAllowedError")]);
    await expect(subscribeWithRetry(m, key, [1], noSleep)).rejects.toMatchObject({
      name: "NotAllowedError",
    });
    expect(m.subscribe).toHaveBeenCalledTimes(1);
  });
});

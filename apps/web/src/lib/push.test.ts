import { describe, expect, it } from "vitest";
import { base64UrlToBytes, sameKey } from "./push";

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

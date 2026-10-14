import { describe, expect, it } from "vitest";
import { typingLine } from "./TypingIndicator";

describe("typingLine", () => {
  it("names one or two people, summarizes more", () => {
    expect(typingLine([])).toBeNull();
    expect(typingLine(["Ana"])).toBe("Ana is typing…");
    expect(typingLine(["Ana", "Bob"])).toBe("Ana and Bob are typing…");
    expect(typingLine(["Ana", "Bob", "Cy"])).toBe("Several people are typing…");
  });
});

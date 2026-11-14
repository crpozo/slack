import { describe, expect, it } from "vitest";
import { systemNoteText } from "../src/protocol";

const names: Record<string, string> = { ana: "Ana", luis: "Luis", eva: "Eva", leo: "Leo" };
const nameOf = (id: string) => names[id] ?? id;

describe("system notes (Phase 63)", () => {
  it("say who was removed and by whom", () => {
    expect(systemNoteText({ event: "member_removed", userIds: ["luis"], by: "ana" }, nameOf)).toBe(
      "@Luis was removed from the channel by Ana",
    );
    expect(systemNoteText({ event: "member_removed", userIds: ["ana"], by: "ana" }, nameOf)).toBe(
      "@Ana left the channel",
    );
  });

  it("say who was added, one or several", () => {
    expect(systemNoteText({ event: "members_added", userIds: ["luis"], by: "ana" }, nameOf)).toBe(
      "@Luis was added to the channel by Ana",
    );
    expect(
      systemNoteText(
        { event: "members_added", userIds: ["luis", "eva", "leo"], by: "ana" },
        nameOf,
      ),
    ).toBe("@Luis, @Eva and @Leo were added to the channel by Ana");
  });
});

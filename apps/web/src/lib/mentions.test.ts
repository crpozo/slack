import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";
import { handlesOf, insertMention, mentionCandidates, mentionQuery } from "./mentions";

const people = [
  { userId: "u1", displayName: "Martin", email: "martin@client.com" },
  { userId: "u2", displayName: "harryson.arl2k3", email: "harryson.arl2k3@gmail.com" },
  { userId: "u3", displayName: "René Pozo", email: "rene@example.com" },
];

describe("@mentions (Phase 56)", () => {
  it("finds the mention being typed, never an email address or a finished word", () => {
    expect(mentionQuery("@mar", 4)).toEqual({ start: 0, query: "mar" });
    expect(mentionQuery("hola @", 6)).toEqual({ start: 5, query: "" });
    expect(mentionQuery("hola @mar tin", 13)).toBeNull(); // a space after it
    expect(mentionQuery("carlos@mindfultech", 18)).toBeNull(); // an email address
    expect(mentionQuery("sin arroba", 10)).toBeNull();
  });

  it("suggests names that start with what's typed first, accents aside", () => {
    expect(mentionCandidates(people, "").map((p) => p.userId)).toEqual(["u2", "u1", "u3"]);
    expect(mentionCandidates(people, "mar").map((p) => p.userId)).toEqual(["u1"]);
    expect(mentionCandidates(people, "rene").map((p) => p.userId)).toEqual(["u3"]);
    expect(mentionCandidates(people, "pozo").map((p) => p.userId)).toEqual(["u3"]);
    expect(mentionCandidates(people, "zzz")).toEqual([]);
  });

  it("writes the handle the server matches, and puts the caret after it", () => {
    expect(handlesOf(people[2]!)).toEqual(["renépozo", "rene"]);
    expect(insertMention("hola @mar", 5, 9, "martin")).toEqual({
      text: "hola @martin ",
      caret: 13,
    });
    expect(insertMention("@ma y más", 0, 3, "martin")).toEqual({
      text: "@martin y más",
      caret: 8,
    });
  });

  it("highlights mentions of known people in messages, yours more", () => {
    const marks = { known: new Set(["martin", "carlos"]), mine: new Set(["carlos"]) };
    const html = renderMarkdown("@martin y @carlos, mira esto. @nadie no. a@martin.com", marks);
    expect(html).toContain('<span class="mention">@martin</span> y');
    expect(html).toContain('<span class="mention mention-me">@carlos</span>,');
    expect(html).toContain("@nadie no");
    expect(html).not.toContain('a<span class="mention"');
    // Never inside code.
    expect(renderMarkdown("`@martin`", marks)).toBe("<code>@martin</code>");
  });
});

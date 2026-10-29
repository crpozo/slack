import { describe, expect, it } from "vitest";
import {
  matchesAllTerms,
  messageSearchTerms,
  messageSkOfIndexSk,
  searchIndexSk,
  searchSnippet,
  searchTerms,
  sortKeyTime,
} from "../src/search";

describe("searchTerms", () => {
  it("lowercases, drops accents, splits on anything but letters and digits", () => {
    expect(searchTerms("¿Qué tal el Deploy de MAÑANA? v2.1 #release @ana")).toEqual([
      "tal",
      "deploy",
      "manana",
      "v2",
      "release",
      "ana",
    ]);
  });

  it("skips one-letter words and common words, keeps each term once, cuts very long ones", () => {
    expect(searchTerms("a the login LOGIN y para")).toEqual(["login"]);
    expect(searchTerms("x".repeat(80))[0]).toHaveLength(40);
  });

  it("indexes nothing of a secret or a deleted message; file names and card titles count", () => {
    const base = { text: "hunter2 password", attachments: [] };
    expect(messageSearchTerms({ ...base, isSecret: true })).toEqual([]);
    expect(messageSearchTerms({ ...base, deletedAt: 1 })).toEqual([]);
    expect(
      messageSearchTerms({
        text: "see attached",
        attachments: [
          { key: "k", name: "Q3-Roadmap.pdf", size: 1, contentType: "application/pdf" },
        ],
      }),
    ).toEqual(["attached", "q3", "roadmap", "pdf"]);
  });
});

describe("matching and snippets", () => {
  it("each query term must start some word (prefix search)", () => {
    expect(matchesAllTerms("The login bug is back", ["logi", "bug"])).toBe(true);
    expect(matchesAllTerms("The login bug is back", ["logi", "crash"])).toBe(false);
    expect(matchesAllTerms("Reunión mañana", ["reunion"])).toBe(true);
  });

  it("cuts around the first match and marks every matching word, accents and case aside", () => {
    const text = `${"palabra ".repeat(40)}La reunión de MAÑANA se movió. ${"otra ".repeat(40)}`;
    const snippet = searchSnippet(text, ["reunion", "manana"]);
    expect(snippet.text.startsWith("…")).toBe(true);
    expect(snippet.text.endsWith("…")).toBe(true);
    expect(snippet.text.length).toBeLessThanOrEqual(164);
    const marked = snippet.highlights.map(([a, b]) => snippet.text.slice(a, b));
    expect(marked).toEqual(["reunión", "MAÑANA"]);
  });

  it("keeps a short message whole", () => {
    expect(searchSnippet("Fixed the  login\nbug", ["login"])).toEqual({
      text: "Fixed the login bug",
      highlights: [[10, 15]],
    });
  });
});

describe("index keys", () => {
  it("round-trips a message sort key, and reads the time of messages and replies", () => {
    const sk = "1761700000000#01JABC";
    expect(messageSkOfIndexSk(searchIndexSk("login", sk))).toBe(sk);
    expect(sortKeyTime(sk)).toBe(1761700000000);
    expect(sortKeyTime(`thread#${sk}#1761700005000#01JDEF`)).toBe(1761700005000);
    expect(sortKeyTime("garbage")).toBe(0);
  });
});

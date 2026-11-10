import { describe, expect, it } from "vitest";
import { similarTechNames, techCoreKey } from "../src/radar";

describe("the same technology under another name (Phase 60)", () => {
  it("drops versions and packaging from the name", () => {
    expect(techCoreKey("Claude Opus 5.5")).toBe("claudeopus");
    expect(techCoreKey("Next.js")).toBe("next");
    expect(techCoreKey("NextJS")).toBe("next");
    expect(techCoreKey("LangChain v1.0")).toBe("langchain");
    expect(techCoreKey("Llama 4 70B")).toBe("llama");
    expect(techCoreKey("Deno 2")).toBe("deno");
    // Too short once stripped: the name stays as it is.
    expect(techCoreKey("Bun")).toBe("bun");
  });

  it("matches spellings, versions and one-letter typos", () => {
    expect(similarTechNames("LangChain", "lang-chain")).toBe(true);
    expect(similarTechNames("Claude Opus 5.5", "Claude Opus")).toBe(true);
    expect(similarTechNames("Next.js", "NextJS")).toBe(true);
    expect(similarTechNames("Bun 1.3", "Bun")).toBe(true);
    expect(similarTechNames("Langchan", "LangChain")).toBe(true);
  });

  it("keeps different technologies apart", () => {
    expect(similarTechNames("React", "React Native")).toBe(false);
    expect(similarTechNames("Vite", "Vitest")).toBe(false);
    expect(similarTechNames("Ollama", "Llama")).toBe(false);
    expect(similarTechNames("GPT-6", "GPT 6 Turbo")).toBe(false);
    expect(similarTechNames("Deno", "Bun")).toBe(false);
    expect(similarTechNames("", "")).toBe(false);
  });
});

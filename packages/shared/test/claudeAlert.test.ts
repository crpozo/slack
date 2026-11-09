import { describe, expect, it } from "vitest";
import {
  claudeAlertFromArticles,
  claudeModelName,
  claudeModelSignal,
  pickClaudeAlert,
  type ClaudeModelAlert,
  type NewsArticle,
} from "../src";

const article = (
  title: string,
  snippet = "",
  link = `https://e.com/${title.length}`,
): NewsArticle => ({
  title,
  snippet,
  link,
  pubDate: null,
  imageUrl: null,
  sourceName: "TechCrunch",
});

describe("a new Claude model in the headlines (Phase 56)", () => {
  it("tells a launch from one coming soon, and ignores apps, features and other companies", () => {
    expect(claudeModelSignal(article("Anthropic launches Claude Opus 6"))).toBe("launched");
    expect(claudeModelSignal(article("Anthropic releases Claude 6 with a 2M context"))).toBe(
      "launched",
    );
    expect(claudeModelSignal(article("Anthropic lanza Claude Sonnet 6"))).toBe("launched");
    expect(claudeModelSignal(article("Anthropic is set to launch Claude Opus 6 next week"))).toBe(
      "upcoming",
    );
    expect(claudeModelSignal(article("Leaked docs show Anthropic readying a new model"))).toBe(
      "upcoming",
    );
    expect(claudeModelSignal(article("Anthropic prepara su próximo modelo Claude"))).toBe(
      "upcoming",
    );
    // An app or a feature, not a model.
    expect(claudeModelSignal(article("Anthropic launches Claude for Chrome"))).toBeNull();
    expect(claudeModelSignal(article("Claude gets a new memory feature"))).toBeNull();
    // Not about Anthropic or Claude.
    expect(claudeModelSignal(article("OpenAI launches GPT-6, a new model"))).toBeNull();
    // About Claude, no launch either way.
    expect(claudeModelSignal(article("How Claude Opus 5 compares with GPT-5"))).toBeNull();
  });

  it("names the model when the headline does", () => {
    expect(claudeModelName("Anthropic launches Claude  Opus 6 today")).toBe("Claude Opus 6");
    expect(claudeModelName("Claude 6 is here")).toBe("Claude 6");
    expect(claudeModelName("Anthropic readies a new model")).toBe("");
  });

  it("raises the live alert from the newest matching story; a launch wins", () => {
    const alert = claudeAlertFromArticles([
      article("Nvidia invests again"),
      article("Anthropic is set to launch Claude Opus 6", "Expected next week."),
      article("Anthropic launches Claude Opus 6", "Available today in the API."),
      article("Claude Opus 6 arrives with better coding", "", "https://e.com/b"),
    ]);
    expect(alert).toMatchObject({
      status: "launched",
      model: "Claude Opus 6",
      headline: "Anthropic launches Claude Opus 6",
      summary: "Available today in the API.",
      from: "headline",
    });
    expect(alert?.evidence).toHaveLength(2);
    expect(claudeAlertFromArticles([article("Nvidia invests again")])).toBeNull();
  });

  it("prefers a launch, then the analysis's own words", () => {
    const base = { model: "Claude Opus 6", headline: "h", summary: "", evidence: [] };
    const fromAnalysis: ClaudeModelAlert = { ...base, status: "upcoming", from: "analysis" };
    const live: ClaudeModelAlert = { ...base, status: "launched", from: "headline" };
    expect(pickClaudeAlert(fromAnalysis, live)).toBe(live);
    expect(pickClaudeAlert(fromAnalysis, { ...live, status: "upcoming" })).toBe(fromAnalysis);
    expect(pickClaudeAlert(undefined, null)).toBeNull();
  });
});

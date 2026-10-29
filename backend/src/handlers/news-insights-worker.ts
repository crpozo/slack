import Anthropic from "@anthropic-ai/sdk";
import { calendarDay } from "@mindfultech/shared";
import { bedrockModel, type ClaudeModel } from "../lib/claude";
import { errorFields, log } from "../lib/logger";
import { readAllSources } from "../lib/news";
import { insightsFrom, insightsItem, insightsRequest, saveInsights } from "../lib/newsInsights";

let model: ClaudeModel | null = null;

/** Tests swap the model. */
export function useInsightsModel(next: ClaudeModel | null): void {
  model = next;
}

/** What the worker wrote, for whoever invoked it synchronously (tests, the CLI). */
export interface InsightsRun {
  day: string;
  articles: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Writes the day's AI Insights (Phase 39; the dashboard's JSON since Phase 41). Run every morning by an
 * EventBridge schedule, and on demand by `POST /news/insights` (an admin's
 * "Generate now"); the event's contents don't matter. It reads the feed
 * itself (every source; the `news` Lambda's cache is its own), asks Claude
 * Haiku 5.5 for the dashboard (top stories, trends, takeaways) and keeps it
 * as today's row, replacing an earlier one from the
 * same day. Any failure throws, so the schedule's retries get another go:
 * nothing is half-written, since the row is put in one piece at the end.
 */
export const handler = async (): Promise<InsightsRun> => {
  const started = Date.now();
  const day = calendarDay(started);
  // Only the last NEWS_MAX_AGE_HOURS of stories reach the model.
  const { articles, failed, discarded } = await readAllSources();
  if (failed.length > 0) log.warn("news sources unreachable", { day, failed });
  if (discarded.length > 0) log.info("old news discarded", { day, discarded });
  if (articles.length === 0) throw new Error("the feeds have no stories");
  let response: Anthropic.Message;
  try {
    response = await (model ?? (model = bedrockModel())).create(insightsRequest(articles, day));
  } catch (err) {
    log.error("news insights model failed", {
      day,
      ms: Date.now() - started,
      ...(err instanceof Anthropic.APIError && { status: err.status }),
      ...errorFields(err),
    });
    throw err;
  }
  const outcome = insightsFrom(response, articles);
  const run: InsightsRun = {
    day,
    articles: articles.length,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
  if (!outcome.ok) {
    log.error("news insights not written", { ...run, stopReason: response.stop_reason });
    throw new Error(`News insights for ${day}: ${outcome.error}`);
  }
  await saveInsights(insightsItem(day, outcome.dashboard, articles, Date.now()));
  log.info("news insights written", { ...run, ms: Date.now() - started });
  return run;
};

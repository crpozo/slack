import Anthropic from "@anthropic-ai/sdk";
import { calendarDay } from "@mindfultech/shared";
import { bedrockModel, type ClaudeModel } from "../lib/claude";
import { errorFields, log } from "../lib/logger";
import {
  DISCOVERY_SCAN_ID,
  listBlips,
  listProposals,
  putProposalIfAbsent,
  recordScan,
} from "../lib/radar";
import {
  discoveriesFrom,
  discoveryProposal,
  discoveryRequest,
  hackerNewsTop,
  knownNames,
  recentNews,
  type DiscoverySignal,
} from "../lib/radarDiscovery";

let model: ClaudeModel | null = null;
let fetchImpl: typeof fetch = (...args) => fetch(...args);

/** Tests swap the model and Hacker News. */
export function useDiscoveryModel(next: ClaudeModel | null): void {
  model = next;
}
export function useDiscoveryFetch(next: typeof fetch | null): void {
  fetchImpl = next ?? ((...args) => fetch(...args));
}

export const DISCOVERY_REQUEST_TIMEOUT_MS = 2 * 60_000;

/** What a run did, for whoever invoked it synchronously (`aws lambda invoke`, tests). */
export interface DiscoveryRun {
  day: string;
  newsStories: number;
  hackerNewsStories: number;
  proposed: string[];
  /** Technologies the model named that the radar already knows (or invalid ones). */
  skipped: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * The Discovery Engine (Phase 60), `radar-discovery-engine`: run daily at
 * 06:00 UTC by an EventBridge schedule, and on demand (an admin's "Scan now",
 * or `aws lambda invoke`). Reads the AI news stored in the last 24 hours and
 * Hacker News' top 30 stories, asks Claude Haiku 5.5 for the new or trending
 * technologies in them, and files those the radar doesn't know as pending
 * proposals in Assess for an admin to accept or reject. One source failing
 * is logged and the run goes on with the other; throws when there is nothing
 * to read or the model fails, so the schedule's retry gets another go
 * (proposals are written with a condition: a retry never duplicates one).
 */
export const handler = async (): Promise<DiscoveryRun> => {
  const started = Date.now();
  const day = calendarDay(started, "UTC");
  const [news, hackerNews, blips, proposals] = await Promise.all([
    recentNews(started).catch((err: unknown) => {
      log.warn("discovery: the stored AI news couldn't be read", { day, ...errorFields(err) });
      return [] as DiscoverySignal[];
    }),
    hackerNewsTop(fetchImpl).catch((err: unknown) => {
      log.warn("discovery: Hacker News couldn't be read", { day, ...errorFields(err) });
      return [] as DiscoverySignal[];
    }),
    listBlips(),
    listProposals(),
  ]);
  const signals = [...news, ...hackerNews];
  if (signals.length === 0) throw new Error("Discovery: no AI news stored and no Hacker News");
  const known = knownNames(blips, proposals);

  let response: Anthropic.Message;
  try {
    response = await (model ??= bedrockModel(DISCOVERY_REQUEST_TIMEOUT_MS, 0)).create(
      discoveryRequest(signals, known, day),
    );
  } catch (err) {
    log.error("discovery model failed", {
      day,
      ms: Date.now() - started,
      ...(err instanceof Anthropic.APIError && { status: err.status }),
      ...errorFields(err),
    });
    throw err;
  }
  const outcome = discoveriesFrom(response, signals, known);
  if (!outcome.ok) {
    log.error("discovery unusable", {
      day,
      stopReason: response.stop_reason,
      error: outcome.error,
    });
    throw new Error(`Discovery for ${day}: ${outcome.error}`);
  }

  const now = Date.now();
  const proposed: string[] = [];
  for (const found of outcome.found) {
    if (await putProposalIfAbsent(discoveryProposal(found, day, now))) proposed.push(found.name);
  }
  const run: DiscoveryRun = {
    day,
    newsStories: news.length,
    hackerNewsStories: hackerNews.length,
    proposed,
    skipped: outcome.skipped,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
  await recordScan(now, { day, proposed: proposed.length }, DISCOVERY_SCAN_ID);
  log.info("radar discovery ran", { ...run, ms: Date.now() - started });
  return run;
};

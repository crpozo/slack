import Anthropic from "@anthropic-ai/sdk";
import { calendarDay } from "@mindfultech/shared";
import { bedrockModel, type ClaudeModel } from "../lib/claude";
import { errorFields, log } from "../lib/logger";
import { readAllSources } from "../lib/news";
import {
  listBlips,
  listProposals,
  newProposal,
  pruneProposals,
  putProposal,
  recordScan,
} from "../lib/radar";
import { radarScanRequest, scanPlanFrom } from "../lib/radarScan";

let model: ClaudeModel | null = null;

/** Tests swap the model. */
export function useRadarModel(next: ClaudeModel | null): void {
  model = next;
}

export const SCAN_REQUEST_TIMEOUT_MS = 2 * 60_000;

/** What a scan did, for whoever invoked it synchronously (tests, the CLI). */
export interface ScanRun {
  day: string;
  articles: number;
  added: string[];
  proposed: string[];
  inputTokens: number;
  outputTokens: number;
}

/**
 * The daily radar scan (Phase 56), run by an EventBridge schedule after the
 * morning's AI Insights, and on demand by `POST /radar/scan` (an admin's
 * "Scan now"). Reads the feeds, asks Claude Haiku 5.5 for updates and files
 * them as pending proposals: new technologies (to Assess, since Phase 60 an
 * admin accepts them, as the Discovery Engine's) and moves. Throws on failure
 * so the schedule's retries get another go; a retry repeats no proposal
 * (the plan skips what is already pending).
 */
export const handler = async (): Promise<ScanRun> => {
  const started = Date.now();
  const day = calendarDay(started);
  const [{ articles, failed }, blips, proposals] = await Promise.all([
    readAllSources(),
    listBlips(),
    listProposals(),
  ]);
  if (failed.length > 0) log.warn("radar scan: news sources unreachable", { day, failed });
  if (articles.length === 0) throw new Error("the feeds have no stories");

  let response: Anthropic.Message;
  try {
    response = await (model ??= bedrockModel(SCAN_REQUEST_TIMEOUT_MS, 0)).create(
      radarScanRequest(articles, blips, day),
    );
  } catch (err) {
    log.error("radar scan model failed", {
      day,
      ms: Date.now() - started,
      ...(err instanceof Anthropic.APIError && { status: err.status }),
      ...errorFields(err),
    });
    throw err;
  }
  const outcome = scanPlanFrom(response, articles, blips, proposals);
  if (!outcome.ok) {
    log.error("radar scan unusable", {
      day,
      stopReason: response.stop_reason,
      error: outcome.error,
    });
    throw new Error(`Radar scan for ${day}: ${outcome.error}`);
  }

  const now = Date.now();
  // Phase 60: a new technology waits for an admin, like the Discovery Engine's.
  const added: string[] = [];
  for (const add of outcome.plan.adds) {
    await putProposal(
      newProposal(
        {
          kind: "add",
          name: add.name,
          quadrant: add.quadrant,
          ring: "Assess",
          rationale: add.rationale,
          description: add.description,
          sourceTitle: add.source?.title,
          sourceLink: add.source?.link,
          ...(add.modelId && { meta: { modelId: add.modelId } }),
          origin: "news-scan",
        },
        now,
      ),
    );
    added.push(add.name);
  }
  const proposed: string[] = [];
  for (const move of outcome.plan.moves) {
    await putProposal(
      newProposal(
        {
          kind: "move",
          blipId: move.blip.id,
          name: move.blip.name,
          quadrant: move.blip.quadrant,
          ring: move.ring,
          fromRing: move.blip.ring,
          rationale: move.rationale,
          sourceTitle: move.source?.title,
          sourceLink: move.source?.link,
          origin: "news-scan",
        },
        now,
      ),
    );
    proposed.push(`${move.blip.name} → ${move.ring}`);
  }
  const pruned = await pruneProposals(now);
  const run: ScanRun = {
    day,
    articles: articles.length,
    added,
    proposed,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
  await recordScan(now, { day, added: added.length, proposed: proposed.length });
  log.info("radar scanned", { ...run, pruned, ms: Date.now() - started });
  return run;
};

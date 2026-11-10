import Anthropic from "@anthropic-ai/sdk";
import { calendarDay, RADAR_AI_AUTHOR, type RadarBlip } from "@mindfultech/shared";
import { bedrockModel, type ClaudeModel } from "../lib/claude";
import { errorFields, log } from "../lib/logger";
import { readAllSources } from "../lib/news";
import {
  listBlips,
  listProposals,
  newBlip,
  newProposal,
  pruneProposals,
  putBlipIfAbsent,
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
 * "Scan now"). Reads the feeds, asks Claude Haiku 5.5 for updates, adds the
 * new technologies to Assess and files the moves as proposals. Throws on
 * failure so the schedule's retries get another go; blips are written one by
 * one with a condition, so a retry never duplicates them.
 */
export const handler = async (): Promise<ScanRun> => {
  const started = Date.now();
  const day = calendarDay(started);
  const [{ articles, failed }, blips, pending] = await Promise.all([
    readAllSources(),
    listBlips(),
    listProposals("pending"),
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
  const outcome = scanPlanFrom(response, articles, blips, pending);
  if (!outcome.ok) {
    log.error("radar scan unusable", {
      day,
      stopReason: response.stop_reason,
      error: outcome.error,
    });
    throw new Error(`Radar scan for ${day}: ${outcome.error}`);
  }

  const now = Date.now();
  const added: string[] = [];
  for (const add of outcome.plan.adds) {
    const blip: RadarBlip = newBlip(
      {
        name: add.name,
        quadrant: add.quadrant,
        ring: "Assess",
        description: add.description,
        ...(add.source?.link && { link: add.source.link }),
        ...(add.modelId && { meta: { modelId: add.modelId } }),
      },
      RADAR_AI_AUTHOR,
      now,
    );
    if (await putBlipIfAbsent(blip)) {
      added.push(blip.name);
      // The "why" is kept as an applied proposal, so the panel can show it.
      await putProposal({
        ...newProposal(
          {
            kind: "add",
            blipId: blip.id,
            name: blip.name,
            quadrant: blip.quadrant,
            ring: "Assess",
            rationale: add.rationale,
            description: add.description,
            sourceTitle: add.source?.title,
            sourceLink: add.source?.link,
          },
          now,
        ),
        status: "applied",
        resolvedBy: RADAR_AI_AUTHOR,
        resolvedAt: now,
      });
    }
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

import Anthropic from "@anthropic-ai/sdk";
import { calendarDay } from "@mindfultech/shared";
import { bedrockModel, type StreamingClaudeModel } from "../lib/claude";
import { errorFields, log } from "../lib/logger";
import { readAllSources } from "../lib/news";
import { writeNewsAudio } from "../lib/newsAudio";
import {
  claimAudio,
  insightsFrom,
  insightsItem,
  insightsRequest,
  latestInsights,
  saveAudio,
  saveFailure,
  saveInsights,
} from "../lib/newsInsights";

let model: StreamingClaudeModel | null = null;

/** Tests swap the model. */
export function useInsightsModel(next: StreamingClaudeModel | null): void {
  model = next;
}

/**
 * One analysis, thinking included: at high effort over 40 stories it can run
 * a couple of minutes, so it is streamed (no idle connection to drop) and
 * given 5 minutes, inside the Lambda's 6. No SDK retry: a failure is retried
 * by the invocation itself (the schedule, or Lambda's async retry).
 */
export const INSIGHTS_REQUEST_TIMEOUT_MS = 5 * 60_000;

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
export const handler = async (event?: { audioOnly?: boolean }): Promise<InsightsRun | null> => {
  // Phase 55: only the audio of the analysis on screen (it was written without one).
  if (event?.audioOnly) {
    await audioForLatest();
    return null;
  }
  try {
    return await run();
  } catch (err) {
    // Phase 49b: the page waiting on this run hears why at once (then the run is retried).
    await saveFailure(failureText(err), Date.now());
    throw err;
  }
};

/** Why a run failed, in words for the page (the log has the details). */
function failureText(err: unknown): string {
  if (err instanceof Anthropic.APIError) {
    if (err.status === 403) return "El servicio de IA rechazó la solicitud (permisos de Bedrock).";
    if (err.status === 429)
      return "El servicio de IA está ocupado. Intenta de nuevo en unos minutos.";
    return `El servicio de IA respondió con un error (${err.status ?? "sin código"}).`;
  }
  const text = err instanceof Error ? err.message : String(err);
  if (/feed|sources|stories/i.test(text)) return "No se pudieron leer las noticias de los medios.";
  if (/cut off|too long/i.test(text)) return "El análisis salió demasiado largo y se cortó.";
  if (/JSON|empty|picked no story|missing/i.test(text)) {
    return "La IA respondió algo que no se pudo usar. Intenta de nuevo.";
  }
  if (/timed? ?out|timeout/i.test(text)) return "El servicio de IA tardó demasiado en responder.";
  return "Algo salió mal escribiendo el análisis.";
}

async function run(): Promise<InsightsRun> {
  const started = Date.now();
  const day = calendarDay(started);
  // Only the last NEWS_MAX_AGE_HOURS of stories reach the model.
  const { articles, failed, discarded } = await readAllSources();
  if (failed.length > 0) log.warn("news sources unreachable", { day, failed });
  if (discarded.length > 0) log.info("old news discarded", { day, discarded });
  if (articles.length === 0) throw new Error("the feeds have no stories");
  let response: Anthropic.Message;
  try {
    response = await (model ??= bedrockModel(INSIGHTS_REQUEST_TIMEOUT_MS, 0)).stream(
      insightsRequest(articles, day),
    );
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
  const item = insightsItem(day, outcome.dashboard, articles, Date.now());
  await saveInsights(item);
  log.info("news insights written", { ...run, ms: Date.now() - started });
  // Phase 54: then the summary read aloud. The page already has the analysis;
  // the row gains its audio a few seconds later. Never fails the run.
  await makeAudio(item, true);
  return run;
}

/**
 * Reads `analysis` aloud and adds the MP3 to its row. Claimed first (the
 * page sees it's on its way and doesn't start another). Never throws.
 */
async function makeAudio(
  analysis: Parameters<typeof writeNewsAudio>[0] & { day: string },
  force: boolean,
): Promise<void> {
  const started = Date.now();
  try {
    if (!(await claimAudio(analysis.generatedAt, started, force)).claimed) return;
    const audio = await writeNewsAudio(analysis);
    await saveAudio(analysis, audio);
    log.info("news audio written", {
      day: analysis.day,
      chars: audio.chars,
      ms: Date.now() - started,
    });
  } catch (err) {
    log.warn("news audio failed", { day: analysis.day, ...errorFields(err) });
  }
}

/** Phase 55: the newest analysis has no audio (written before audio existed, or it failed). */
async function audioForLatest(): Promise<void> {
  const latest = await latestInsights();
  if (!latest || latest.audioKey) return;
  // The endpoint claimed it already: this run makes it.
  await makeAudio(latest, true);
}

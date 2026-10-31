import Anthropic from "@anthropic-ai/sdk";
import { notesFrom, notesRequest, settleNotesCard, type NotesJob } from "../lib/callNotes";
import { bedrockModel, type StreamingClaudeModel } from "../lib/claude";
import { errorFields, log } from "../lib/logger";
import { getRawNote, putPolished } from "../lib/noteDetails";

/** The part of the Messages client the worker uses (a fake in tests). */
export type NotesModel = StreamingClaudeModel;

/**
 * One streamed request may take minutes on a long call; with its one retry it
 * stays inside the worker's 15 minutes.
 */
const REQUEST_TIMEOUT_MS = 7 * 60 * 1000;

let model: NotesModel | null = null;

/** Tests swap the model. */
export function useNotesModel(next: NotesModel | null): void {
  model = next;
}

/** Why the notes failed, in words the reader can act on. */
function failureText(err: unknown): string {
  if (err instanceof Anthropic.RateLimitError) {
    return "The notes service was busy, so these notes couldn't be written.";
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return "The notes service couldn't be reached.";
  }
  return "Something went wrong writing the notes.";
}

/**
 * Writes the notes of one call: invoked asynchronously by the `call-notes`
 * endpoint once the card is posted and the transcript stored (its `raw` row),
 * it asks Claude Haiku 5.5, as a dictation editor (Phase 40), for the polished
 * minutes and the summary with action items. The minutes are stored apart;
 * the summary fills the pending card (or it's marked failed) and the
 * conversation hears `message.updated`. Errors are caught and become a failed
 * card: an async retry would only repeat them.
 */
export const handler = async (job: NotesJob): Promise<void> => {
  const { card, notes } = job;
  const started = Date.now();
  let settled: typeof notes;
  try {
    const raw = await getRawNote(notes.callId);
    if (!raw) throw new Error("the transcript row is missing");
    const response = await (model ?? (model = bedrockModel(REQUEST_TIMEOUT_MS))).stream(
      notesRequest(raw.text),
    );
    const outcome = notesFrom(response);
    log.info("call notes generated", {
      channelId: card.channelId,
      callId: notes.callId,
      ok: outcome.ok,
      polished: outcome.ok && outcome.polished !== null,
      filed: outcome.ok && outcome.meta !== null,
      stopReason: response.stop_reason,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      ms: Date.now() - started,
    });
    if (outcome.ok && outcome.polished) {
      try {
        await putPolished(notes.callId, outcome.polished);
      } catch (err) {
        // The summary still makes it to the card.
        log.error("polished notes not stored", { callId: notes.callId, ...errorFields(err) });
      }
    }
    settled = outcome.ok
      ? {
          ...notes,
          status: "ready",
          summary: outcome.summary,
          // Phase 46: filed as it's written; a missing <meta> leaves it to "Classify older notes".
          ...(outcome.meta && { category: outcome.meta.category, topics: outcome.meta.topics }),
        }
      : { ...notes, status: "failed", error: outcome.error };
  } catch (err) {
    log.error("call notes failed", {
      channelId: card.channelId,
      callId: notes.callId,
      ms: Date.now() - started,
      ...(err instanceof Anthropic.APIError && { status: err.status }),
      ...errorFields(err),
    });
    settled = { ...notes, status: "failed", error: failureText(err) };
  }
  await settleNotesCard(card, settled);
};

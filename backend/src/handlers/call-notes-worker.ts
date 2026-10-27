import Anthropic from "@anthropic-ai/sdk";
import {
  notesFrom,
  notesRequest,
  settleNotesCard,
  transcriptFor,
  type NotesJob,
} from "../lib/callNotes";
import { bedrockModel, type ClaudeModel } from "../lib/claude";
import { errorFields, log } from "../lib/logger";

/** The part of the Messages client the worker uses (a fake in tests). */
export type NotesModel = ClaudeModel;

let model: NotesModel | null = null;

/** Tests swap the model. */
export function useNotesModel(next: NotesModel | null): void {
  model = next;
}

/** Why the notes failed, in words the reader can act on. */
function failureText(err: unknown): string {
  if (err instanceof Anthropic.RateLimitError) {
    return "The notes service was busy. The transcript wasn't kept, so these notes can't be retried.";
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return "The notes service couldn't be reached.";
  }
  return "Something went wrong writing the notes.";
}

/**
 * Writes the notes of one call (Phase 28): invoked asynchronously by the
 * `call-notes` endpoint with the merged transcript, it asks Claude Haiku 5.5
 * for the summary and action items, then fills the pending card (or marks it
 * failed) and pushes `message.updated` to the conversation. Errors are caught
 * and become a failed card: an async retry would only repeat them.
 */
export const handler = async (job: NotesJob): Promise<void> => {
  const { card, notes, segments } = job;
  const started = Date.now();
  let settled: typeof notes;
  try {
    const transcript = await transcriptFor(segments, notes.startedAt);
    const response = await (model ?? (model = bedrockModel())).create(notesRequest(transcript));
    const outcome = notesFrom(response);
    log.info("call notes generated", {
      channelId: card.channelId,
      callId: notes.callId,
      ok: outcome.ok,
      stopReason: response.stop_reason,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      ms: Date.now() - started,
    });
    settled = outcome.ok
      ? { ...notes, status: "ready", summary: outcome.summary }
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

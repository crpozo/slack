import type {
  AiNotes,
  ClassifyNotesResponse,
  Message,
  NoteAudio,
  NoteDetail,
  NoteQuestion,
  NotesClipQuery,
  NotesClipResult,
  NotesPage,
  SummarizeCallInput,
} from "@mindfultech/shared";
import { request } from "./tasksApi";

/**
 * Browsers cap the bodies of `keepalive` requests (the ones that outlive the
 * page) at 64 KiB in total, so only a transcript under this goes out that way;
 * a longer one is sent normally and needs the page to stay open a moment.
 */
const KEEPALIVE_MAX_BYTES = 60_000;

/** AI call notes (Phase 28), on the same HTTP API and auth as the Task Manager. */
export const notesApi = {
  /** 202: the server posts a pending ✨ card and fills it in the background. */
  summarizeCall: (input: SummarizeCallInput) => {
    const bytes = new TextEncoder().encode(JSON.stringify(input)).length;
    return request<{ message: Message }>("POST", "/calls/summary", input, {
      keepalive: bytes <= KEEPALIVE_MAX_BYTES,
    }).then((r) => r.message);
  },
  /**
   * Phase 43: one clip of one voice of the call, as raw audio, transcribed by
   * Whisper on the server (which keeps only the text).
   */
  uploadClip: (callId: string, query: NotesClipQuery, audio: Blob) => {
    const params = new URLSearchParams({
      channelId: query.channelId,
      speaker: query.speaker,
      startedAt: String(query.startedAt),
      durationMs: String(query.durationMs),
    });
    return request<NotesClipResult>(
      "POST",
      `/calls/${encodeURIComponent(callId)}/clips?${params.toString()}`,
      audio,
    );
  },
  /**
   * Phase 46: files a batch of your older notes under a category and topics
   * (`message.updated` follows for each); call again while `remaining > 0`.
   */
  classify: () => request<ClassifyNotesResponse>("POST", "/notes/classify"),
  /** The AI Notes hub (Phase 29): your notes cards from every conversation, newest first. */
  list: (cursor: string | null) =>
    request<NotesPage>("GET", cursor ? `/notes?cursor=${encodeURIComponent(cursor)}` : "/notes"),
  /** Phase 40: attaches the uploaded recording to the call's card (`message.updated` follows). */
  attachAudio: (callId: string, audio: NoteAudio) =>
    request<{ aiNotes: AiNotes }>("PUT", `/calls/${encodeURIComponent(callId)}/audio`, audio),
  /** Phase 40: the full notes: raw transcript, polished minutes, your own questions. */
  detail: (callId: string) => request<NoteDetail>("GET", `/notes/${encodeURIComponent(callId)}`),
  /** Phase 40: a question about the notes, answered from them (kept for you alone). */
  ask: (callId: string, question: string) =>
    request<NoteQuestion>("POST", `/notes/${encodeURIComponent(callId)}/ask`, { question }),
};

export type NotesApi = typeof notesApi;

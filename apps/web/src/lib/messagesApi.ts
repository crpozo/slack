import type { MessageTranscriptResult } from "@mindfultech/shared";
import { request } from "./tasksApi";

/** Messages over the HTTP API (Phase 32: deleting; sending stays on the socket). */
export const messagesApi = {
  /** 204; 403 if it's neither yours nor are you an admin; 404 if it's already gone. */
  delete: (channelId: string, sk: string) =>
    request<void>("DELETE", `/messages/${encodeURIComponent(channelId)}/${encodeURIComponent(sk)}`),
  /**
   * Phase 58: a voice message's transcript (made the first time, kept after);
   * 409 while someone else's request is making it.
   */
  transcribe: (channelId: string, sk: string) =>
    request<MessageTranscriptResult>(
      "POST",
      `/messages/${encodeURIComponent(channelId)}/${encodeURIComponent(sk)}/transcribe`,
    ),
};

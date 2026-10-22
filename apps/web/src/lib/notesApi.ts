import type { Message, SummarizeCallInput } from "@mindfultech/shared";
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
};

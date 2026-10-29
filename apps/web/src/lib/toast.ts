// ---------------------------------------------------------------------------
// Toasts come in three tones: success (✓, brand green), info (neutral glass)
// and error (red). Callers can say which; otherwise the wording decides, so
// "Couldn't…" or "…failed" reads as an error and everything else doesn't.
// ---------------------------------------------------------------------------

export type ToastTone = "success" | "info" | "error";

const ERROR =
  /\b(couldn'?t|could not|can'?t|cannot|failed|fails|error|not allowed|denied|expired|unavailable|not found|invalid|too (?:long|short|large|big)|try again|went wrong|no longer)\b/i;
const SUCCESS = /^(?:\W*\s*)?(copied|saved|sent|done|added|created|linked|updated)\b|\bcopied\b/i;

/** The tone of `message` when the caller didn't give one. */
export function toneOf(message: string): ToastTone {
  if (ERROR.test(message)) return "error";
  if (SUCCESS.test(message)) return "success";
  return "info";
}

/** How long each tone stays: errors longest, so they can be read and acted on. */
export const TOAST_MS: Record<ToastTone, number> = { success: 3500, info: 5000, error: 7000 };

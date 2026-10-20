import { z } from "zod";

// ---------------------------------------------------------------------------
// Channel canvas (Phase 24): one rich-text document per conversation, edited
// beside the chat. Stored as sanitized HTML (the editor's own output), saved
// whole with a version for last-writer-wins: a save carries the version it
// was based on, and the server refuses one based on an older version.
// ---------------------------------------------------------------------------

/** The most a canvas may hold, in bytes of HTML (a DynamoDB item is 400 KB). */
export const MAX_CANVAS_BYTES = 200_000;

export interface Canvas {
  channelId: string;
  /** Sanitized HTML; `""` for a canvas nobody has written in yet. */
  content: string;
  /** `0` before the first save, then +1 per save. */
  version: number;
  /** Epoch ms of the last save (`0` when none). */
  updatedAt: number;
  /** Who saved last (`""` when nobody). */
  updatedBy: string;
}

/** An untouched canvas: what `GET` answers before the first save. */
export const emptyCanvas = (channelId: string): Canvas => ({
  channelId,
  content: "",
  version: 0,
  updatedAt: 0,
  updatedBy: "",
});

export const SaveCanvasSchema = z.object({
  content: z.string().max(MAX_CANVAS_BYTES, "the canvas is too long"),
  /** The version this content was edited from. */
  version: z.number().int().nonnegative(),
});
export type SaveCanvasInput = z.infer<typeof SaveCanvasSchema>;

/**
 * Someone saved the channel's canvas: the new version and who. The content
 * isn't pushed (it may be large); a client showing the canvas fetches it.
 */
export interface CanvasUpdatedEvent {
  type: "canvas.updated";
  channelId: string;
  version: number;
  updatedAt: number;
  updatedBy: string;
}

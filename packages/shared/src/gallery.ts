import type { Attachment, Message } from "./protocol";

// ---------------------------------------------------------------------------
// Phase 61: a conversation's image gallery. Messages with at least one image
// carry `imageAt` (`<epochMs, 13 digits>#<messageId>`), the sort key of the
// messages table's sparse GSI `IMAGE_INDEX` (partition `channelId`). No other
// message has the attribute, so none of them is in the index: the viewer's
// `GET /channels/{channelId}/media` reads images only, never text.
//
// The table's own sort key can't order the gallery: thread replies are
// `thread#<parentSk>#…` and sort after every top-level message. `imageAt`
// orders top-level messages and replies alike by when they were sent.
// ---------------------------------------------------------------------------

/** The messages table's sparse index of messages with images. */
export const IMAGE_INDEX = "byImage";
/** Its sort key, written only on messages that have an image. */
export const IMAGE_AT_ATTRIBUTE = "imageAt";
/** Images on each side of the one opened: the viewer holds at most 2 × this + 1. */
export const MEDIA_WINDOW = 15;

export const isImageAttachment = (a: Pick<Attachment, "contentType">) =>
  a.contentType.startsWith("image/");

/** The gallery position of a message sent at `createdAt` (also the `around` of the request). */
export function imageAtFor(createdAt: number, messageId: string): string {
  return `${String(Math.max(0, Math.floor(createdAt))).padStart(13, "0")}#${messageId}`;
}

export const IMAGE_AT_PATTERN = /^\d{13}#[0-9A-Za-z_-]{1,64}$/;

/**
 * `imageAt` for a message as it is stored, or `undefined` when it has no
 * place in the gallery: no image, a secret (masked, and gone in a day), a
 * server card, or a deleted message.
 */
export function imageAtOf(
  message: Pick<Message, "createdAt" | "messageId" | "attachments"> &
    Partial<Pick<Message, "isSecret" | "kind" | "deletedAt">>,
): string | undefined {
  if (message.isSecret || message.kind || message.deletedAt) return undefined;
  if (!(message.attachments ?? []).some(isImageAttachment)) return undefined;
  return imageAtFor(message.createdAt, message.messageId);
}

/** One image of the gallery, with the signed URLs to show it. */
export interface ChannelImage {
  channelId: string;
  /** The message's sort key (to jump to it). */
  sk: string;
  messageId: string;
  userId: string;
  createdAt: number;
  imageAt: string;
  /** The attachment's position among the message's attachments. */
  position: number;
  attachment: Attachment;
}

/** `GET /channels/{channelId}/media?around=<imageAt>&key=<attachment key>`. */
export interface ChannelMediaWindow {
  /** Oldest first: up to `MEDIA_WINDOW` before the opened image, it, up to `MEDIA_WINDOW` after. */
  images: ChannelImage[];
  /** Where the opened image is in `images`; -1 when it isn't in the gallery (deleted). */
  index: number;
  /** There are older / newer images than the window holds. */
  hasOlder: boolean;
  hasNewer: boolean;
}

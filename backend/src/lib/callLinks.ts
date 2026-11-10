import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { EXTERNAL_ID_PREFIX } from "@mindfultech/shared";
import { getRoom, type RoomItem } from "./callRooms";

// ---------------------------------------------------------------------------
// Call links (Phase 59). A link carries `<channel>.<secret>`: the channel says
// which call row to read, the secret must match the one on that row, and the
// row only lives while the call does, so a link stops working when the call
// ends. Whoever opens it has no account: their WebSocket `token` is
// `call:<token>` (with the call's id, a name and a per-tab id), and their
// connection is tied to that one call.
// ---------------------------------------------------------------------------

/** The token a link carries for `secret` of `channelId`'s call. */
export function encodeCallToken(channelId: string, secret: string): string {
  return `${Buffer.from(channelId, "utf8").toString("base64url")}.${secret}`;
}

/** A link's token taken apart, or `null` when it isn't one. */
export function decodeCallToken(token: string): { channelId: string; secret: string } | null {
  const match = /^([\w-]{1,400})\.([\w-]{16,128})$/.exec(token);
  if (!match) return null;
  const channelId = Buffer.from(match[1]!, "base64url").toString("utf8");
  if (!channelId || channelId.length > 256 || /[^\w-]/.test(channelId)) return null;
  return { channelId, secret: match[2]! };
}

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * The call a link's token opens, if the token is right and that call
 * (`roomId`) still goes on; `null` otherwise, whatever the reason (a wrong
 * secret, another call since, an ended one), so a guess learns nothing.
 */
export async function callForToken(token: string, roomId: string): Promise<RoomItem | null> {
  const parsed = decodeCallToken(token);
  if (!parsed) return null;
  const room = await getRoom(parsed.channelId);
  if (!room?.linkToken || room.roomId !== roomId) return null;
  return sameSecret(room.linkToken, parsed.secret) ? room : null;
}

/**
 * An external's id in a call: the same for the same browser tab (`clientId`,
 * random, kept by the page) across reconnects, so being let in survives a
 * dropped socket; a hash, so seeing someone's id doesn't let you be them.
 * Without a usable `clientId`, a fresh one.
 */
export function externalUserId(roomId: string, clientId: string | undefined): string {
  const seed =
    clientId && /^[\w-]{16,64}$/.test(clientId) ? clientId : randomBytes(16).toString("hex");
  const hash = createHash("sha256").update(`${roomId}:${seed}`).digest("base64url").slice(0, 22);
  return `${EXTERNAL_ID_PREFIX}${hash}`;
}

import { canAccessChannel, parseAction, PresignActionSchema } from "@mindfultech/shared";
import { ulid } from "ulid";
import { wsHandler } from "../lib/handler";
import { badRequest, ok, reply, replyError } from "../lib/response";
import { objectExists, presignGet, presignPut } from "../lib/s3";

const KEY_PREFIX = "attachments/";

/** Keeps `[a-zA-Z0-9._-]`, replacing anything else with `_`. */
export function sanitizeFileName(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "");
  return (safe || "file").slice(-100);
}

/** Channel id encoded in `attachments/<channelId>/<file>`, or `null`. */
function channelOfKey(key: string): string | null {
  if (!key.startsWith(KEY_PREFIX) || key.includes("..")) return null;
  const [channelId, file] = key.slice(KEY_PREFIX.length).split("/");
  return channelId && file ? channelId : null;
}

/** `presign`: short-lived S3 URLs; the binary never goes through Lambda. */
export const handler = wsHandler(async (event, caller) => {
  const parsed = parseAction(PresignActionSchema, event.body);
  if (!parsed.success) return badRequest(caller.connectionId, parsed.error);
  const action = parsed.data;

  if (action.op === "put") {
    if (!canAccessChannel(action.channelId, caller.userId)) {
      return replyError(caller.connectionId, "CHANNEL_NOT_FOUND", undefined, action.requestId);
    }
    const key = `${KEY_PREFIX}${action.channelId}/${ulid()}-${sanitizeFileName(action.name)}`;
    const url = await presignPut(key, action.contentType, action.size);
    await reply(caller.connectionId, {
      type: "presign.result",
      url,
      key,
      requestId: action.requestId,
    });
    return ok();
  }

  const channelId = channelOfKey(action.key);
  if (!channelId || !canAccessChannel(channelId, caller.userId)) {
    return badRequest(caller.connectionId, "Invalid key", action.requestId);
  }
  if (!(await objectExists(action.key))) {
    return replyError(caller.connectionId, "FILE_NOT_FOUND", undefined, action.requestId);
  }
  const url = await presignGet(action.key);
  await reply(caller.connectionId, {
    type: "presign.result",
    url,
    key: action.key,
    requestId: action.requestId,
  });
  return ok();
});

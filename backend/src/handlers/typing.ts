import { parseAction, TypingActionSchema } from "@mindfultech/shared";
import { deliver, listConnections } from "../lib/broadcast";
import { channelAudience, getAccessibleChannel } from "../lib/channels";
import { wsHandler } from "../lib/handler";
import { badRequest, ok, replyError } from "../lib/response";

/**
 * `typing`: tells everyone else in the channel that the caller is typing
 * (`user.typing`). Nothing is stored; clients throttle to one every few
 * seconds and let the indicator expire on their own.
 */
export const handler = wsHandler(async (event, caller) => {
  const parsed = parseAction(TypingActionSchema, event.body);
  if (!parsed.success) return badRequest(caller.connectionId, parsed.error);
  const { channelId } = parsed.data;

  const channel = await getAccessibleChannel(channelId, caller.userId);
  if (!channel) return replyError(caller.connectionId, "CHANNEL_NOT_FOUND");

  const inAudience = channelAudience(channel);
  const others = (await listConnections()).filter(
    (c) => c.userId !== caller.userId && inAudience(c),
  );
  await deliver(others, () => ({ type: "user.typing", channelId, userId: caller.userId }));
  return ok();
});

import {
  CallActionSchema,
  dmMembers,
  parseAction,
  type CallAction,
  type CallEvent,
} from "@mindfultech/shared";
import { deliver, listConnections } from "../lib/broadcast";
import { wsHandler } from "../lib/handler";
import { log } from "../lib/logger";
import { badRequest, ok, reply, replyError } from "../lib/response";

/** Server event for a signal: the action's fields plus the verified sender. */
function toEvent(action: CallAction, from: string): CallEvent {
  const base = { callId: action.callId, channelId: action.channelId, from };
  switch (action.signal) {
    case "offer":
      return { ...base, type: "call.offer", media: action.media, sdp: action.sdp };
    case "answer":
      return { ...base, type: "call.answer", sdp: action.sdp };
    case "ice_candidate":
      return { ...base, type: "call.ice_candidate", candidate: action.candidate };
    case "end":
      return { ...base, type: "call.end", reason: action.reason };
    case "decline":
      return { ...base, type: "call.decline", reason: action.reason };
  }
}

/**
 * Signals that settle a call for the sender too: their other tabs stop
 * ringing (answered or declined elsewhere) or drop a stale call view.
 */
const SETTLING = new Set<CallAction["signal"]>(["answer", "decline", "end"]);

/**
 * `call`: relays WebRTC signaling (offer, answer, ICE candidates, end,
 * decline) between the two members of a DM. Only JSON goes through AWS;
 * media flows peer to peer. Nothing is stored.
 */
export const handler = wsHandler(async (event, caller) => {
  const parsed = parseAction(CallActionSchema, event.body);
  if (!parsed.success) return badRequest(caller.connectionId, parsed.error);
  const action = parsed.data;

  // 1:1 only: the DM id itself names its two members, so no table read is needed.
  const members = dmMembers(action.channelId);
  if (!members) return badRequest(caller.connectionId, "Calls are only available in DMs");
  if (
    action.to === caller.userId ||
    !members.includes(caller.userId) ||
    !members.includes(action.to)
  ) {
    return replyError(caller.connectionId, "FORBIDDEN", "You can only call the other DM member");
  }

  const signal = toEvent(action, caller.userId);
  const connections = await listConnections();
  const toPeer = connections.filter((c) => c.userId === action.to);
  const toMyOtherTabs = SETTLING.has(action.signal)
    ? connections.filter(
        (c) => c.userId === caller.userId && c.connectionId !== caller.connectionId,
      )
    : [];

  const [reachedPeer] = await Promise.all([
    deliver(toPeer, () => signal),
    deliver(toMyOtherTabs, () => signal),
  ]);
  log.info("call signal", {
    callId: action.callId,
    signal: action.signal,
    userId: caller.userId,
    reachedPeer,
  });

  if (action.signal === "offer" && reachedPeer === 0) {
    // Nobody to ring: tell the caller right away instead of letting it time out.
    await reply(caller.connectionId, {
      type: "call.end",
      callId: action.callId,
      channelId: action.channelId,
      from: action.to,
      reason: "unavailable",
    });
  }
  return ok();
});

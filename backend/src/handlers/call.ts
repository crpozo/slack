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

/**
 * Server events for a signal: the action's fields plus the verified sender.
 * A batch of ICE candidates fans out to one `call.ice_candidate` each.
 */
function toEvents(action: CallAction, from: string): CallEvent[] {
  const base = { callId: action.callId, channelId: action.channelId, from };
  switch (action.signal) {
    case "offer":
      return [{ ...base, type: "call.offer", media: action.media, sdp: action.sdp }];
    case "answer":
      return [{ ...base, type: "call.answer", sdp: action.sdp }];
    case "ice_candidate":
      return [{ ...base, type: "call.ice_candidate", candidate: action.candidate }];
    case "ice_candidates":
      return action.candidates.map((candidate) => ({
        ...base,
        type: "call.ice_candidate" as const,
        candidate,
      }));
    case "end":
      return [{ ...base, type: "call.end", reason: action.reason }];
    case "decline":
      return [{ ...base, type: "call.decline", reason: action.reason }];
    case "renegotiate":
      return [
        {
          ...base,
          type: "call.renegotiate",
          kind: action.kind,
          sdp: action.sdp,
          restart: action.restart,
        },
      ];
  }
}

/**
 * Signals that settle a call for the sender too: their other tabs stop
 * ringing (answered or declined elsewhere) or drop a stale call view.
 */
const SETTLING = new Set<CallAction["signal"]>(["answer", "decline", "end"]);

/**
 * `call`: relays WebRTC signaling (offer, answer, ICE candidates, end,
 * decline, and the ICE restarts of a call that lost its network) between
 * the two members of a DM. Only JSON goes through AWS; media flows peer to
 * peer. Nothing is stored.
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

  const signals = toEvents(action, caller.userId);
  const connections = await listConnections();
  const toPeer = connections.filter((c) => c.userId === action.to);
  const toMyOtherTabs = SETTLING.has(action.signal)
    ? connections.filter(
        (c) => c.userId === caller.userId && c.connectionId !== caller.connectionId,
      )
    : [];

  const [peerCounts] = await Promise.all([
    Promise.all(signals.map((signal) => deliver(toPeer, () => signal))),
    Promise.all(signals.map((signal) => deliver(toMyOtherTabs, () => signal))),
  ]);
  const reachedPeer = Math.max(0, ...peerCounts);
  log.info("call signal", {
    callId: action.callId,
    signal: action.signal,
    ...(signals.length > 1 && { count: signals.length }),
    ...((action.signal === "end" || action.signal === "decline") && { reason: action.reason }),
    ...(action.signal === "renegotiate" && { kind: action.kind, restart: action.restart }),
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

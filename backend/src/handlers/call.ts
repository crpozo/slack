import {
  CallActionSchema,
  dmMembers,
  isRoomOp,
  parseAction,
  type CallAction,
  type CallEvent,
  type CallPeerSignal,
  type Channel,
} from "@mindfultech/shared";
import { deliver, listConnections } from "../lib/broadcast";
import {
  announceRoom,
  getRoom,
  joinRoom,
  listRooms,
  markConnectionRoom,
  toRoom,
  vacate,
  type RoomItem,
} from "../lib/callRooms";
import { getAccessibleChannel } from "../lib/channels";
import { wsHandler, type Caller } from "../lib/handler";
import { log } from "../lib/logger";
import { badRequest, ok, reply, replyError } from "../lib/response";

/**
 * Server events for a signal: the action's fields plus the verified sender.
 * A batch of ICE candidates fans out to one `call.ice_candidate` each.
 */
function toEvents(action: CallPeerSignal, from: string): CallEvent[] {
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

/** Signals a pair inside a channel call exchanges (joining and leaving are room ops). */
const ROOM_SIGNALS = new Set<CallAction["signal"]>([
  "offer",
  "answer",
  "ice_candidate",
  "ice_candidates",
  "renegotiate",
]);

/**
 * `call`: relays WebRTC signaling (offer, answer, ICE candidates, end,
 * decline, and the ICE restarts of a call that lost its network). Only JSON
 * goes through AWS; media flows peer to peer. Two kinds of call:
 * - a DM call, between the two members of the DM (nothing is stored);
 * - a channel call (Phase 36): a room of up to six people (`call-rooms`),
 *   joined and left with `join`/`leave`, where each pair has its own
 *   connection (a mesh) and signals go only between people seated in the
 *   room, to the connection each one joined from.
 */
export const handler = wsHandler(async (event, caller) => {
  const parsed = parseAction(CallActionSchema, event.body);
  if (!parsed.success) return badRequest(caller.connectionId, parsed.error);
  const action = parsed.data;

  if (isRoomOp(action)) {
    if (action.signal === "rooms") return sendRooms(caller);
    if (action.signal === "join") return join(action, caller);
    return leave(action, caller);
  }
  if (!dmMembers(action.channelId)) return relayInRoom(action, caller);

  // 1:1 only: the DM id itself names its two members, so no table read is needed.
  const members = dmMembers(action.channelId)!;
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

// --- Channel calls (Phase 36) ---------------------------------------------------

/** A channel the caller may hold a call in: theirs to use, not a DM, not archived. */
async function callableChannel(channelId: string, caller: Caller): Promise<Channel | null> {
  if (dmMembers(channelId)) return null; // DM calls ring instead
  return getAccessibleChannel(channelId, caller.userId);
}

async function sendRooms(caller: Caller) {
  const rooms = await listRooms();
  const visible = await Promise.all(
    rooms.map(async (room) =>
      (await getAccessibleChannel(room.channelId, caller.userId)) ? toRoom(room) : null,
    ),
  );
  await reply(caller.connectionId, {
    type: "call.rooms",
    rooms: visible.filter((r) => r !== null),
  });
  return ok();
}

async function join(action: Extract<CallAction, { signal: "join" }>, caller: Caller) {
  const channel = await callableChannel(action.channelId, caller);
  if (!channel) return replyError(caller.connectionId, "CHANNEL_NOT_FOUND");
  const connections = await listConnections();
  const result = await joinRoom({
    channelId: channel.channelId,
    userId: caller.userId,
    connectionId: caller.connectionId,
    media: action.media,
    live: new Set(connections.map((c) => c.connectionId)),
  });
  if ("full" in result) {
    return replyError(caller.connectionId, "CALL_FULL", "That call is full (6 people at most)");
  }
  const { room, started } = result;
  await markConnectionRoom(caller.connectionId, channel.channelId);
  log.info(started ? "channel call started" : "channel call joined", {
    channelId: channel.channelId,
    roomId: room.roomId,
    userId: caller.userId,
    participants: Object.keys(room.participants).length,
    rejoin: action.callId === room.roomId,
  });
  await announceRoom(
    channel,
    {
      type: "call.room",
      channelId: channel.channelId,
      room: toRoom(room),
      change: started ? "started" : "joined",
      userId: caller.userId,
    },
    connections,
  );
  return ok();
}

async function leave(action: Extract<CallAction, { signal: "leave" }>, caller: Caller) {
  const channel = await getAccessibleChannel(action.channelId, caller.userId, {
    allowArchived: true,
  });
  if (!channel) return replyError(caller.connectionId, "CHANNEL_NOT_FOUND");
  await markConnectionRoom(caller.connectionId, null);
  await vacate(channel, caller.userId, caller.connectionId);
  return ok();
}

/** A signal between two people in a channel call: both seated, delivered to the seat's connection. */
async function relayInRoom(action: CallPeerSignal, caller: Caller) {
  if (!ROOM_SIGNALS.has(action.signal)) {
    return badRequest(caller.connectionId, "Channel calls are left with `leave`");
  }
  const room: RoomItem | null = await getRoom(action.channelId);
  const mine = room?.participants[caller.userId];
  const theirs = room?.participants[action.to];
  if (
    !room ||
    room.roomId !== action.callId ||
    mine?.connectionId !== caller.connectionId ||
    !theirs ||
    action.to === caller.userId
  ) {
    return replyError(caller.connectionId, "FORBIDDEN", "You aren't in that call with them");
  }
  const connections = await listConnections();
  const target = connections.filter((c) => c.connectionId === theirs.connectionId);
  const signals = toEvents(action, caller.userId);
  const reached = await Promise.all(signals.map((signal) => deliver(target, () => signal)));
  log.info("room signal", {
    channelId: action.channelId,
    roomId: room.roomId,
    signal: action.signal,
    ...(signals.length > 1 && { count: signals.length }),
    userId: caller.userId,
    to: action.to,
    reached: Math.max(0, ...reached),
  });
  return ok();
}

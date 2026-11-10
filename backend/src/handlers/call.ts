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
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { deliver, listConnections } from "../lib/broadcast";
import { encodeCallToken } from "../lib/callLinks";
import {
  announceRoom,
  answerKnock,
  ensureLink,
  getRoom,
  joinRoom,
  knock,
  listRooms,
  markConnectionRoom,
  toRoom,
  vacate,
  type RoomItem,
} from "../lib/callRooms";
import { getAccessibleChannel, getChannelRow } from "../lib/channels";
import { ddb, tables } from "../lib/ddb";
import { wsHandler, type Caller, type ExternalScope } from "../lib/handler";
import { errorFields, log } from "../lib/logger";
import { badRequest, ok, reply, replyError } from "../lib/response";
import { defaultDisplayName } from "../lib/users";

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

  // Phase 59: an external (a call link) acts in their one call only.
  if (caller.external) return externalAction(action, caller, caller.external);

  if (isRoomOp(action)) {
    switch (action.signal) {
      case "rooms":
        return sendRooms(caller);
      case "join":
        return join(action, caller);
      case "leave":
        return leave(action, caller);
      case "link":
      case "admit":
        // Sharing the call and letting people in is the team's, never a guest's.
        if (caller.role === "guest") {
          return replyError(caller.connectionId, "FORBIDDEN", "Only the team can invite people");
        }
        return action.signal === "link" ? shareLink(action, caller) : admit(action, caller);
      case "knock":
        return badRequest(caller.connectionId, "Only someone with a call link knocks");
    }
  }
  if (!dmMembers(action.channelId)) return relayInRoom(action, caller);
  // Phase 59: guests are in channel calls only (they have no DMs).
  if (caller.role === "guest") {
    return replyError(caller.connectionId, "FORBIDDEN", "Guests only join their channels' calls");
  }

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
  return getAccessibleChannel(channelId, caller);
}

async function sendRooms(caller: Caller) {
  const rooms = await listRooms();
  const visible = await Promise.all(
    rooms.map(async (room) =>
      (await getAccessibleChannel(room.channelId, caller)) ? toRoom(room) : null,
    ),
  );
  await reply(caller.connectionId, {
    type: "call.rooms",
    rooms: visible.filter((r) => r !== null),
  });
  return ok();
}

/**
 * Phase 59: the name the others see in the call: the directory's, else the
 * email's (externals see no directory, so the room carries everyone's).
 */
async function seatName(caller: Caller): Promise<string> {
  try {
    const { Item } = (await ddb.send(
      new GetCommand({
        TableName: tables.users,
        Key: { userId: caller.userId },
        ProjectionExpression: "displayName",
      }),
    )) ?? { Item: undefined };
    if (typeof Item?.displayName === "string" && Item.displayName) return Item.displayName;
  } catch (err) {
    log.warn("couldn't read a caller's name", { userId: caller.userId, ...errorFields(err) });
  }
  return defaultDisplayName(caller.userEmail);
}

async function join(action: Extract<CallAction, { signal: "join" }>, caller: Caller) {
  // Guests too (Phase 59): `getAccessibleChannel` lets them into their private channels only.
  const channel = await callableChannel(action.channelId, caller);
  if (!channel) return replyError(caller.connectionId, "CHANNEL_NOT_FOUND");
  const connections = await listConnections();
  const result = await joinRoom({
    channelId: channel.channelId,
    userId: caller.userId,
    connectionId: caller.connectionId,
    media: action.media,
    live: new Set(connections.map((c) => c.connectionId)),
    name: await seatName(caller),
    ...(caller.role === "guest" && { kind: "guest" as const }),
  });
  if ("gone" in result) return replyError(caller.connectionId, "CHANNEL_NOT_FOUND");
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
  const channel = await getAccessibleChannel(action.channelId, caller, {
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

// --- Guests and externals (Phase 59) ----------------------------------------------

/**
 * The room the caller sits in through this very connection, in a channel they
 * can use: sharing its link and letting people in is for those in the call.
 */
async function seatedRoom(
  channelId: string,
  callId: string,
  caller: Caller,
): Promise<{ room: RoomItem; channel: Channel } | null> {
  const channel = await callableChannel(channelId, caller);
  if (!channel) return null;
  const room = await getRoom(channelId);
  if (!room || room.roomId !== callId) return null;
  if (room.participants[caller.userId]?.connectionId !== caller.connectionId) return null;
  return { room, channel };
}

/** `link`: the call's shareable link (the same one for everyone in it, until it ends). */
async function shareLink(action: Extract<CallAction, { signal: "link" }>, caller: Caller) {
  const seated = await seatedRoom(action.channelId, action.callId, caller);
  if (!seated) {
    return replyError(caller.connectionId, "FORBIDDEN", "Join the call to share its link");
  }
  const secret = await ensureLink(action.channelId, seated.room.roomId);
  if (!secret) return replyError(caller.connectionId, "CHANNEL_NOT_FOUND", "That call ended");
  log.info("call link shared", {
    channelId: action.channelId,
    roomId: seated.room.roomId,
    userId: caller.userId,
  });
  await reply(caller.connectionId, {
    type: "call.link",
    channelId: action.channelId,
    roomId: seated.room.roomId,
    token: encodeCallToken(action.channelId, secret),
  });
  return ok();
}

/** Tells an external where they stand (`call.lobby`), on their own connection. */
function lobby(
  connectionId: string,
  scope: ExternalScope,
  userId: string,
  status: "waiting" | "admitted" | "denied" | "ended",
) {
  return reply(connectionId, {
    type: "call.lobby",
    status,
    channelId: scope.channelId,
    roomId: scope.roomId,
    userId,
  });
}

/** `admit`: someone in the call lets an external in from the lobby, or turns them away. */
async function admit(action: Extract<CallAction, { signal: "admit" }>, caller: Caller) {
  const seated = await seatedRoom(action.channelId, action.callId, caller);
  if (!seated) {
    return replyError(caller.connectionId, "FORBIDDEN", "Only people in the call let others in");
  }
  const answered = await answerKnock(seated.room, action.userId, action.admit);
  if (!answered) return ok(); // someone else answered first, or they left the lobby
  const scope = {
    channelId: action.channelId,
    roomId: seated.room.roomId,
    name: answered.knock.name,
  };
  await lobby(
    answered.knock.connectionId,
    scope,
    action.userId,
    action.admit ? "admitted" : "denied",
  );
  log.info(action.admit ? "external let in" : "external turned away", {
    channelId: action.channelId,
    roomId: seated.room.roomId,
    by: caller.userId,
    userId: action.userId,
  });
  await announceRoom(seated.channel, {
    type: "call.room",
    channelId: action.channelId,
    room: toRoom(answered.room),
    change: "waiting",
    userId: action.userId,
  });
  return ok();
}

/**
 * An external's action: knock, join once let in, leave, and the signals of
 * that call. Never another channel, another call, a DM, a link or the list
 * of calls.
 */
async function externalAction(action: CallAction, caller: Caller, scope: ExternalScope) {
  if (action.signal === "knock") return knockAsExternal(caller, scope);
  if (!("channelId" in action) || action.channelId !== scope.channelId) {
    return replyError(caller.connectionId, "FORBIDDEN", "This link is for one call only");
  }
  switch (action.signal) {
    case "join":
      return joinAsExternal(action, caller, scope);
    case "leave": {
      const channel = await getChannelRow(scope.channelId);
      await markConnectionRoom(caller.connectionId, null);
      if (channel) await vacate(channel, caller.userId, caller.connectionId);
      return ok();
    }
    case "offer":
    case "answer":
    case "ice_candidate":
    case "ice_candidates":
    case "renegotiate":
      if (action.callId !== scope.roomId) {
        return replyError(caller.connectionId, "FORBIDDEN", "This link is for one call only");
      }
      return relayInRoom(action, caller);
    default:
      return replyError(caller.connectionId, "FORBIDDEN", "This link is for the call only");
  }
}

/** `knock`: into the lobby (or straight to `admitted` when already let in, e.g. after a reconnect). */
async function knockAsExternal(caller: Caller, scope: ExternalScope) {
  const room = await getRoom(scope.channelId);
  if (!room || room.roomId !== scope.roomId || !room.linkToken) {
    await lobby(caller.connectionId, scope, caller.userId, "ended");
    return ok();
  }
  if (room.admitted?.[caller.userId]) {
    await lobby(caller.connectionId, scope, caller.userId, "admitted");
    return ok();
  }
  const after = await knock(room, caller.userId, {
    name: scope.name,
    connectionId: caller.connectionId,
    at: Date.now(),
  });
  const channel = after && (await getChannelRow(scope.channelId));
  if (!after || !channel) {
    await lobby(caller.connectionId, scope, caller.userId, "ended");
    return ok();
  }
  log.info("external knocked", {
    channelId: scope.channelId,
    roomId: scope.roomId,
    userId: caller.userId,
  });
  await lobby(caller.connectionId, scope, caller.userId, "waiting");
  await announceRoom(channel, {
    type: "call.room",
    channelId: scope.channelId,
    room: toRoom(after),
    change: "waiting",
    userId: caller.userId,
  });
  return ok();
}

/** `join` for an external: only their call, only once let in, never starting one. */
async function joinAsExternal(
  action: Extract<CallAction, { signal: "join" }>,
  caller: Caller,
  scope: ExternalScope,
) {
  const room = await getRoom(scope.channelId);
  const channel = await getChannelRow(scope.channelId);
  if (!room || room.roomId !== scope.roomId || !channel) {
    await lobby(caller.connectionId, scope, caller.userId, "ended");
    return ok();
  }
  if (!room.admitted?.[caller.userId]) {
    return replyError(
      caller.connectionId,
      "FORBIDDEN",
      "Wait until someone in the call lets you in",
    );
  }
  const connections = await listConnections();
  const result = await joinRoom({
    channelId: scope.channelId,
    userId: caller.userId,
    connectionId: caller.connectionId,
    media: action.media,
    live: new Set(connections.map((c) => c.connectionId)),
    name: scope.name,
    kind: "external",
    onlyRoom: scope.roomId,
  });
  if ("gone" in result) {
    await lobby(caller.connectionId, scope, caller.userId, "ended");
    return ok();
  }
  if ("full" in result) {
    return replyError(caller.connectionId, "CALL_FULL", "That call is full (6 people at most)");
  }
  await markConnectionRoom(caller.connectionId, scope.channelId);
  log.info("external joined a call", {
    channelId: scope.channelId,
    roomId: scope.roomId,
    userId: caller.userId,
  });
  await announceRoom(
    channel,
    {
      type: "call.room",
      channelId: scope.channelId,
      room: toRoom(result.room),
      change: "joined",
      userId: caller.userId,
    },
    connections,
  );
  return ok();
}

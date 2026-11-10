import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  isExternalId,
  MAX_ROOM_PARTICIPANTS,
  type CallMedia,
  type CallRoom,
  type CallRoomEvent,
  type Channel,
  type ParticipantKind,
} from "@mindfultech/shared";
import { randomBytes } from "node:crypto";
import { ulid } from "ulid";
import { deliver, listConnections, type LiveConnection } from "./broadcast";
import { channelAudience } from "./channels";
import { ddb, tables } from "./ddb";
import { errorFields, log } from "./logger";

// ---------------------------------------------------------------------------
// Channel calls (Phase 36): one row per channel in `call-rooms` while a call
// goes on: who is in it and through which connection (signals go to that
// connection only, never to the person's other tabs). Rows expire (TTL) as a
// safety net; people whose socket closed are removed by `$disconnect`, and
// seats held by connections that are gone are freed whenever someone joins.
// ---------------------------------------------------------------------------

/** A room row lives this long after the last join (TTL, seconds). */
const ROOM_TTL_S = 6 * 60 * 60;

interface Seat {
  connectionId: string;
  joinedAt: number;
  media: CallMedia;
  /** Phase 59: the name everyone in the call sees (externals have no directory). */
  name?: string;
  /** Phase 59: absent for the team. */
  kind?: ParticipantKind;
}

/** Phase 59: an external in the lobby, or one let in (who may then `join`). */
export interface Knock {
  name: string;
  connectionId: string;
  at: number;
}

export interface RoomItem {
  channelId: string;
  roomId: string;
  startedAt: number;
  startedBy: string;
  participants: Record<string, Seat>;
  /** Epoch seconds (DynamoDB TTL). */
  expiresAt: number;
  /**
   * Phase 59: the secret of the call's shareable link, made the first time
   * someone in the call asks for it; it dies with the row (the call's end).
   */
  linkToken?: string;
  /** Phase 59: externals waiting in the lobby, by their id. */
  knocks?: Record<string, Knock>;
  /** Phase 59: externals someone let in, by their id (they may `join`, and rejoin). */
  admitted?: Record<string, Knock>;
}

const nowS = () => Math.floor(Date.now() / 1000);
const isCondition = (err: unknown) => err instanceof ConditionalCheckFailedException;

/** What clients see: no connection ids, people in the order they joined. */
export function toRoom(item: RoomItem): CallRoom {
  return {
    channelId: item.channelId,
    roomId: item.roomId,
    startedAt: item.startedAt,
    startedBy: item.startedBy,
    participants: Object.entries(item.participants ?? {})
      .map(([userId, seat]) => ({
        userId,
        joinedAt: seat.joinedAt,
        media: seat.media,
        ...(seat.name && { name: seat.name }),
        ...(seat.kind && { kind: seat.kind }),
      }))
      .sort((a, b) => a.joinedAt - b.joinedAt || a.userId.localeCompare(b.userId)),
    ...waitingOf(item),
  };
}

/** The lobby, oldest first, without connection ids (absent when nobody waits). */
function waitingOf(item: RoomItem): Pick<CallRoom, "waiting"> {
  const waiting = Object.entries(item.knocks ?? {})
    .map(([userId, k]) => ({ userId, name: k.name, at: k.at }))
    .sort((a, b) => a.at - b.at || a.userId.localeCompare(b.userId));
  return waiting.length ? { waiting } : {};
}

/** The channel's call, unless there's none (or only an expired row TTL hasn't removed yet). */
export async function getRoom(channelId: string): Promise<RoomItem | null> {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: tables.callRooms, Key: { channelId }, ConsistentRead: true }),
  );
  const room = Item as RoomItem | undefined;
  if (!room || room.expiresAt <= nowS()) return null;
  return room;
}

/** Every call going on (a handful of rows: one per channel in a call). */
export async function listRooms(): Promise<RoomItem[]> {
  const rooms: RoomItem[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new ScanCommand({ TableName: tables.callRooms, ExclusiveStartKey: startKey }),
    );
    rooms.push(...((page.Items ?? []) as RoomItem[]));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return rooms.filter((r) => r.expiresAt > nowS());
}

export type JoinResult = { room: RoomItem; started: boolean } | { full: true };

/**
 * Seats `userId` (through `connectionId`) in the channel's call, starting one
 * when there's none. Seats of connections no longer `live` are freed in the
 * same write; the cap (`MAX_ROOM_PARTICIPANTS`) is a condition of that write,
 * so two people joining at once can't both take the last seat.
 */
export async function joinRoom(input: {
  channelId: string;
  userId: string;
  connectionId: string;
  media: CallMedia;
  live: ReadonlySet<string>;
  /** Phase 59: the name and badge the others see. */
  name?: string;
  kind?: ParticipantKind;
  /**
   * Phase 59, externals: only this call, never a new one, and only once let
   * in (`admitted`); `{ gone: true }` when it's over.
   */
  onlyRoom?: string;
}): Promise<JoinResult | { gone: true }> {
  const { channelId, userId, connectionId, media, live, name, kind, onlyRoom } = input;
  const now = Date.now();
  const seat: Seat = {
    connectionId,
    joinedAt: now,
    media,
    ...(name && { name }),
    ...(kind && { kind }),
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await getRoom(channelId);
    if (onlyRoom && (!current || current.roomId !== onlyRoom)) return { gone: true };
    if (!current) {
      const room: RoomItem = {
        channelId,
        roomId: ulid(now),
        startedAt: now,
        startedBy: userId,
        participants: { [userId]: seat },
        expiresAt: nowS() + ROOM_TTL_S,
      };
      try {
        await ddb.send(
          new PutCommand({
            TableName: tables.callRooms,
            Item: room,
            // A row TTL hasn't removed yet counts as no call.
            ConditionExpression: "attribute_not_exists(channelId) OR expiresAt <= :now",
            ExpressionAttributeValues: { ":now": nowS() },
          }),
        );
        return { room, started: true };
      } catch (err) {
        if (isCondition(err)) continue; // someone started it just now: join theirs
        throw err;
      }
    }

    const stale = Object.entries(current.participants ?? {})
      .filter(([id, s]) => id !== userId && !live.has(s.connectionId))
      .map(([id]) => id);
    const others = Object.keys(current.participants ?? {}).filter(
      (id) => id !== userId && !stale.includes(id),
    );
    if (others.length >= MAX_ROOM_PARTICIPANTS) return { full: true };

    const names: Record<string, string> = { "#p": "participants", "#u": userId };
    stale.forEach((id, i) => (names[`#s${i}`] = id));
    const remove = stale.length ? ` REMOVE ${stale.map((_, i) => `#p.#s${i}`).join(", ")}` : "";
    try {
      const { Attributes } = await ddb.send(
        new UpdateCommand({
          TableName: tables.callRooms,
          Key: { channelId },
          UpdateExpression: `SET #p.#u = :seat, expiresAt = :ttl${remove}`,
          // Same call still, and a seat left (counting the stale ones this frees);
          // an external, only once let in.
          ConditionExpression:
            "roomId = :room AND (attribute_exists(#p.#u) OR size(#p) < :limit)" +
            (onlyRoom ? " AND attribute_exists(admitted.#u)" : ""),
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: {
            ":seat": seat,
            ":ttl": nowS() + ROOM_TTL_S,
            ":room": current.roomId,
            ":limit": MAX_ROOM_PARTICIPANTS + stale.length,
          },
          ReturnValues: "ALL_NEW",
        }),
      );
      if (stale.length) log.info("stale call seats freed", { channelId, userIds: stale });
      return { room: Attributes as RoomItem, started: false };
    } catch (err) {
      if (!isCondition(err)) throw err;
      // The call ended, or filled up, meanwhile: look again.
    }
  }
  return { full: true };
}

export type LeaveResult =
  | { left: false }
  | { left: true; room: RoomItem; ended: false }
  | { left: true; room: RoomItem; ended: true };

/**
 * Frees `userId`'s seat if `connectionId` holds it (a later session of theirs,
 * in another tab, keeps its own); the last one out ends the call (deletes
 * the row). `room` is the call after the change, or as it was when it ended.
 */
export async function leaveRoom(
  channelId: string,
  userId: string,
  connectionId: string,
): Promise<LeaveResult> {
  let room: RoomItem;
  try {
    const { Attributes } = await ddb.send(
      new UpdateCommand({
        TableName: tables.callRooms,
        Key: { channelId },
        UpdateExpression: "REMOVE #p.#u",
        ConditionExpression: "#p.#u.connectionId = :conn",
        ExpressionAttributeNames: { "#p": "participants", "#u": userId },
        ExpressionAttributeValues: { ":conn": connectionId },
        ReturnValues: "ALL_NEW",
      }),
    );
    room = Attributes as RoomItem;
  } catch (err) {
    if (isCondition(err)) return { left: false };
    throw err;
  }
  if (Object.keys(room.participants ?? {}).length > 0) return { left: true, room, ended: false };
  try {
    await ddb.send(
      new DeleteCommand({
        TableName: tables.callRooms,
        Key: { channelId },
        // Nobody joined in between.
        ConditionExpression: "roomId = :room AND size(#p) = :zero",
        ExpressionAttributeNames: { "#p": "participants" },
        ExpressionAttributeValues: { ":room": room.roomId, ":zero": 0 },
      }),
    );
    return { left: true, room, ended: true };
  } catch (err) {
    if (isCondition(err)) return { left: true, room, ended: false };
    throw err;
  }
}

/**
 * Phase 59: the call's shareable link secret, made on the first ask and the
 * same after (for everyone in the call); `null` when that call is over. Also
 * makes the lobby's maps, so knocks and admissions can set entries in them.
 */
export async function ensureLink(channelId: string, roomId: string): Promise<string | null> {
  try {
    const { Attributes } = await ddb.send(
      new UpdateCommand({
        TableName: tables.callRooms,
        Key: { channelId },
        UpdateExpression:
          "SET linkToken = if_not_exists(linkToken, :t), knocks = if_not_exists(knocks, :e), " +
          "admitted = if_not_exists(admitted, :e)",
        ConditionExpression: "roomId = :room",
        ExpressionAttributeValues: { ":t": newLinkSecret(), ":e": {}, ":room": roomId },
        ReturnValues: "ALL_NEW",
      }),
    );
    return (Attributes as RoomItem).linkToken ?? null;
  } catch (err) {
    if (isCondition(err)) return null;
    throw err;
  }
}

/** 24 random bytes, base64url: the part of a call link nobody can guess. */
function newLinkSecret(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * Phase 59: an external knocks (or knocks again, from a new connection): they
 * wait in the lobby. The room after, or `null` when the call is over.
 */
export async function knock(
  room: RoomItem,
  userId: string,
  entry: Knock,
): Promise<RoomItem | null> {
  try {
    const { Attributes } = await ddb.send(
      new UpdateCommand({
        TableName: tables.callRooms,
        Key: { channelId: room.channelId },
        UpdateExpression: "SET knocks.#u = :k",
        ConditionExpression: "roomId = :room AND attribute_exists(linkToken)",
        ExpressionAttributeNames: { "#u": userId },
        ExpressionAttributeValues: { ":k": entry, ":room": room.roomId },
        ReturnValues: "ALL_NEW",
      }),
    );
    return Attributes as RoomItem;
  } catch (err) {
    if (isCondition(err)) return null;
    throw err;
  }
}

/**
 * Phase 59: someone in the call lets an external in (they may `join`) or turns
 * them away; either way they leave the lobby. The knock (with the connection
 * to tell) and the room after, or `null` if they weren't waiting anymore.
 */
export async function answerKnock(
  room: RoomItem,
  userId: string,
  admit: boolean,
): Promise<{ knock: Knock; room: RoomItem } | null> {
  const entry = room.knocks?.[userId];
  if (!entry) return null;
  try {
    const { Attributes } = await ddb.send(
      new UpdateCommand({
        TableName: tables.callRooms,
        Key: { channelId: room.channelId },
        UpdateExpression: admit ? "SET admitted.#u = :k REMOVE knocks.#u" : "REMOVE knocks.#u",
        // Still that same knock (not a later one from another connection).
        ConditionExpression: "roomId = :room AND knocks.#u.connectionId = :conn",
        ExpressionAttributeNames: { "#u": userId },
        ExpressionAttributeValues: {
          ":room": room.roomId,
          ":conn": entry.connectionId,
          ...(admit && { ":k": entry }),
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    return { knock: entry, room: Attributes as RoomItem };
  } catch (err) {
    if (isCondition(err)) return null;
    throw err;
  }
}

/** Phase 59: an external's connection closed while they waited: out of the lobby. */
export async function withdrawKnock(
  channelId: string,
  userId: string,
  connectionId: string,
): Promise<RoomItem | null> {
  try {
    const { Attributes } = await ddb.send(
      new UpdateCommand({
        TableName: tables.callRooms,
        Key: { channelId },
        UpdateExpression: "REMOVE knocks.#u",
        ConditionExpression: "knocks.#u.connectionId = :conn",
        ExpressionAttributeNames: { "#u": userId },
        ExpressionAttributeValues: { ":conn": connectionId },
        ReturnValues: "ALL_NEW",
      }),
    );
    return Attributes as RoomItem;
  } catch (err) {
    if (isCondition(err)) return null;
    throw err;
  }
}

/**
 * Remembers on the connection row which channel's call it sits in, so
 * `$disconnect` can free the seat (`null` clears it). Best effort.
 */
export async function markConnectionRoom(
  connectionId: string,
  channelId: string | null,
): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tables.connections,
        Key: { connectionId },
        UpdateExpression: channelId ? "SET callRoom = :c" : "REMOVE callRoom",
        ConditionExpression: "attribute_exists(connectionId)",
        ...(channelId && { ExpressionAttributeValues: { ":c": channelId } }),
      }),
    );
  } catch (err) {
    if (isCondition(err)) return;
    log.warn("couldn't mark the connection's call", { connectionId, ...errorFields(err) });
  }
}

/**
 * Everyone in the channel (the joiner included) sees the room as it is now,
 * and so do the externals of this channel's call link (Phase 59): those in the
 * call, and those waiting in its lobby.
 */
export async function announceRoom(
  channel: Channel,
  event: CallRoomEvent,
  connections?: LiveConnection[],
): Promise<void> {
  try {
    const live = connections ?? (await listConnections());
    const inAudience = channelAudience(channel);
    const linkedHere = (c: LiveConnection) =>
      c.external === true && c.callScope === channel.channelId;
    await deliver(live, (c) => (inAudience(c) || linkedHere(c) ? event : null));
  } catch (err) {
    log.error("call room broadcast failed", { channelId: channel.channelId, ...errorFields(err) });
  }
}

/**
 * Frees a seat and tells the channel (`left`, or `ended` when it was the
 * last one). Shared with `$disconnect`, which frees the seat of a socket
 * that closed.
 */
export async function vacate(
  channel: Channel,
  userId: string,
  connectionId: string,
): Promise<void> {
  let result = await leaveRoom(channel.channelId, userId, connectionId);
  if (!result.left) return;
  // Phase 59: the team is gone and only externals are left: the call ends for them too.
  if (!result.ended && Object.keys(result.room.participants ?? {}).every(isExternalId)) {
    if (await endRoom(channel.channelId, result.room.roomId)) {
      log.info("channel call ended: only externals were left", {
        channelId: channel.channelId,
        roomId: result.room.roomId,
      });
      result = { left: true, room: result.room, ended: true };
    }
  }
  log.info(result.ended ? "channel call ended" : "channel call left", {
    channelId: channel.channelId,
    roomId: result.room.roomId,
    userId,
  });
  await announceRoom(channel, {
    type: "call.room",
    channelId: channel.channelId,
    room: result.ended ? null : toRoom(result.room),
    change: result.ended ? "ended" : "left",
    userId,
    ...(result.ended && { startedAt: result.room.startedAt }),
  });
}

/** Phase 59: deletes the call's row, if it's still that call. Whether it did. */
async function endRoom(channelId: string, roomId: string): Promise<boolean> {
  try {
    await ddb.send(
      new DeleteCommand({
        TableName: tables.callRooms,
        Key: { channelId },
        ConditionExpression: "roomId = :room",
        ExpressionAttributeValues: { ":room": roomId },
      }),
    );
    return true;
  } catch (err) {
    if (isCondition(err)) return false;
    throw err;
  }
}

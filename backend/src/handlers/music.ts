import { DeleteCommand, GetCommand, paginateScan, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  canUseMusic,
  controlsMusic,
  CreateMusicRoomSchema,
  MAX_MUSIC_QUEUE,
  MAX_MUSIC_ROOMS,
  MUSIC_LISTENER_TTL_MS,
  MusicControlSchema,
  musicPositionMs,
  youTubeIdOf,
  type MusicResponse,
  type MusicRoom,
  type MusicRoomResponse,
  type MusicTrack,
} from "@mindfultech/shared";
import { ulid } from "ulid";
import { deliver, listConnections } from "../lib/broadcast";
import { ddb, tables } from "../lib/ddb";
import {
  forbidden,
  HttpError,
  httpHandler,
  json,
  notFound,
  parseBody,
  pathParam,
  type HttpCaller,
  type HttpEvent,
  type HttpResult,
} from "../lib/http";
import { errorFields, log } from "../lib/logger";
import { displayNameOf } from "../lib/users";

// ---------------------------------------------------------------------------
// Música (Phase 78): the rooms' API. The server keeps, per room, the queue,
// which track is on and its clock (`positionMs` at `at`), and who is
// listening; it never touches the audio. Every change is sent to the team's
// connections (`music.updated`), so each listener's player follows.
// ---------------------------------------------------------------------------

/** A room as stored: its listeners with when each was last heard from. */
interface StoredRoom extends Omit<MusicRoom, "listeners"> {
  listeners: Record<string, { name: string; seenAt: number }>;
}

const toRoom = (stored: StoredRoom, now: number): MusicRoom => ({
  ...stored,
  listeners: Object.entries(stored.listeners ?? {})
    .filter(([, l]) => l.seenAt > now - MUSIC_LISTENER_TTL_MS)
    .map(([userId, l]) => ({ userId, name: l.name }))
    .sort((a, b) => a.name.localeCompare(b.name)),
});

async function allRooms(): Promise<StoredRoom[]> {
  const rooms: StoredRoom[] = [];
  for await (const page of paginateScan({ client: ddb }, { TableName: tables.music })) {
    rooms.push(...((page.Items ?? []) as StoredRoom[]));
  }
  return rooms.sort((a, b) => a.createdAt - b.createdAt);
}

async function roomOf(event: HttpEvent): Promise<StoredRoom> {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: tables.music, Key: { roomId: pathParam(event, "id") } }),
  );
  if (!Item) throw notFound("Esa sala ya no existe");
  return Item as StoredRoom;
}

const save = (room: StoredRoom) =>
  ddb.send(new PutCommand({ TableName: tables.music, Item: room }));

/** Tells the team (never an external: `music.updated` isn't theirs to receive). */
async function announce(change: { room?: MusicRoom; removed?: string }, now: number) {
  try {
    await deliver(await listConnections(), (c) =>
      c.role === "guest" ? null : { type: "music.updated", ...change, serverNow: now },
    );
  } catch (err) {
    log.error("music broadcast failed", errorFields(err));
  }
}

async function answer(stored: StoredRoom, now: number, status = 200): Promise<HttpResult> {
  await save(stored);
  const room = toRoom(stored, now);
  await announce({ room }, now);
  const body: MusicRoomResponse = { room, serverNow: now };
  return json(status, body);
}

/** The title YouTube gives a video (its public oEmbed), or a plain one when it can't be read. */
let fetchTitle = async (videoId: string): Promise<string> => {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`,
      { signal: AbortSignal.timeout(3_000) },
    );
    if (!res.ok) return "";
    const data = (await res.json()) as { title?: unknown };
    return typeof data.title === "string" ? data.title.slice(0, 200) : "";
  } catch {
    return "";
  }
};
/** Tests: a fake title lookup. */
export function useMusicTitles(fake: typeof fetchTitle): void {
  fetchTitle = fake;
}

/** Starts `trackId` from its beginning, playing. */
const startTrack = (room: StoredRoom, trackId: string | null, now: number) => {
  room.trackId = trackId;
  room.positionMs = 0;
  room.at = now;
  room.playing = trackId !== null;
};

/** The track after the current one (round the queue), or `null` with none. */
const nextTrackId = (room: StoredRoom): string | null => {
  if (room.queue.length === 0) return null;
  const i = room.queue.findIndex((t) => t.id === room.trackId);
  return room.queue[(i + 1) % room.queue.length]!.id;
};

async function list(_event: HttpEvent): Promise<HttpResult> {
  const now = Date.now();
  const body: MusicResponse = {
    rooms: (await allRooms()).map((r) => toRoom(r, now)),
    serverNow: now,
  };
  return json(200, body);
}

async function create(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const { name } = parseBody(CreateMusicRoomSchema, event);
  if ((await allRooms()).length >= MAX_MUSIC_ROOMS) {
    throw new HttpError(400, "Hay demasiadas salas: elimina una primero");
  }
  const now = Date.now();
  const djName = await displayNameOf(caller);
  const room: StoredRoom = {
    roomId: `mr_${ulid(now).toLowerCase()}`,
    name,
    djId: caller.userId,
    djName,
    createdAt: now,
    queue: [],
    trackId: null,
    playing: false,
    positionMs: 0,
    at: now,
    // Whoever opens a room is in it.
    listeners: { [caller.userId]: { name: djName, seenAt: now } },
  };
  log.info("music room created", { roomId: room.roomId, userId: caller.userId });
  return answer(room, now, 201);
}

async function remove(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const room = await roomOf(event);
  if (!controlsMusic(room, caller.userId, caller.role)) {
    throw forbidden("Solo el DJ de la sala o un admin la elimina");
  }
  await ddb.send(new DeleteCommand({ TableName: tables.music, Key: { roomId: room.roomId } }));
  const now = Date.now();
  await announce({ removed: room.roomId }, now);
  log.info("music room deleted", { roomId: room.roomId, userId: caller.userId });
  return json(200, { removed: room.roomId });
}

/** `POST /music/{id}/join`: in the room (also the listener's "still here", every minute). */
async function join(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const room = await roomOf(event);
  const now = Date.now();
  const known = room.listeners?.[caller.userId];
  const fresh = !!known && known.seenAt > now - MUSIC_LISTENER_TTL_MS;
  room.listeners = {
    ...room.listeners,
    [caller.userId]: { name: known?.name ?? (await displayNameOf(caller)), seenAt: now },
  };
  if (fresh) {
    // A heartbeat changes nothing anyone sees: saved, not announced.
    await save(room);
    const body: MusicRoomResponse = { room: toRoom(room, now), serverNow: now };
    return json(200, body);
  }
  return answer(room, now);
}

async function leave(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const room = await roomOf(event);
  const listeners = { ...room.listeners };
  delete listeners[caller.userId];
  room.listeners = listeners;
  return answer(room, Date.now());
}

async function control(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const room = await roomOf(event);
  const input = parseBody(MusicControlSchema, event);
  const now = Date.now();
  const listening = (userId: string) =>
    (room.listeners?.[userId]?.seenAt ?? 0) > now - MUSIC_LISTENER_TTL_MS;

  if (input.action === "ended") {
    // Any listener's player may say the track is over; only the first one moves the room on.
    if (!listening(caller.userId)) throw forbidden("Únete a la sala primero");
    if (room.trackId !== input.trackId) {
      const body: MusicRoomResponse = { room: toRoom(room, now), serverNow: now };
      return json(200, body);
    }
    startTrack(room, nextTrackId(room), now);
    return answer(room, now);
  }
  if (input.action === "claim") {
    if (!listening(caller.userId)) throw forbidden("Únete a la sala primero");
    if (room.djId !== caller.userId && listening(room.djId) && caller.role !== "admin") {
      throw forbidden("El DJ sigue en la sala");
    }
    room.djId = caller.userId;
    room.djName = room.listeners[caller.userId]!.name;
    return answer(room, now);
  }
  if (!controlsMusic(room, caller.userId, caller.role)) {
    throw forbidden("Solo el DJ controla la música de esta sala");
  }
  switch (input.action) {
    case "play":
      if (room.trackId === null) startTrack(room, room.queue[0]?.id ?? null, now);
      else if (!room.playing) {
        room.playing = true;
        room.at = now;
      }
      break;
    case "pause":
      room.positionMs = musicPositionMs(room, now);
      room.at = now;
      room.playing = false;
      break;
    case "seek":
      room.positionMs = input.positionMs;
      room.at = now;
      break;
    case "next":
      startTrack(room, nextTrackId(room), now);
      break;
    case "select":
      if (!room.queue.some((t) => t.id === input.trackId)) throw notFound("Esa canción no está");
      startTrack(room, input.trackId, now);
      break;
    case "add": {
      const videoId = youTubeIdOf(input.url);
      if (!videoId) throw new HttpError(400, "Pega un enlace de YouTube");
      if (room.queue.length >= MAX_MUSIC_QUEUE) throw new HttpError(400, "La lista está llena");
      const track: MusicTrack = {
        id: ulid(now).toLowerCase(),
        videoId,
        title: (await fetchTitle(videoId)) || `YouTube · ${videoId}`,
        addedBy: caller.userId,
        addedByName: room.listeners?.[caller.userId]?.name ?? (await displayNameOf(caller)),
      };
      room.queue = [...room.queue, track];
      // The first song starts by itself.
      if (room.trackId === null) startTrack(room, track.id, now);
      break;
    }
    case "remove": {
      const wasOn = room.trackId === input.trackId;
      const following = wasOn && room.queue.length > 1 ? nextTrackId(room) : null;
      room.queue = room.queue.filter((t) => t.id !== input.trackId);
      if (wasOn) startTrack(room, following, now);
      break;
    }
  }
  return answer(room, now);
}

const ROUTES: Record<string, (event: HttpEvent, caller: HttpCaller) => Promise<HttpResult>> = {
  "GET /music": list,
  "POST /music": create,
  "DELETE /music/{id}": remove,
  "POST /music/{id}/join": join,
  "POST /music/{id}/leave": leave,
  "POST /music/{id}/control": control,
};

export const handler = httpHandler(async (event, caller) => {
  if (!canUseMusic(caller.role)) throw forbidden("La música es para el equipo de MindfulTech");
  const route = ROUTES[event.routeKey];
  if (!route) throw notFound(`No route for ${event.routeKey}`);
  return route(event, caller);
});

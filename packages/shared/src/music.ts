import { z } from "zod";
import type { Role } from "./roles";

// ---------------------------------------------------------------------------
// Música (Phase 78): rooms where the team listens to the same thing at the
// same time. Someone opens a room and is its DJ: they queue YouTube links and
// control what plays; anyone on the team joins or leaves. Nothing is
// streamed by the server: it keeps what is playing and since when
// (`positionMs` at server time `at`), every listener's own player follows
// that clock, and a change reaches everyone over the WebSocket.
// ---------------------------------------------------------------------------

export const MAX_MUSIC_ROOMS = 20;
export const MAX_MUSIC_QUEUE = 100;
export const MAX_MUSIC_ROOM_NAME = 60;
/** A listener who hasn't been heard from for this long has left (closed tab, lost connection). */
export const MUSIC_LISTENER_TTL_MS = 150_000;
/** How often a listener says it's still there. */
export const MUSIC_HEARTBEAT_MS = 60_000;
/** A player further than this from the room's clock jumps to it. */
export const MUSIC_DRIFT_SECONDS = 2;

export interface MusicTrack {
  id: string;
  /** YouTube's 11-character video id. */
  videoId: string;
  title: string;
  addedBy: string;
  addedByName: string;
}

export interface MusicRoom {
  roomId: string;
  name: string;
  /** Who controls it. */
  djId: string;
  djName: string;
  createdAt: number;
  queue: MusicTrack[];
  /** The track of `queue` that is on, or `null` with an empty queue. */
  trackId: string | null;
  playing: boolean;
  /** Where the track was, in ms, at server time `at`. */
  positionMs: number;
  at: number;
  listeners: Array<{ userId: string; name: string }>;
}

/** Where the room's track is at `serverNow`, in ms. */
export function musicPositionMs(
  room: Pick<MusicRoom, "playing" | "positionMs" | "at">,
  serverNow: number,
): number {
  return room.playing ? Math.max(0, room.positionMs + (serverNow - room.at)) : room.positionMs;
}

export const currentTrack = (room: Pick<MusicRoom, "queue" | "trackId">): MusicTrack | null =>
  room.queue.find((t) => t.id === room.trackId) ?? null;

/** Música is for the team: never an external. */
export const canUseMusic = (role: Role | undefined) => role === "member" || role === "admin";
/** The DJ controls the room; an admin can always step in. */
export const controlsMusic = (
  room: Pick<MusicRoom, "djId">,
  userId: string,
  role: Role | undefined,
) => canUseMusic(role) && (room.djId === userId || role === "admin");

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
/** The video a YouTube link points at (watch, youtu.be, shorts, embed, live, Music), or `null`. */
export function youTubeIdOf(link: string): string | null {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  let id: string | null = null;
  if (host === "youtu.be") id = url.pathname.split("/")[1] ?? null;
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    id =
      url.pathname === "/watch"
        ? url.searchParams.get("v")
        : (/^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(url.pathname)?.[1] ?? null);
  }
  return id && VIDEO_ID.test(id) ? id : null;
}

/** The reactions a listener can send while a song plays. */
export const MUSIC_REACTIONS = ["🔥", "❤️", "🙌", "💃", "🤘", "😂", "😴", "👎"] as const;
export type MusicReactionEmoji = (typeof MUSIC_REACTIONS)[number];

export interface MusicReaction {
  roomId: string;
  userId: string;
  name: string;
  emoji: MusicReactionEmoji;
}

/** `POST /music`. */
export const CreateMusicRoomSchema = z.object({
  name: z.string().trim().min(1).max(MAX_MUSIC_ROOM_NAME),
});

/** `POST /music/{id}/control`. */
export const MusicControlSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("play") }),
  z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("seek"), positionMs: z.number().min(0).max(86_400_000) }),
  z.object({ action: z.literal("next") }),
  z.object({ action: z.literal("select"), trackId: z.string().min(1).max(64) }),
  z.object({ action: z.literal("add"), url: z.string().trim().min(1).max(500) }),
  z.object({ action: z.literal("remove"), trackId: z.string().min(1).max(64) }),
  /** A listener's player reached the end of `trackId`: on to the next, once. */
  z.object({ action: z.literal("ended"), trackId: z.string().min(1).max(64) }),
  /** Take the room over when its DJ isn't listening. */
  z.object({ action: z.literal("claim") }),
  /** How the song is going down: shown to everyone in the room for a moment, never kept. */
  z.object({ action: z.literal("react"), emoji: z.enum(MUSIC_REACTIONS) }),
]);
export type MusicControl = z.infer<typeof MusicControlSchema>;

/** What the routes answer: the rooms (or the one that changed) and the server's clock. */
export interface MusicResponse {
  rooms: MusicRoom[];
  serverNow: number;
}
export interface MusicRoomResponse {
  room: MusicRoom;
  serverNow: number;
}

/** Sent to the team's connections when a room changes or goes away. */
export interface MusicUpdatedEvent {
  type: "music.updated";
  room?: MusicRoom;
  /** The room that was deleted. */
  removed?: string;
  /** Worth a notification to the team: the room was just opened, or has a new DJ. */
  news?: "created" | "dj";
  /** Someone in a room reacted to what's playing. */
  reaction?: MusicReaction;
  serverNow: number;
}

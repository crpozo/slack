import type {
  MusicControl,
  MusicReaction,
  MusicRoom,
  MusicUpdatedEvent,
} from "@mindfultech/shared";
import { create } from "zustand";
import { musicApi } from "../lib/musicApi";

// ---------------------------------------------------------------------------
// Música (Phase 78): the rooms as the server last said, which one this person
// is listening to, and how far this device's clock is from the server's (the
// room's clock is in server time, so every listener computes the same
// position whatever their own clock says).
// ---------------------------------------------------------------------------

const VOLUME_KEY = "slack.music.volume";
function storedVolume(): number {
  try {
    const v = Number(localStorage.getItem(VOLUME_KEY));
    return Number.isFinite(v) && v > 0 && v <= 100 ? v : 60;
  } catch {
    return 60;
  }
}

interface MusicStore {
  rooms: MusicRoom[];
  loaded: boolean;
  error: string | null;
  /** The room this person is in. */
  joinedId: string | null;
  /** Server time minus this device's, in ms. */
  offset: number;
  volume: number;
  busy: boolean;
  /** Reactions flying over the player right now (each for a few seconds). */
  reactions: Array<MusicReaction & { id: number }>;
  /** Who just came into or left this person's room, to say so once. */
  notice: { id: number; text: string } | null;
  dropReaction: (id: number) => void;
  load: () => Promise<void>;
  create: (name: string) => Promise<void>;
  remove: (roomId: string) => Promise<void>;
  join: (roomId: string) => Promise<void>;
  leave: () => Promise<void>;
  /** "Still here", every minute while listening. */
  heartbeat: () => Promise<void>;
  control: (roomId: string, input: MusicControl) => Promise<void>;
  setVolume: (volume: number) => void;
  /** The server says a room changed or went away. */
  apply: (event: MusicUpdatedEvent) => void;
  reset: () => void;
}

let counter = 0;
const message = (err: unknown) => (err instanceof Error ? err.message : "No se pudo completar.");
const upsert = (rooms: MusicRoom[], room: MusicRoom) =>
  rooms.some((r) => r.roomId === room.roomId)
    ? rooms.map((r) => (r.roomId === room.roomId ? room : r))
    : [...rooms, room];

export const useMusic = create<MusicStore>((set, get) => {
  const took = (res: { room: MusicRoom; serverNow: number }) =>
    set((s) => ({
      rooms: upsert(s.rooms, res.room),
      offset: res.serverNow - Date.now(),
      error: null,
    }));
  return {
    rooms: [],
    loaded: false,
    error: null,
    joinedId: null,
    offset: 0,
    volume: storedVolume(),
    busy: false,
    reactions: [],
    notice: null,
    dropReaction: (id) => set((s) => ({ reactions: s.reactions.filter((r) => r.id !== id) })),
    load: async () => {
      try {
        const res = await musicApi.rooms();
        set((s) => ({
          rooms: res.rooms,
          loaded: true,
          error: null,
          offset: res.serverNow - Date.now(),
          // The room this person was in may be gone.
          joinedId: res.rooms.some((r) => r.roomId === s.joinedId) ? s.joinedId : null,
        }));
      } catch (err) {
        set({ error: message(err), loaded: true });
      }
    },
    create: async (name) => {
      set({ busy: true });
      try {
        const current = get().joinedId;
        if (current) await musicApi.leave(current).catch(() => {});
        const res = await musicApi.create(name);
        took(res);
        set({ joinedId: res.room.roomId });
      } finally {
        set({ busy: false });
      }
    },
    remove: async (roomId) => {
      await musicApi.remove(roomId);
      set((s) => ({
        rooms: s.rooms.filter((r) => r.roomId !== roomId),
        joinedId: s.joinedId === roomId ? null : s.joinedId,
      }));
    },
    join: async (roomId) => {
      set({ busy: true });
      try {
        const current = get().joinedId;
        if (current && current !== roomId) await musicApi.leave(current).then(took, () => {});
        took(await musicApi.join(roomId));
        set({ joinedId: roomId });
      } finally {
        set({ busy: false });
      }
    },
    leave: async () => {
      const roomId = get().joinedId;
      if (!roomId) return;
      set({ joinedId: null });
      await musicApi.leave(roomId).then(took, () => {});
    },
    heartbeat: async () => {
      const roomId = get().joinedId;
      if (!roomId) return;
      try {
        took(await musicApi.join(roomId));
      } catch {
        // The room is gone, or the network is: the next list says which.
        void get().load();
      }
    },
    control: async (roomId, input) => {
      took(await musicApi.control(roomId, input));
    },
    setVolume: (volume) => {
      try {
        localStorage.setItem(VOLUME_KEY, String(volume));
      } catch {
        // A nicety.
      }
      set({ volume });
    },
    apply: (event) =>
      set((s) => {
        if (event.reaction) {
          // Only the room this person is in, and never a pile-up.
          if (event.reaction.roomId !== s.joinedId) return {};
          return {
            reactions: [...s.reactions.slice(-11), { ...event.reaction, id: ++counter }],
          };
        }
        // Who came in or left the room this person is listening in.
        let notice = s.notice;
        if (event.room && event.room.roomId === s.joinedId) {
          const before = s.rooms.find((r) => r.roomId === s.joinedId)?.listeners ?? [];
          const was = new Set(before.map((l) => l.userId));
          const is = new Set(event.room.listeners.map((l) => l.userId));
          const came = event.room.listeners.filter((l) => !was.has(l.userId)).map((l) => l.name);
          const went = before.filter((l) => !is.has(l.userId)).map((l) => l.name);
          const text = [
            came.length && `${came.join(", ")} ${came.length === 1 ? "se unió" : "se unieron"}`,
            went.length && `${went.join(", ")} ${went.length === 1 ? "salió" : "salieron"}`,
          ]
            .filter(Boolean)
            .join(" · ");
          if (text) notice = { id: ++counter, text };
        }
        return {
          notice,
          offset: event.serverNow - Date.now(),
          rooms: event.removed
            ? s.rooms.filter((r) => r.roomId !== event.removed)
            : event.room
              ? upsert(s.rooms, event.room)
              : s.rooms,
          joinedId: event.removed && s.joinedId === event.removed ? null : s.joinedId,
        };
      }),
    reset: () =>
      set({
        rooms: [],
        loaded: false,
        error: null,
        joinedId: null,
        busy: false,
        reactions: [],
        notice: null,
      }),
  };
});

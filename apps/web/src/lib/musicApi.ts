import type { MusicControl, MusicResponse, MusicRoomResponse } from "@mindfultech/shared";
import { request } from "./tasksApi";

/** Música (Phase 78): the listening rooms. */
export const musicApi = {
  rooms: () => request<MusicResponse>("GET", "/music"),
  create: (name: string) => request<MusicRoomResponse>("POST", "/music", { name }),
  remove: (roomId: string) =>
    request<{ removed: string }>("DELETE", `/music/${encodeURIComponent(roomId)}`),
  join: (roomId: string) =>
    request<MusicRoomResponse>("POST", `/music/${encodeURIComponent(roomId)}/join`),
  leave: (roomId: string) =>
    request<MusicRoomResponse>("POST", `/music/${encodeURIComponent(roomId)}/leave`),
  control: (roomId: string, input: MusicControl) =>
    request<MusicRoomResponse>("POST", `/music/${encodeURIComponent(roomId)}/control`, input),
};

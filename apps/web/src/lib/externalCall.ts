import {
  CALL_TOKEN_PREFIX,
  cleanExternalName,
  type CallEvent,
  type CallMedia,
} from "@mindfultech/shared";
import { create } from "zustand";
import { groupCalls, useGroupCall } from "./groupCall";
import { WsClient } from "./ws";

// ---------------------------------------------------------------------------
// Phase 59: joining a call from its shareable link, with no account. The page
// (`/call/<roomId>?token=…`) never starts the chat: its socket is authorized
// for that one call only (the server refuses every other route and sends
// nothing else), so the person sees the call's video and screen share and
// nothing of MindfulTech. They give a name, wait in the lobby until someone
// in the call lets them in, then join like anyone else (a `GroupCallManager`).
// ---------------------------------------------------------------------------

export const CALL_PATH_PREFIX = "/call/";

/** The call a link opens, or `null` when this URL isn't one. */
export function parseCallLink(url: { pathname: string; search: string }): {
  roomId: string;
  token: string;
} | null {
  if (!url.pathname.startsWith(CALL_PATH_PREFIX)) return null;
  const roomId = decodeURIComponent(url.pathname.slice(CALL_PATH_PREFIX.length)).replace(/\/$/, "");
  const token = new URLSearchParams(url.search).get("token") ?? "";
  if (!/^[\w-]{1,64}$/.test(roomId) || !token) return null;
  return { roomId, token };
}

export type ExternalCallStatus =
  /** Typing a name. */
  | "name"
  /** Opening the socket. */
  | "connecting"
  /** In the lobby. */
  | "waiting"
  /** In the call (or joining it). */
  | "in-call"
  /** Someone in the call said no. */
  | "denied"
  /** The call ended, the link no longer works, or they left. */
  | "ended"
  | "left";

export const useExternalCall = create<{
  status: ExternalCallStatus;
  name: string;
  /** A message under the status (a full call, a failure). */
  note: string | null;
}>(() => ({ status: "name", name: "", note: null }));

/** Without an answer this long, the link is taken as no longer working (the server refused it). */
export const CONNECT_TIMEOUT_MS = 12_000;

/** This tab's id for the call: rejoining after a dropped socket keeps being let in. */
function tabId(): string {
  const key = "mindfultech.callTab";
  try {
    const kept = sessionStorage.getItem(key);
    if (kept && /^[\w-]{16,64}$/.test(kept)) return kept;
    const fresh = [...crypto.getRandomValues(new Uint8Array(16))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    sessionStorage.setItem(key, fresh);
    return fresh;
  } catch {
    return "";
  }
}

let client: WsClient | null = null;
let stopWatching: (() => void) | null = null;

/** Opens the call's socket as `name` and knocks; joins with `media` once let in. */
export function startExternalCall(input: {
  wsUrl: string;
  roomId: string;
  token: string;
  name: string;
  media: CallMedia;
  WebSocketImpl?: typeof WebSocket;
}): void {
  const name = cleanExternalName(input.name);
  if (!name) {
    useExternalCall.setState({ note: "Type your name to join." });
    return;
  }
  stopExternalCall();
  useExternalCall.setState({ status: "connecting", name, note: null });
  let myId: string | null = null;
  let channelId: string | null = null;
  const ws = new WsClient({
    url: input.wsUrl,
    getToken: async () => `${CALL_TOKEN_PREFIX}${input.token}`,
    params: { room: input.roomId, name, cid: tabId() },
    ...(input.WebSocketImpl && { WebSocketImpl: input.WebSocketImpl }),
  });
  client = ws;

  const noAnswer = setTimeout(() => {
    if (useExternalCall.getState().status === "connecting") {
      stopExternalCall();
      useExternalCall.setState({
        status: "ended",
        note: "This link doesn't work anymore: the call may have ended.",
      });
    }
  }, CONNECT_TIMEOUT_MS);

  groupCalls.attach({
    send: (payload, key) => ws.send("call", payload, key),
    myUserId: () => myId,
    nameOf: (userId) =>
      (channelId &&
        useGroupCall.getState().rooms[channelId]?.participants.find((p) => p.userId === userId)
          ?.name) ||
      "Someone",
    notify: (text) => useExternalCall.setState({ note: text }),
    postMessage: () => {}, // they have no chat
    dmCallActive: () => false,
    listsRooms: false,
  });

  const offs = [
    ws.onOpen(({ reconnected }) => {
      clearTimeout(noAnswer);
      // Every (re)connection knocks: once let in, the answer is `admitted` at once.
      ws.send("call", { signal: "knock" });
      if (reconnected && groupCalls.busy) groupCalls.signalingReconnected();
    }),
    ws.on("call.lobby", (event) => {
      myId = event.userId;
      channelId = event.channelId;
      switch (event.status) {
        case "waiting":
          useExternalCall.setState({ status: "waiting", note: null });
          break;
        case "admitted":
          if (!groupCalls.busy) {
            useExternalCall.setState({ status: "in-call", note: null });
            void groupCalls.join(event.channelId, input.media);
          }
          break;
        case "denied":
          stopExternalCall();
          useExternalCall.setState({ status: "denied" });
          break;
        case "ended":
          stopExternalCall();
          useExternalCall.setState({ status: "ended", note: null });
          break;
      }
    }),
    ws.on("call.room", (event) => groupCalls.onRoom(event)),
    ...(["call.offer", "call.answer", "call.ice_candidate", "call.renegotiate"] as const).map(
      (type) => ws.on(type, (event) => groupCalls.handle(event as CallEvent)),
    ),
    ws.on("error", (event) => {
      if (event.code === "CALL_FULL") {
        useExternalCall.setState({ note: "The call is full right now. Try again in a while." });
      }
    }),
    // The call ended (or we left): the page says so instead of a blank grid.
    useGroupCall.subscribe((state, before) => {
      if (before.call && !state.call && useExternalCall.getState().status === "in-call") {
        stopExternalCall();
        useExternalCall.setState({ status: "ended" });
      }
    }),
    () => clearTimeout(noAnswer),
  ];
  stopWatching = () => offs.forEach((off) => off());
  ws.connect();
}

/** Leaves the call and closes the socket. */
export function stopExternalCall(): void {
  const watching = stopWatching;
  stopWatching = null;
  watching?.();
  if (groupCalls.busy) groupCalls.leave();
  groupCalls.detach();
  client?.disconnect();
  client = null;
}

/** Leaving on purpose: "You left the call." */
export function leaveExternalCall(): void {
  stopExternalCall();
  useExternalCall.setState({ status: "left", note: null });
}

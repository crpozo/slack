import { dmChannelId, zonedMidnight, type Message } from "@mindfultech/shared";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { ChatLayout } from "../components/ChatLayout";
import { chat } from "../lib/chat";
import { configureTasksApi } from "../lib/tasksApi";
import { useChat, type ChatMessage } from "../store";
import "../styles.css";

const params = new URLSearchParams(location.search);
configureTasksApi("https://api.example.invalid");
const fake = chat as unknown as Record<string, unknown>;
fake.start = () => useChat.getState().setStatus("open");
fake.stop = () => {};
fake.sendReadMark = () => {};
fake.loadHistory = () => {};
fake.typing = () => {};
fake.viewed = (id: string) => {
  (window as unknown as { viewed: string[] }).viewed = [...((window as unknown as { viewed?: string[] }).viewed ?? []), id];
};
fake.loadThread = (_c: string, parent: { sk: string }) => {
  const s = useChat.getState();
  if (parent.sk in s.threadCursors) return;
  s.receiveThreadHistory(parent.sk, [
    msg(50, { sk: `thread#${parent.sk}#1700000000050#R1`, parentId: "m3", parentSk: parent.sk, userId: "ana", userEmail: "ana@x", text: "First reply" }),
    msg(51, { sk: `thread#${parent.sk}#1700000000051#R2`, parentId: "m3", parentSk: parent.sk, text: "Second reply from me" }),
  ], null);
};
fake.sendMessage = (channelId: string, text: string, _a: unknown, _r: unknown, _s: unknown, thread?: { sk: string; messageId: string }) => {
  const m = msg(900 + Math.floor(Math.random() * 100), { channelId, text, ...(thread && { sk: `thread#${thread.sk}#${Date.now()}#X`, parentId: thread.messageId, parentSk: thread.sk }) });
  useChat.getState().receiveMessage(m);
  (window as unknown as { sent: unknown[] }).sent = [...((window as unknown as { sent?: unknown[] }).sent ?? []), { channelId, text, thread }];
};
fake.updateChannel = (channelId: string, fields: Record<string, unknown>) => {
  const s = useChat.getState();
  const c = s.channels.find((x) => x.channelId === channelId)!;
  s.updateChannel({ ...c, ...fields } as never);
};

const CH = "ch_general";
const DM = dmChannelId("me", "ana");
const T0 = zonedMidnight("2026-10-19") + 13 * 3_600_000;
function msg(i: number, patch: Partial<Message> = {}): ChatMessage {
  return {
    messageId: `m${i}`, channelId: CH, sk: `${T0 + i * 60_000}#m${i}`, userId: "me", userEmail: "carlos@x",
    text: `Message ${i}`, attachments: [], createdAt: T0 + i * 60_000, reactions: {}, ...patch,
  } as ChatMessage;
}
useChat.setState({
  me: { userId: "me", email: "carlos@example.com", role: params.get("role") === "admin" ? "admin" : undefined } as never,
  users: {
    me: { userId: "me", email: "carlos@example.com", displayName: "Carlos", updatedAt: 1 },
    ana: { userId: "ana", email: "ana@example.com", displayName: "Ana", updatedAt: 1 },
    luis: { userId: "luis", email: "luis@example.com", displayName: "Luis", updatedAt: 1 },
  },
  channels: [
    { channelId: CH, name: "general", type: "public", createdBy: "s", createdAt: 1, archived: false },
    { channelId: "ch_design", name: "design", type: "public", createdBy: "me", createdAt: 2, archived: false },
    { channelId: "ch_old", name: "old-project", type: "public", createdBy: "me", createdAt: 3, archived: true },
    { channelId: DM, name: DM, type: "dm", createdBy: "me", createdAt: 4, archived: false, members: ["ana", "me"] },
  ],
  channelsLoaded: true,
  unread: { ch_design: 3, [DM]: 1 },
  messagesByChannel: {
    [CH]: [
      msg(1, { userId: "ana", userEmail: "ana@x", text: "Morning everyone" }),
      msg(2, { text: "Morning! Shipping the calendar today." }),
      msg(3, { userId: "ana", userEmail: "ana@x", text: "Can we discuss the thread design here?", replyCount: 2, lastReplyAt: T0 + 51 * 60_000, replyUserIds: ["ana", "me"] }),
      msg(4, { text: "Sure, see the thread." }),
    ],
    ch_old: [msg(10, { channelId: "ch_old", text: "This project is done." })],
  },
  cursors: { [CH]: null, ch_old: null },
  historyRequests: {},
  hydrated: true,
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="*" element={<ChatLayout wsUrl="wss://example.invalid" />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);

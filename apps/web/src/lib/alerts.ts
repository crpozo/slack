import {
  describeEventWhen,
  describeTaskActivity,
  describeTasksFromNotes,
  vacationOwner,
  type BoardEvent,
  type CalendarPushEvent,
} from "@mindfultech/shared";
import { selectName, useChat } from "../store";
import { useNotifications, type AppAlert } from "../store/notifications";
import { useTasks } from "../store/tasks";
import { isAppActive } from "./activity";
import { notifyDesktop } from "./desktop";
import { playMessageSound } from "./sounds";

export type AlertInput = Omit<AppAlert, "id" | "at" | "read">;

const currentPath = () => (typeof location === "undefined" ? "" : location.pathname);

/**
 * Something happened that the person should hear about (a DM, an @mention,
 * board activity). It always lands in the bell; unless they're looking
 * at that very screen, it also plays the message sound (`sound: false` when
 * the caller already played it) and, with the desktop app in the background,
 * shows a native notification.
 */
export function raiseAlert(alert: AlertInput, { sound = true }: { sound?: boolean } = {}): void {
  const active = isAppActive();
  const onScreen = active && currentPath() === alert.url;
  useNotifications.getState().add(alert, onScreen);
  if (onScreen) return;
  if (sound) playMessageSound();
  if (!active) void notifyDesktop(alert.title, alert.body);
}

/**
 * The bell entry for a board event: a task someone else created, or moved to
 * another column. Other board changes only refresh the board.
 */
export function boardActivity(event: BoardEvent, myUserId: string): AlertInput | null {
  if (event.type !== "board.task_created" && event.type !== "board.task_updated") return null;
  if (!event.by || event.by === myUserId) return null;
  const previousStatus = event.type === "board.task_updated" ? event.previousStatus : undefined;
  if (event.type === "board.task_updated" && !previousStatus) return null;
  const s = useChat.getState();
  const boardName =
    event.boardName ??
    useTasks.getState().boards.find((b) => b.boardId === event.boardId)?.name ??
    "Board";
  const url = `/app/tasks/${encodeURIComponent(event.boardId)}`;
  // Tasks added together from AI call notes: one entry for the batch, on its first task.
  const batch = event.type === "board.task_created" ? event.batch : undefined;
  if (batch) {
    if (batch.index !== 0) return null;
    const summary = describeTasksFromNotes({
      actorName: selectName(s, event.by),
      boardName,
      count: batch.size,
    });
    return { kind: "task", ...summary, url };
  }
  const { title, body } = describeTaskActivity({
    actorName: selectName(s, event.by),
    boardName,
    task: event.task,
    previousStatus,
  });
  return { kind: "task", title, body, url };
}

/**
 * The bell entry for a calendar push: someone invited you to a meeting, or
 * an admin decided your vacation request. Other changes only refresh the view.
 */
export function calendarActivity(push: CalendarPushEvent, myUserId: string): AlertInput | null {
  if (push.type === "calendar.event_deleted" || push.by === myUserId) return null;
  const { event } = push;
  const url = "/app/calendar";
  if (push.type === "calendar.event_created" && event.type === "meeting") {
    if (!event.participants.includes(myUserId)) return null;
    const organizer = selectName(useChat.getState(), push.by);
    return {
      kind: "calendar",
      title: `${organizer} invited you to “${event.title}”`,
      body: describeEventWhen(event),
      url,
    };
  }
  if (push.type === "calendar.event_updated" && push.decision && event.type === "vacation") {
    if (vacationOwner(event) !== myUserId) return null;
    const note = event.decisionNote ? ` · ${event.decisionNote}` : "";
    return {
      kind: "calendar",
      title: `Vacation ${push.decision}`,
      body: `${describeEventWhen(event)}${note}`,
      url,
    };
  }
  return null;
}

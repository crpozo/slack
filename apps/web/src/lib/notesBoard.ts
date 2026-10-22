import type { Board, Channel } from "@mindfultech/shared";

/** The board last used for notes, remembered on this device. */
const LAST_BOARD_KEY = "slack.notesBoard";

export function loadLastNotesBoard(): string | null {
  try {
    return localStorage.getItem(LAST_BOARD_KEY);
  } catch {
    return null;
  }
}

export function saveLastNotesBoard(boardId: string): void {
  try {
    localStorage.setItem(LAST_BOARD_KEY, boardId);
  } catch {
    // Private mode: only the preselection is lost.
  }
}

/**
 * Which board "Send to Board" opens on: the board of a project channel both
 * people of the call are in (a public channel counts: both can be there), so
 * work talked over in a DM lands on that project; else the board you used
 * last; else your first board. Only boards you're on are candidates.
 */
export function preferredBoard(
  boards: Board[],
  channels: Channel[],
  participants: string[],
  lastUsed: string | null,
): string | null {
  const mine = new Set(boards.map((b) => b.boardId));
  const shared = channels.find(
    (c) =>
      c.isProject &&
      !c.archived &&
      c.linkedBoardId &&
      mine.has(c.linkedBoardId) &&
      (c.type === "public" || participants.every((id) => c.members?.includes(id))),
  );
  if (shared?.linkedBoardId) return shared.linkedBoardId;
  if (lastUsed && mine.has(lastUsed)) return lastUsed;
  return boards[0]?.boardId ?? null;
}

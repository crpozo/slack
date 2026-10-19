import type { Channel, ProjectBoard } from "@mindfultech/shared";

/** What the Project section of the channel modals holds. */
export interface ProjectChoice {
  isProject: boolean;
  /** `link` needs `boardId`; `create` names the board after the channel. */
  mode: "link" | "create";
  boardId: string;
}

/** The section's initial state for a channel (a project links its current board). */
export function projectChoiceOf(channel?: Pick<Channel, "isProject" | "linkedBoardId">) {
  const linked = channel?.isProject && channel.linkedBoardId ? channel.linkedBoardId : "";
  return { isProject: !!linked, mode: "link", boardId: linked } satisfies ProjectChoice;
}

/** The board request to send for `choice`, or `null` when none is needed. */
export function projectBoardOf(choice: ProjectChoice): ProjectBoard | null {
  if (!choice.isProject) return null;
  if (choice.mode === "create") return { mode: "create" };
  return choice.boardId ? { mode: "link", boardId: choice.boardId } : null;
}

/** Whether the section can be submitted: a project needs a board to link or create. */
export function projectChoiceValid(choice: ProjectChoice): boolean {
  return !choice.isProject || projectBoardOf(choice) !== null;
}

/**
 * The `update` fields for the Project section compared with the channel as it
 * is: nothing when unchanged, `{ isProject: false }` when turned off, and the
 * flag plus the board when it was turned on or points at another board.
 */
export function projectEdit(
  channel: Pick<Channel, "isProject" | "linkedBoardId">,
  choice: ProjectChoice,
): { isProject?: boolean; board?: ProjectBoard } {
  const was = projectChoiceOf(channel);
  if (!choice.isProject) return was.isProject ? { isProject: false } : {};
  const board = projectBoardOf(choice);
  if (!board) return {};
  if (was.isProject && board.mode === "link" && board.boardId === was.boardId) return {};
  return { isProject: true, board };
}

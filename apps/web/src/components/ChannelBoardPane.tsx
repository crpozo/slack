import { canAccessBoard } from "@mindfultech/shared";
import { useEffect } from "react";
import { Link } from "react-router-dom";
import { tasksApiConfigured } from "../lib/tasksApi";
import { useChat } from "../store";
import { useTasks } from "../store/tasks";
import { CloseIcon } from "./icons";
import { BoardView } from "./TaskManager";

/**
 * A project channel's board beside its chat (Phase 24): the Task Manager's
 * own `BoardView` in the right-hand pane, live like on its own page (board
 * pushes update the same store). "Open full view" goes to `/app/tasks`.
 */
export function ChannelBoardPane({
  boardId,
  onClose,
}: Readonly<{ boardId: string; onClose: () => void }>) {
  const myUserId = useChat((s) => s.me?.userId);
  const boardsLoaded = useTasks((s) => s.boardsLoaded);
  const loadBoards = useTasks((s) => s.loadBoards);
  const board = useTasks((s) => s.boards.find((b) => b.boardId === boardId));
  const configured = tasksApiConfigured();

  useEffect(() => {
    if (configured && !boardsLoaded) void loadBoards();
  }, [configured, boardsLoaded, loadBoards]);

  let content;
  if (!configured) {
    content = <Notice title="The Task Manager isn't set up on this deployment." />;
  } else if (!boardsLoaded) {
    content = <Notice title="Loading board…" />;
  } else if (!board || !myUserId || !canAccessBoard(board, myUserId)) {
    content = (
      <Notice
        title="This board isn't shared with you"
        text="Ask the board's owner to share it, or it may have been deleted."
      />
    );
  } else {
    content = <BoardView key={board.boardId} board={board} compact />;
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-surface" aria-label="Project board">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
        <span aria-hidden="true">📊</span>
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">Project board</h2>
        <Link
          to={`/app/tasks/${encodeURIComponent(boardId)}`}
          className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-ink-secondary hover:bg-surface-hover hover:text-ink"
        >
          Open full view
        </Link>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1.5 text-ink-secondary hover:bg-surface-hover hover:text-ink"
          aria-label="Close the board"
        >
          <CloseIcon />
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">{content}</div>
    </section>
  );
}

function Notice({ title, text }: Readonly<{ title: string; text?: string }>) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <p className="font-semibold text-ink">{title}</p>
      {text && <p className="max-w-xs text-sm text-ink-secondary">{text}</p>}
    </div>
  );
}

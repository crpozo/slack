import type { Board, Channel } from "@mindfultech/shared";
import { describe, expect, it } from "vitest";
import { preferredBoard } from "./notesBoard";

const board = (boardId: string): Board => ({
  boardId,
  name: boardId,
  ownerId: "me",
  members: ["me"],
  createdAt: 1,
});
const project = (linkedBoardId: string, patch: Partial<Channel> = {}): Channel => ({
  channelId: `ch_${linkedBoardId}`,
  name: linkedBoardId,
  type: "private",
  createdBy: "me",
  createdAt: 1,
  archived: false,
  isProject: true,
  linkedBoardId,
  members: ["me", "ana"],
  ...patch,
});

describe("preferredBoard", () => {
  const boards = [board("b_first"), board("b_web"), board("b_last")];
  const both = ["me", "ana"];

  it("prefers the board of a project channel both people are in", () => {
    expect(preferredBoard(boards, [project("b_web")], both, "b_last")).toBe("b_web");
    // A public project channel: anyone can be there.
    const open = project("b_web", { type: "public", members: undefined });
    expect(preferredBoard(boards, [open], both, null)).toBe("b_web");
  });

  it("skips projects one of them isn't in, archived ones and boards you're not on", () => {
    const channels = [
      project("b_web", { members: ["me"] }),
      project("b_first", { archived: true }),
      project("b_other"),
    ];
    expect(preferredBoard(boards, channels, both, "b_last")).toBe("b_last");
  });

  it("falls back to the board used last, then your first board, then none", () => {
    expect(preferredBoard(boards, [], both, "b_web")).toBe("b_web");
    expect(preferredBoard(boards, [], both, "b_gone")).toBe("b_first");
    expect(preferredBoard([], [], both, null)).toBeNull();
  });
});

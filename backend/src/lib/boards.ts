import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { canAccessBoard, isBoardId, type Board } from "@mindfultech/shared";
import { ddb, tables } from "./ddb";

export const BOARD_SK = "BOARD";
export const memberSk = (userId: string) => `MEMBER#${userId}`;

/** Row of the `boards` table for the board itself (`members` is a DynamoDB string set). */
export type BoardItem = Omit<Board, "members"> & { sk: string; members?: Set<string> | string[] };

export function toBoard(item: BoardItem): Board {
  return {
    boardId: item.boardId,
    name: item.name,
    ownerId: item.ownerId,
    createdAt: item.createdAt,
    members: [...(item.members ?? [])].sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * Loads a board the caller may use: it must exist and list the caller as its
 * owner or a member. Anything else returns `null`, which handlers report as
 * "not found" so boards stay hidden from non-members.
 */
export async function getAccessibleBoard(boardId: string, userId: string): Promise<Board | null> {
  if (!isBoardId(boardId)) return null;
  const { Item } = await ddb.send(
    new GetCommand({ TableName: tables.boards, Key: { boardId, sk: BOARD_SK } }),
  );
  if (!Item) return null;
  const board = toBoard(Item as BoardItem);
  return canAccessBoard(board, userId) ? board : null;
}

/** Broadcast filter: who may receive events of `board`. */
export function boardAudience(board: Pick<Board, "ownerId" | "members">) {
  return (connection: { userId: string }) => canAccessBoard(board, connection.userId);
}

import { BatchGetCommand, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
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

/**
 * The rows that make a board exist: the board itself and one membership row
 * per member (the `byUser` index lists boards per user from them). Written in
 * one transaction, with the channel row too for project channels.
 */
export function boardRows(
  board: Board,
): Array<{
  Put: { TableName: string; Item: Record<string, unknown>; ConditionExpression?: string };
}> {
  return [
    {
      Put: {
        TableName: tables.boards,
        Item: { ...board, sk: BOARD_SK, members: new Set(board.members) },
        ConditionExpression: "attribute_not_exists(boardId)",
      },
    },
    ...board.members.map((userId) => ({
      Put: {
        TableName: tables.boards,
        Item: { boardId: board.boardId, sk: memberSk(userId), userId, createdAt: board.createdAt },
      },
    })),
  ];
}

/** Broadcast filter: who may receive events of `board`. */
export function boardAudience(board: Pick<Board, "ownerId" | "members">) {
  return (connection: { userId: string }) => canAccessBoard(board, connection.userId);
}

/** Every board `userId` can see (membership rows, then the board rows, which are the authority). */
export async function boardsOf(userId: string): Promise<Board[]> {
  const { Items } = await ddb.send(
    new QueryCommand({
      TableName: tables.boards,
      IndexName: "byUser",
      KeyConditionExpression: "userId = :me",
      ExpressionAttributeValues: { ":me": userId },
      ProjectionExpression: "boardId",
    }),
  );
  const ids = [...new Set((Items ?? []).map((i) => String(i.boardId)))];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
  const pages = await Promise.all(
    chunks.map((chunk) =>
      ddb.send(
        new BatchGetCommand({
          RequestItems: {
            [tables.boards]: { Keys: chunk.map((boardId) => ({ boardId, sk: BOARD_SK })) },
          },
        }),
      ),
    ),
  );
  const boards = pages.flatMap((page) =>
    ((page.Responses?.[tables.boards] ?? []) as BoardItem[]).map(toBoard),
  );
  // Membership rows and the board row agree except mid-change: trust the board row.
  return boards.filter((b) => canAccessBoard(b, userId)).sort((a, b) => a.createdAt - b.createdAt);
}

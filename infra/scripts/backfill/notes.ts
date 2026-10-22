import {
  BatchWriteCommand,
  paginateScan,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import type { MeetingNoteIndexItem } from "@mindfultech/shared";

/** DynamoDB caps BatchWriteItem at 25 requests. */
const BATCH = 25;

export interface BackfillReport {
  /** AI notes cards found in `messages`. */
  cards: number;
  /** Pointers written (or that would be, in a dry run): one per participant. */
  pointers: number;
}

/** The hub pointers of one notes card, as `POST /calls/summary` writes them. */
export function pointersOf(card: Record<string, unknown>): MeetingNoteIndexItem[] {
  const notes = card.aiNotes as
    { callId?: unknown; endedAt?: unknown; participants?: unknown } | undefined;
  const participants = Array.isArray(notes?.participants)
    ? notes.participants.filter((p): p is string => typeof p === "string")
    : notes?.participants instanceof Set
      ? [...(notes.participants as Set<unknown>)].filter((p): p is string => typeof p === "string")
      : [];
  if (typeof card.channelId !== "string" || typeof card.sk !== "string") return [];
  return [...new Set(participants)].map((userId) => ({
    userId,
    sk: card.sk as string,
    channelId: card.channelId as string,
    callId: typeof notes?.callId === "string" ? notes.callId : "",
    endedAt: typeof notes?.endedAt === "number" ? notes.endedAt : 0,
  }));
}

/**
 * Phase 29: writes the AI Notes hub pointers of every notes card posted
 * before the hub existed. One scan of `messages` (only `kind = ai_notes`
 * comes back), then batched puts. Idempotent: a pointer is the same item
 * every time, so running it again rewrites identical rows.
 */
export async function backfillNotes(
  ddb: DynamoDBDocumentClient,
  tables: { messages: string; meetingNotes: string },
  { apply }: { apply: boolean },
): Promise<BackfillReport> {
  const pointers: MeetingNoteIndexItem[] = [];
  let cards = 0;
  for await (const page of paginateScan(
    { client: ddb },
    {
      TableName: tables.messages,
      FilterExpression: "kind = :kind",
      ProjectionExpression: "channelId, sk, aiNotes.callId, aiNotes.endedAt, aiNotes.participants",
      ExpressionAttributeValues: { ":kind": "ai_notes" },
    },
  )) {
    for (const card of page.Items ?? []) {
      cards++;
      pointers.push(...pointersOf(card));
    }
  }
  if (apply) {
    for (let i = 0; i < pointers.length; i += BATCH) {
      let requests: Record<string, unknown>[] = pointers
        .slice(i, i + BATCH)
        .map((Item) => ({ PutRequest: { Item } }));
      for (let attempt = 0; requests.length > 0; attempt++) {
        if (attempt === 5)
          throw new Error(`${requests.length} pointers left unwritten (throttled)`);
        const { UnprocessedItems } = await ddb.send(
          new BatchWriteCommand({ RequestItems: { [tables.meetingNotes]: requests } }),
        );
        requests = (UnprocessedItems?.[tables.meetingNotes] ?? []) as Record<string, unknown>[];
      }
    }
  }
  return { cards, pointers: pointers.length };
}

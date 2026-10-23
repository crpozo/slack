import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  cardRefsOf,
  compareIds,
  dmChannelId,
  dmMembers,
  meetingCardOf,
  meetingCardText,
  newMessageSk,
  type CalendarEvent,
  type Channel,
  type MeetingCard,
  type MeetingCardRef,
  type MeetingEvent,
  type Message,
} from "@mindfultech/shared";
import { ulid } from "ulid";
import { deliver, type LiveConnection } from "./broadcast";
import { toItem } from "./calendar";
import { channelAudience, touchChannel } from "./channels";
import { ddb, tables } from "./ddb";
import { HttpError } from "./http";
import { errorFields, log } from "./logger";

// ---------------------------------------------------------------------------
// Meeting cards (Phase 34): every invitee of a meeting gets a "meeting
// scheduled" card in their DM with the organizer, wherever the meeting was
// made, so both have a lasting, clickable way to join at the time. The event
// remembers its cards (`cardRefsOf`): an edit rewrites them with the event,
// in one transaction; a deletion, or dropping someone from the meeting,
// marks theirs cancelled. Cards stay in the chat either way.
// ---------------------------------------------------------------------------

/** The invitee a card's DM is shared with (the organizer themself in a self-DM). */
export function peerOfRef(ref: MeetingCardRef, organizer: string): string | null {
  const members = dmMembers(ref.channelId);
  if (!members?.includes(organizer)) return null;
  return members.find((m) => m !== organizer) ?? organizer;
}

/** Cards to post (ids picked now) for invitees who don't have one yet. */
export function plannedCards(meeting: MeetingEvent, at: number): MeetingCardRef[] {
  const organizer = meeting.createdBy;
  const covered = new Set(cardRefsOf(meeting).map((ref) => peerOfRef(ref, organizer)));
  return meeting.participants
    .filter((id) => id !== organizer && !covered.has(id))
    .map((peer) => ({
      channelId: dmChannelId(organizer, peer),
      messageId: ulid(at),
      messageSk: newMessageSk(at),
    }));
}

export interface CardPlan {
  /** The meeting with its card list brought up to date. */
  meeting: MeetingEvent;
  /** Cards of people still invited: rewritten with the event. */
  keep: MeetingCardRef[];
  /** Cards of people no longer invited: marked cancelled. */
  drop: MeetingCardRef[];
  /** People newly invited: their cards, to post. */
  add: MeetingCardRef[];
}

/** After an edit: whose cards stay, go and are new. */
export function reconcileCards(meeting: MeetingEvent, at: number): CardPlan {
  const organizer = meeting.createdBy;
  const invited = (ref: MeetingCardRef) => {
    const peer = peerOfRef(ref, organizer);
    return peer !== null && meeting.participants.includes(peer);
  };
  const refs = cardRefsOf(meeting);
  const keep = refs.filter(invited);
  const drop = refs.filter((ref) => !invited(ref));
  const next: MeetingEvent = { ...meeting };
  if (next.channelId && !keep.some((ref) => ref.channelId === next.channelId)) {
    delete next.channelId;
    delete next.messageId;
    delete next.messageSk;
  }
  const others = keep.filter((ref) => ref.channelId !== next.channelId);
  next.cards = others;
  const add = plannedCards(next, at);
  next.cards = [...others, ...add];
  if (next.cards.length === 0) delete next.cards;
  return { meeting: next, keep, drop, add };
}

/**
 * The DM between the organizer and an invitee, created when they never
 * talked (the same row `openDm` writes); `null` when it's archived.
 */
async function ensureDm(channelId: string, organizer: string): Promise<Channel | null> {
  const read = async () => {
    const { Item } = await ddb.send(
      new GetCommand({ TableName: tables.channels, Key: { channelId } }),
    );
    return Item as Channel | undefined;
  };
  const found = await read();
  if (found) return found.archived ? null : found;
  const members = dmMembers(channelId);
  if (!members) return null;
  const channel: Channel = {
    channelId,
    name: channelId,
    type: "dm",
    createdBy: organizer,
    createdAt: Date.now(),
    archived: false,
    members: [...new Set(members)].sort(compareIds),
  };
  try {
    await ddb.send(
      new PutCommand({
        TableName: tables.channels,
        Item: channel,
        ConditionExpression: "attribute_not_exists(channelId)",
      }),
    );
    log.info("dm created for a meeting card", { channelId });
    return channel;
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
    return (await read()) ?? null; // opened meanwhile
  }
}

export interface PostedCard {
  message: Message;
  channel: Channel;
}

/**
 * Posts `meeting`'s card at `refs` (each in its own DM, as the organizer).
 * Best effort per card: the meeting exists either way, and an edit later
 * skips a card that never got written.
 */
export async function postCards(
  meeting: MeetingEvent,
  refs: MeetingCardRef[],
  author: { userId: string; email: string },
): Promise<PostedCard[]> {
  if (refs.length === 0) return [];
  const card = meetingCardOf(meeting);
  const now = Date.now();
  const results = await Promise.allSettled(
    refs.map(async (ref): Promise<PostedCard> => {
      const channel = await ensureDm(ref.channelId, meeting.createdBy);
      if (!channel) throw new Error("conversation archived");
      const message: Message = {
        messageId: ref.messageId,
        channelId: ref.channelId,
        sk: ref.messageSk,
        userId: author.userId,
        userEmail: author.email,
        text: meetingCardText(card),
        attachments: [],
        createdAt: now,
        reactions: {},
        kind: "meeting",
        meeting: card,
      };
      await ddb.send(
        new PutCommand({
          TableName: tables.messages,
          Item: message,
          ConditionExpression: "attribute_not_exists(sk)",
        }),
      );
      await touchChannel(ref.channelId, now);
      return { message, channel };
    }),
  );
  const posted: PostedCard[] = [];
  results.forEach((result, i) => {
    if (result.status === "fulfilled") posted.push(result.value);
    else {
      log.error("meeting card not posted", {
        eventId: meeting.eventId,
        channelId: refs[i]?.channelId,
        ...errorFields(result.reason),
      });
    }
  });
  log.info("meeting cards posted", { eventId: meeting.eventId, cards: posted.length });
  return posted;
}

const cardUpdate = (ref: MeetingCardRef, card: MeetingCard) => ({
  TableName: tables.messages,
  Key: { channelId: ref.channelId, sk: ref.messageSk },
  UpdateExpression: "SET meeting = :card, #text = :text",
  ConditionExpression: "attribute_exists(sk) AND kind = :kind",
  ExpressionAttributeNames: { "#text": "text" },
  ExpressionAttributeValues: { ":card": card, ":text": meetingCardText(card), ":kind": "meeting" },
});

/**
 * Writes the edited event (only if nobody else changed it meanwhile: a 409
 * otherwise) and rewrites the cards at `refs` in the same transaction, so
 * the chat and the calendar never disagree. A card whose message is gone
 * (deleted) is left out and the rest written again. Returns the cards
 * written.
 */
export async function saveWithCards(
  updated: CalendarEvent,
  was: number,
  refs: MeetingCardRef[],
): Promise<MeetingCardRef[]> {
  const Put = {
    TableName: tables.events,
    Item: toItem(updated),
    ConditionExpression: "attribute_exists(eventId) AND updatedAt = :was",
    ExpressionAttributeValues: { ":was": was },
  };
  const conflict = () =>
    new HttpError(409, "The event changed meanwhile: reload the calendar and try again");
  const card = updated.type === "meeting" ? meetingCardOf(updated) : null;
  let live = card ? refs : [];
  for (;;) {
    if (live.length === 0 || !card) {
      try {
        await ddb.send(new PutCommand(Put));
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) throw conflict();
        throw err;
      }
      return [];
    }
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [{ Put }, ...live.map((ref) => ({ Update: cardUpdate(ref, card) }))],
        }),
      );
      return live;
    } catch (err) {
      if (!(err instanceof TransactionCanceledException)) throw err;
      const [event, ...cards] = err.CancellationReasons ?? [];
      if (event?.Code === "ConditionalCheckFailed") throw conflict();
      const missing = live.filter((_, i) => cards[i]?.Code === "ConditionalCheckFailed");
      if (missing.length === 0) throw err;
      // Those cards' messages are gone (deleted): the meeting still changes.
      log.warn("meeting cards missing, event written without them", {
        eventId: updated.eventId,
        channelIds: missing.map((ref) => ref.channelId),
      });
      live = live.filter((ref) => !missing.includes(ref));
    }
  }
}

/** Rewrites the cards at `refs` to `card` (e.g. cancelled); best effort. Returns those written. */
export async function rewriteCards(
  refs: MeetingCardRef[],
  card: MeetingCard,
): Promise<MeetingCardRef[]> {
  const results = await Promise.allSettled(
    refs.map((ref) => ddb.send(new UpdateCommand(cardUpdate(ref, card)))),
  );
  return refs.filter((ref, i) => {
    const result = results[i];
    if (result?.status === "fulfilled") return true;
    if (!(result?.reason instanceof ConditionalCheckFailedException)) {
      log.error("meeting card not rewritten", {
        eventId: card.eventId,
        channelId: ref.channelId,
        ...errorFields(result?.reason),
      });
    }
    return false;
  });
}

/** Loads the DMs of `refs` (once each), for their audiences. */
async function channelsOf(refs: MeetingCardRef[]): Promise<Map<string, Channel>> {
  const ids = [...new Set(refs.map((ref) => ref.channelId))];
  const rows = await Promise.all(
    ids.map(async (channelId) => {
      const { Item } = await ddb.send(
        new GetCommand({ TableName: tables.channels, Key: { channelId } }),
      );
      return Item as Channel | undefined;
    }),
  );
  return new Map(rows.filter((c): c is Channel => !!c).map((c) => [c.channelId, c]));
}

/** The people of each DM see the rewritten card at once (`message.updated`). */
export async function announceCards(
  refs: MeetingCardRef[],
  card: MeetingCard,
  connections: LiveConnection[],
): Promise<void> {
  if (refs.length === 0) return;
  try {
    const channels = await channelsOf(refs);
    await Promise.all(
      refs.map((ref) => {
        const channel = channels.get(ref.channelId);
        if (!channel) return 0;
        const inAudience = channelAudience(channel);
        return deliver(connections, (c) =>
          inAudience(c)
            ? {
                type: "message.updated",
                channelId: ref.channelId,
                sk: ref.messageSk,
                messageId: ref.messageId,
                text: meetingCardText(card),
                meeting: card,
              }
            : null,
        );
      }),
    );
  } catch (err) {
    log.error("meeting card broadcast failed", { eventId: card.eventId, ...errorFields(err) });
  }
}

/** The people of each DM see the new card (`message.new`; a new DM makes clients reload the list). */
export async function announcePosted(
  posted: PostedCard[],
  connections: LiveConnection[],
): Promise<void> {
  try {
    await Promise.all(
      posted.map(({ message, channel }) => {
        const inAudience = channelAudience(channel);
        return deliver(connections, (c) =>
          inAudience(c) ? { type: "message.new", message, clientId: "" } : null,
        );
      }),
    );
  } catch (err) {
    log.error("meeting card broadcast failed", { ...errorFields(err) });
  }
}

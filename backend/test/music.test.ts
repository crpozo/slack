import { DeleteCommand, GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { musicPositionMs, type MusicRoom } from "@mindfultech/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handler, useMusicTitles } from "../src/handlers/music";
import type { HttpEvent } from "../src/lib/http";
import { ALICE, BOB, ddbMock, resetMocks, sentEvents } from "./helpers";

// Phase 78: music rooms. One clock per room, a DJ who controls it, listeners who come and go.

const TABLE = "slack-test-music";
const ADMIN = { userId: "user-admin", email: "admin@example.com" };
type Who = { userId: string; email: string };
let rows: Map<string, Record<string, unknown>>;
const T0 = Date.UTC(2026, 10, 23, 15);
const LINK = "https://www.youtube.com/watch?v=X3G2C15azIs";

async function call(
  routeKey: string,
  user: Who,
  opts: { body?: unknown; id?: string; groups?: string } = {},
) {
  const event = {
    version: "2.0",
    routeKey,
    rawPath: "/",
    headers: {},
    pathParameters: opts.id ? { id: opts.id } : {},
    ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
    isBase64Encoded: false,
    requestContext: {
      http: { method: routeKey.split(" ")[0], path: "/" },
      authorizer: {
        jwt: {
          claims: {
            sub: user.userId,
            email: user.email,
            ...(opts.groups && { "cognito:groups": opts.groups }),
          },
          scopes: [],
        },
      },
    },
  } as unknown as HttpEvent;
  const r = (await handler(event)) as { statusCode: number; body?: string };
  return { status: r.statusCode, json: r.body ? JSON.parse(r.body) : undefined };
}
const control = (user: Who, id: string, body: object, groups?: string) =>
  call("POST /music/{id}/control", user, { id, body, groups });
const create = async (user: Who = ALICE) =>
  (await call("POST /music", user, { body: { name: "Viernes" } })).json.room as MusicRoom;

beforeEach(() => {
  resetMocks();
  rows = new Map();
  vi.useFakeTimers({ now: T0, toFake: ["Date"] });
  let n = 0;
  useMusicTitles(async () => `Canción ${++n}`);
  ddbMock.on(PutCommand, { TableName: TABLE }).callsFake(({ Item }) => {
    rows.set(Item.roomId, structuredClone(Item));
    return {};
  });
  ddbMock.on(GetCommand, { TableName: TABLE }).callsFake(({ Key }) => ({
    Item: structuredClone(rows.get(Key.roomId)),
  }));
  ddbMock.on(DeleteCommand, { TableName: TABLE }).callsFake(({ Key }) => {
    rows.delete(Key.roomId);
    return {};
  });
  ddbMock.on(ScanCommand, { TableName: TABLE }).callsFake(() => ({ Items: [...rows.values()] }));
  ddbMock.on(ScanCommand, { TableName: "slack-test-connections" }).resolves({
    Items: [
      { connectionId: "conn-alice", userId: ALICE.userId },
      { connectionId: "conn-bob", userId: BOB.userId },
      { connectionId: "conn-guest", userId: "user-guest", role: "guest" },
    ],
  });
});
afterEach(() => vi.useRealTimers());

describe("music rooms", () => {
  it("are for the team: an external gets nothing and hears of nothing", async () => {
    expect((await call("GET /music", ALICE, { groups: "[guests]" })).status).toBe(403);
    await create();
    expect(
      sentEvents()
        .map(([conn]) => conn)
        .sort(),
    ).toEqual(["conn-alice", "conn-bob"]);
  });

  it("whoever opens a room is its DJ; the first song starts by itself and everyone gets the clock", async () => {
    const room = await create();
    expect(room).toMatchObject({ djId: ALICE.userId, queue: [], trackId: null, playing: false });
    expect(room.listeners.map((l) => l.userId)).toEqual([ALICE.userId]);
    expect(
      (await control(ALICE, room.roomId, { action: "add", url: "https://example.com" })).status,
    ).toBe(400);
    const added = (await control(ALICE, room.roomId, { action: "add", url: LINK })).json;
    expect(added.room).toMatchObject({ playing: true, positionMs: 0, at: T0 });
    expect(added.room.queue[0]).toMatchObject({ videoId: "X3G2C15azIs", title: "Canción 1" });
    expect(added.room.trackId).toBe(added.room.queue[0].id);
    expect(added.serverNow).toBe(T0);
    // Everyone on the team is told, with the server's time to follow the clock.
    const last = sentEvents().at(-1)![1];
    expect(last).toMatchObject({ type: "music.updated", serverNow: T0 });

    // Bob joins 40 s later: the song is 40 s in.
    vi.setSystemTime(T0 + 40_000);
    const joined = (await call("POST /music/{id}/join", BOB, { id: room.roomId })).json;
    expect(joined.room.listeners.map((l: { userId: string }) => l.userId).sort()).toEqual(
      [ALICE.userId, BOB.userId].sort(),
    );
    expect(musicPositionMs(joined.room, joined.serverNow)).toBe(40_000);
  });

  it("only the DJ (or an admin) plays, pauses, seeks, skips, queues and deletes", async () => {
    const room = await create();
    await control(ALICE, room.roomId, { action: "add", url: LINK });
    await call("POST /music/{id}/join", BOB, { id: room.roomId });
    for (const body of [
      { action: "pause" },
      { action: "next" },
      { action: "seek", positionMs: 5 },
      { action: "add", url: LINK },
    ]) {
      expect((await control(BOB, room.roomId, body)).status).toBe(403);
    }
    expect((await call("DELETE /music/{id}", BOB, { id: room.roomId })).status).toBe(403);

    vi.setSystemTime(T0 + 10_000);
    const paused = (await control(ALICE, room.roomId, { action: "pause" })).json.room as MusicRoom;
    expect(paused).toMatchObject({ playing: false, positionMs: 10_000 });
    vi.setSystemTime(T0 + 60_000);
    // Paused: the position doesn't move; play resumes from it.
    const resumed = (await control(ALICE, room.roomId, { action: "play" })).json.room as MusicRoom;
    expect(musicPositionMs(resumed, T0 + 65_000)).toBe(15_000);
    const sought = (
      await control(ADMIN, room.roomId, { action: "seek", positionMs: 90_000 }, "[admins]")
    ).json.room;
    expect(sought.positionMs).toBe(90_000);
    expect((await call("DELETE /music/{id}", ALICE, { id: room.roomId })).status).toBe(200);
    expect(sentEvents().at(-1)![1]).toMatchObject({ type: "music.updated", removed: room.roomId });
    expect((await call("GET /music", BOB)).json.rooms).toEqual([]);
    expect((await call("POST /music/{id}/join", BOB, { id: room.roomId })).status).toBe(404);
  });

  it("moves to the next song once when players reach the end, and goes round the queue", async () => {
    const room = await create();
    await control(ALICE, room.roomId, { action: "add", url: LINK });
    const two = (
      await control(ALICE, room.roomId, { action: "add", url: "https://youtu.be/dQw4w9WgXcQ" })
    ).json.room as MusicRoom;
    const [first, second] = two.queue;
    await call("POST /music/{id}/join", BOB, { id: room.roomId });
    // Both players report the same ending: one step, not two.
    const a = (await control(ALICE, room.roomId, { action: "ended", trackId: first!.id })).json
      .room;
    const b = (await control(BOB, room.roomId, { action: "ended", trackId: first!.id })).json.room;
    expect([a.trackId, b.trackId]).toEqual([second!.id, second!.id]);
    expect(b).toMatchObject({ playing: true, positionMs: 0 });
    const round = (await control(BOB, room.roomId, { action: "ended", trackId: second!.id })).json
      .room;
    expect(round.trackId).toBe(first!.id);
    // Someone who isn't in the room can't move it.
    expect(
      (await control(ADMIN, room.roomId, { action: "ended", trackId: first!.id })).status,
    ).toBe(403);
    // Removing the song that is on plays the next; removing the last one stops.
    const removed = (await control(ALICE, room.roomId, { action: "remove", trackId: first!.id }))
      .json.room;
    expect(removed).toMatchObject({ trackId: second!.id, playing: true });
    const empty = (await control(ALICE, room.roomId, { action: "remove", trackId: second!.id }))
      .json.room;
    expect(empty).toMatchObject({ trackId: null, playing: false, queue: [] });
  });

  it("forgets a listener who left or went silent; the room can then be taken over", async () => {
    const room = await create();
    await call("POST /music/{id}/join", BOB, { id: room.roomId });
    // The DJ is here: Bob can't take over.
    expect((await control(BOB, room.roomId, { action: "claim" })).status).toBe(403);
    // A heartbeat is saved without telling everyone again.
    const before = sentEvents().length;
    vi.setSystemTime(T0 + 60_000);
    await call("POST /music/{id}/join", BOB, { id: room.roomId });
    expect(sentEvents()).toHaveLength(before);
    // Alice's tab closed: no heartbeat for a while.
    vi.setSystemTime(T0 + 200_000);
    await call("POST /music/{id}/join", BOB, { id: room.roomId });
    const rooms = (await call("GET /music", BOB)).json.rooms as MusicRoom[];
    expect(rooms[0]!.listeners.map((l) => l.userId)).toEqual([BOB.userId]);
    const claimed = (await control(BOB, room.roomId, { action: "claim" })).json.room as MusicRoom;
    expect(claimed.djId).toBe(BOB.userId);
    // A new DJ is news for the team; so was the room being opened. A song or a join isn't.
    expect(sentEvents().at(-1)![1]).toMatchObject({ type: "music.updated", news: "dj" });
    expect(sentEvents()[0]![1]).toMatchObject({ type: "music.updated", news: "created" });
    expect(sentEvents().filter(([, e]) => "news" in e)).toHaveLength(4); // 2 events × 2 connections
    const left = (await call("POST /music/{id}/leave", BOB, { id: room.roomId })).json.room;
    expect(left.listeners).toEqual([]);
  });

  it("a listener's reaction reaches the team for a moment and is never stored", async () => {
    const room = await create();
    expect((await control(BOB, room.roomId, { action: "react", emoji: "🔥" })).status).toBe(403);
    await call("POST /music/{id}/join", BOB, { id: room.roomId });
    expect((await control(BOB, room.roomId, { action: "react", emoji: "💩" })).status).toBe(400);
    const stored = structuredClone(rows.get(room.roomId));
    expect((await control(BOB, room.roomId, { action: "react", emoji: "🔥" })).status).toBe(200);
    expect(sentEvents().at(-1)![1]).toMatchObject({
      type: "music.updated",
      reaction: { roomId: room.roomId, userId: BOB.userId, emoji: "🔥" },
    });
    expect(rows.get(room.roomId)).toEqual(stored);
  });
});

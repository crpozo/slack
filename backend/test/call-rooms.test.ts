import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { dmChannelId, type CallRoomEvent, type ServerEvent } from "@mindfultech/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handler as call } from "../src/handlers/call";
import { handler as disconnect } from "../src/handlers/disconnect";
import {
  ALICE,
  BOB,
  ddbMock,
  mockChannels,
  privateRow,
  resetMocks,
  sentEvents,
  wsEvent,
} from "./helpers";

const CAROL = { userId: "user-carol", email: "carol@example.com" };
const DAN = { userId: "user-dan", email: "dan@example.com" };
const ROOMS = "slack-test-call-rooms";
const CONNECTIONS = "slack-test-connections";
const CH = "ch_proj";
const NOW = 1_800_000_000_000;
const nowS = Math.floor(NOW / 1000);

const project = privateRow(CH, ALICE.userId, [ALICE.userId, BOB.userId, CAROL.userId]);
const live = [
  { connectionId: "conn-alice", userId: ALICE.userId },
  { connectionId: "conn-alice-2", userId: ALICE.userId },
  { connectionId: "conn-bob", userId: BOB.userId },
  { connectionId: "conn-carol", userId: CAROL.userId },
  { connectionId: "conn-dan", userId: DAN.userId },
];

const seat = (connectionId: string, joinedAt = NOW - 60_000) => ({
  connectionId,
  joinedAt,
  media: "video",
});
const roomRow = (participants: Record<string, ReturnType<typeof seat>>) => ({
  channelId: CH,
  roomId: "room-1",
  startedAt: NOW - 120_000,
  startedBy: BOB.userId,
  participants,
  expiresAt: nowS + 3600,
});

const send = (body: Record<string, unknown>, user = ALICE, connectionId = "conn-alice") =>
  call(wsEvent("call", { action: "call", ...body }, { user, connectionId }));

const roomEvents = () =>
  sentEvents().filter(([, e]) => e.type === "call.room") as Array<[string, CallRoomEvent]>;
const recipients = (events: Array<[string, ServerEvent]>) =>
  events.map(([id]) => id).sort((a, b) => a.localeCompare(b));

const ccf = () => new ConditionalCheckFailedException({ message: "no", $metadata: {} });

beforeEach(() => {
  resetMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  mockChannels(project);
  ddbMock.on(ScanCommand, { TableName: CONNECTIONS }).resolves({ Items: live });
  ddbMock.on(GetCommand, { TableName: ROOMS }).resolves({});
  ddbMock.on(PutCommand).resolves({});
  ddbMock.on(UpdateCommand).resolves({});
  ddbMock.on(DeleteCommand).resolves({});
});

describe("joining a channel call", () => {
  it("starts one, remembers the seat on the connection and tells the channel", async () => {
    await send({ signal: "join", channelId: CH, media: "video" });

    const put = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
    expect(put).toMatchObject({
      TableName: ROOMS,
      ConditionExpression: "attribute_not_exists(channelId) OR expiresAt <= :now",
      Item: {
        channelId: CH,
        startedBy: ALICE.userId,
        participants: { [ALICE.userId]: { connectionId: "conn-alice", media: "video" } },
      },
    });
    expect(put.Item?.expiresAt).toBe(nowS + 6 * 3600);
    const mark = ddbMock
      .commandCalls(UpdateCommand)
      .map((c) => c.args[0].input)
      .find((i) => i.TableName === CONNECTIONS);
    expect(mark).toMatchObject({
      Key: { connectionId: "conn-alice" },
      UpdateExpression: "SET callRoom = :c",
      ExpressionAttributeValues: { ":c": CH },
    });

    // The channel's members (every tab), not Dan, who isn't in it.
    expect(recipients(roomEvents())).toEqual([
      "conn-alice",
      "conn-alice-2",
      "conn-bob",
      "conn-carol",
    ]);
    const [, event] = roomEvents()[0]!;
    expect(event).toMatchObject({ change: "started", userId: ALICE.userId, channelId: CH });
    expect(event.room?.participants).toEqual([
      { userId: ALICE.userId, joinedAt: NOW, media: "video" },
    ]);
    expect(JSON.stringify(event)).not.toContain("conn-"); // connections stay on the server
  });

  it("joins the call going on, freeing seats of connections that are gone", async () => {
    ddbMock.on(GetCommand, { TableName: ROOMS }).resolves({
      Item: roomRow({ [BOB.userId]: seat("conn-bob"), [CAROL.userId]: seat("conn-carol-old") }),
    });
    ddbMock.on(UpdateCommand, { TableName: ROOMS }).resolves({
      Attributes: roomRow({
        [BOB.userId]: seat("conn-bob"),
        [ALICE.userId]: seat("conn-alice", NOW),
      }),
    });

    await send({ signal: "join", channelId: CH, media: "audio" });

    const update = ddbMock
      .commandCalls(UpdateCommand)
      .map((c) => c.args[0].input)
      .find((i) => i.TableName === ROOMS)!;
    expect(update.UpdateExpression).toBe("SET #p.#u = :seat, expiresAt = :ttl REMOVE #p.#s0");
    expect(update.ExpressionAttributeNames).toMatchObject({
      "#u": ALICE.userId,
      "#s0": CAROL.userId,
    });
    expect(update.ConditionExpression).toBe(
      "roomId = :room AND (attribute_exists(#p.#u) OR size(#p) < :limit)",
    );
    expect(update.ExpressionAttributeValues).toMatchObject({ ":room": "room-1", ":limit": 7 });
    const [, event] = roomEvents()[0]!;
    expect(event.change).toBe("joined");
    expect(event.room?.participants.map((p) => p.userId)).toEqual([BOB.userId, ALICE.userId]);
  });

  it("refuses a seventh person", async () => {
    const six = Object.fromEntries(
      ["u1", "u2", "u3", "u4", "u5", "u6"].map((id) => [id, seat(`conn-${id}`)]),
    );
    ddbMock.on(GetCommand, { TableName: ROOMS }).resolves({ Item: roomRow(six) });
    ddbMock.on(ScanCommand, { TableName: CONNECTIONS }).resolves({
      Items: [
        ...live,
        ...Object.keys(six).map((id) => ({ connectionId: `conn-${id}`, userId: id })),
      ],
    });

    await send({ signal: "join", channelId: CH, media: "video" });

    expect(sentEvents()).toEqual([
      ["conn-alice", expect.objectContaining({ type: "error", code: "CALL_FULL" })],
    ]);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("someone starting it at the same moment: joins theirs", async () => {
    ddbMock.on(PutCommand, { TableName: ROOMS }).rejects(ccf());
    ddbMock
      .on(GetCommand, { TableName: ROOMS })
      .resolvesOnce({})
      .resolves({ Item: roomRow({ [BOB.userId]: seat("conn-bob") }) });
    ddbMock.on(UpdateCommand, { TableName: ROOMS }).resolves({
      Attributes: roomRow({
        [BOB.userId]: seat("conn-bob"),
        [ALICE.userId]: seat("conn-alice", NOW),
      }),
    });

    await send({ signal: "join", channelId: CH, media: "video" });

    expect(roomEvents()[0]![1].change).toBe("joined");
  });

  it("isn't for DMs, channels you can't see, or guests", async () => {
    await send({
      signal: "join",
      channelId: dmChannelId(ALICE.userId, BOB.userId),
      media: "video",
    });
    await send({ signal: "join", channelId: CH, media: "video" }, DAN, "conn-dan");
    expect(sentEvents().map(([, e]) => (e as { code?: string }).code)).toEqual([
      "CHANNEL_NOT_FOUND",
      "CHANNEL_NOT_FOUND",
    ]);
    const guest = { ...CAROL, role: "guest" };
    await send({ signal: "join", channelId: CH, media: "video" }, guest, "conn-carol");
    expect(sentEvents().at(-1)![1]).toMatchObject({ code: "FORBIDDEN" });
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });
});

describe("signals inside a channel call", () => {
  const inRoom = roomRow({
    [ALICE.userId]: seat("conn-alice"),
    [BOB.userId]: seat("conn-bob"),
    [CAROL.userId]: seat("conn-carol"),
  });

  beforeEach(() => {
    ddbMock.on(GetCommand, { TableName: ROOMS }).resolves({ Item: inRoom });
  });

  const offer = {
    signal: "offer",
    channelId: CH,
    callId: "room-1",
    to: BOB.userId,
    media: "video",
    sdp: "v=0",
  };

  it("go only to the seat's connection (not the person's other tabs), never ringing", async () => {
    await send(offer);
    expect(sentEvents()).toEqual([
      [
        "conn-bob",
        {
          type: "call.offer",
          callId: "room-1",
          channelId: CH,
          from: ALICE.userId,
          media: "video",
          sdp: "v=0",
        },
      ],
    ]);

    const candidates = [
      { candidate: "candidate:1 1 udp 1 1.2.3.4 5 typ host", sdpMid: "0" },
      { candidate: "candidate:2 1 udp 1 1.2.3.5 5 typ host", sdpMid: "0" },
    ];
    await send({
      signal: "ice_candidates",
      channelId: CH,
      callId: "room-1",
      to: CAROL.userId,
      candidates,
    });
    expect(
      sentEvents()
        .slice(1)
        .map(([id, e]) => `${id}:${e.type}`),
    ).toEqual(["conn-carol:call.ice_candidate", "conn-carol:call.ice_candidate"]);
  });

  it("are refused from someone not seated, another tab, another call or to someone outside", async () => {
    await send(offer, ALICE, "conn-alice-2"); // Alice's other tab
    await send({ ...offer, callId: "room-old" });
    await send({ ...offer, to: DAN.userId });
    await send(offer, DAN, "conn-dan");
    await send({ ...offer, signal: "end", reason: "hangup" });
    const codes = sentEvents().map(([id, e]) => `${id}:${(e as { code?: string }).code}`);
    expect(codes).toEqual([
      "conn-alice-2:FORBIDDEN",
      "conn-alice:FORBIDDEN",
      "conn-alice:FORBIDDEN",
      "conn-dan:FORBIDDEN",
      "conn-alice:BAD_REQUEST",
    ]);
  });
});

describe("leaving a channel call", () => {
  it("frees the seat and tells the channel", async () => {
    ddbMock.on(UpdateCommand, { TableName: ROOMS }).resolves({
      Attributes: roomRow({ [BOB.userId]: seat("conn-bob") }),
    });

    await send({ signal: "leave", channelId: CH, callId: "room-1" });

    const update = ddbMock
      .commandCalls(UpdateCommand)
      .map((c) => c.args[0].input)
      .find((i) => i.TableName === ROOMS)!;
    // Only the seat this connection holds (another tab of hers keeps its own).
    expect(update).toMatchObject({
      UpdateExpression: "REMOVE #p.#u",
      ConditionExpression: "#p.#u.connectionId = :conn",
      ExpressionAttributeValues: { ":conn": "conn-alice" },
    });
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
    const [, event] = roomEvents()[0]!;
    expect(event).toMatchObject({ change: "left", userId: ALICE.userId });
    expect(event.room?.participants.map((p) => p.userId)).toEqual([BOB.userId]);
  });

  it("the last one out ends it", async () => {
    ddbMock.on(UpdateCommand, { TableName: ROOMS }).resolves({ Attributes: roomRow({}) });

    await send({ signal: "leave", channelId: CH, callId: "room-1" });

    expect(ddbMock.commandCalls(DeleteCommand)[0]!.args[0].input).toMatchObject({
      TableName: ROOMS,
      Key: { channelId: CH },
      ConditionExpression: "roomId = :room AND size(#p) = :zero",
    });
    expect(roomEvents()[0]![1]).toEqual({
      type: "call.room",
      channelId: CH,
      room: null,
      change: "ended",
      userId: ALICE.userId,
      startedAt: NOW - 120_000,
    });
  });

  it("a seat you no longer hold: nothing happens", async () => {
    ddbMock.on(UpdateCommand, { TableName: ROOMS }).rejects(ccf());
    await send({ signal: "leave", channelId: CH, callId: "room-1" });
    expect(roomEvents()).toEqual([]);
  });

  it("a closed socket frees its seat too", async () => {
    ddbMock
      .on(DeleteCommand, { TableName: CONNECTIONS })
      .resolves({ Attributes: { userId: ALICE.userId, callRoom: CH } });
    ddbMock.on(UpdateCommand, { TableName: ROOMS }).resolves({
      Attributes: roomRow({ [BOB.userId]: seat("conn-bob") }),
    });

    await disconnect(wsEvent("$disconnect"));

    const update = ddbMock
      .commandCalls(UpdateCommand)
      .map((c) => c.args[0].input)
      .find((i) => i.TableName === ROOMS);
    expect(update?.ExpressionAttributeValues).toEqual({ ":conn": "conn-alice" });
    expect(roomEvents()[0]![1]).toMatchObject({ change: "left", userId: ALICE.userId });
  });
});

describe("the calls going on", () => {
  it("lists those in channels you can see, without connections", async () => {
    ddbMock.on(ScanCommand, { TableName: ROOMS }).resolves({
      Items: [
        roomRow({ [BOB.userId]: seat("conn-bob") }),
        { ...roomRow({ [DAN.userId]: seat("conn-dan") }), channelId: "ch_secret" },
        { ...roomRow({}), channelId: "ch_expired", expiresAt: nowS - 1 },
      ],
    });

    await send({ signal: "rooms" });

    const [[id, event]] = sentEvents() as [
      [string, { type: string; rooms: Array<{ channelId: string }> }],
    ];
    expect(id).toBe("conn-alice");
    expect(event.type).toBe("call.rooms");
    expect(event.rooms.map((r) => r.channelId)).toEqual([CH]);
    expect(JSON.stringify(event)).not.toContain("conn-");
  });
});

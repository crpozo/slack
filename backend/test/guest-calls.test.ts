import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { APIGatewayRequestAuthorizerEvent } from "aws-lambda";
import type { CallLobbyEvent, CallRoomEvent, ServerEvent } from "@mindfultech/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handler as authorize } from "../src/handlers/authorizer";
import { handler as call } from "../src/handlers/call";
import { handler as connect } from "../src/handlers/connect";
import { handler as disconnect } from "../src/handlers/disconnect";
import { handler as history } from "../src/handlers/history";
import { handler as message } from "../src/handlers/message";
import { handler as user } from "../src/handlers/user";
import { deliver, type LiveConnection } from "../src/lib/broadcast";
import { decodeCallToken, encodeCallToken, externalUserId } from "../src/lib/callLinks";
import type { WsEvent } from "../src/lib/handler";
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

// ---------------------------------------------------------------------------
// Phase 59: guests in their private channels' calls, and externals through a
// call link (a lobby, then the call and nothing else). These tests pin who may
// do what: the authorizer, the route gates, the delivery filter and the call
// handler's checks.
// ---------------------------------------------------------------------------

const ROOMS = "slack-test-call-rooms";
const CONNECTIONS = "slack-test-connections";
const CH = "ch_client";
const NOW = 1_800_000_000_000;
const nowS = Math.floor(NOW / 1000);
const SECRET = "s3cr3t-s3cr3t-s3cr3t-s3cr3t";
const GUEST = { userId: "user-guest", email: "client@acme.com", role: "guest" };
const CLIENT = privateRow(CH, ALICE.userId, [ALICE.userId, BOB.userId, GUEST.userId]);
const EXT = externalUserId("room-1", "tab-0123456789abcdef");
const EXT_SCOPE = { channelId: CH, roomId: "room-1", name: "Ana Cliente" };

const seat = (connectionId: string, extra: Record<string, unknown> = {}) => ({
  connectionId,
  joinedAt: NOW - 60_000,
  media: "video",
  ...extra,
});
const room = (extra: Record<string, unknown> = {}) => ({
  channelId: CH,
  roomId: "room-1",
  startedAt: NOW - 120_000,
  startedBy: ALICE.userId,
  participants: { [ALICE.userId]: seat("conn-alice") },
  expiresAt: nowS + 3600,
  linkToken: SECRET,
  knocks: {},
  admitted: {},
  ...extra,
});
const live: LiveConnection[] = [
  { connectionId: "conn-alice", userId: ALICE.userId },
  { connectionId: "conn-bob", userId: BOB.userId },
  { connectionId: "conn-guest", userId: GUEST.userId, role: "guest" },
  { connectionId: "conn-ext", userId: EXT, role: "guest", external: true, callScope: CH },
  {
    connectionId: "conn-ext-other",
    userId: "ext_other",
    role: "guest",
    external: true,
    callScope: "ch_other",
  },
];

/** A WebSocket event from the external, as API Gateway forwards their authorizer context. */
const asExternal = (routeKey: string, body?: unknown, connectionId = "conn-ext"): WsEvent => {
  const event = wsEvent(routeKey, body, { user: null, connectionId });
  event.requestContext.authorizer = {
    userId: EXT,
    email: "",
    role: "guest",
    external: "1",
    callScope: EXT_SCOPE.channelId,
    callRoomId: EXT_SCOPE.roomId,
    name: EXT_SCOPE.name,
  };
  return event;
};
const callAsExternal = (body: Record<string, unknown>) =>
  call(asExternal("call", { action: "call", ...body }));
const callAs = (body: Record<string, unknown>, who = ALICE, connectionId = "conn-alice") =>
  call(wsEvent("call", { action: "call", ...body }, { user: who, connectionId }));

const errors = () =>
  sentEvents()
    .filter(([, e]) => e.type === "error")
    .map(([id, e]) => [id, (e as { code: string }).code]);
const ofType = <T extends ServerEvent>(type: T["type"]) =>
  sentEvents().filter(([, e]) => e.type === type) as Array<[string, T]>;
const updates = () => ddbMock.commandCalls(UpdateCommand).map((c) => c.args[0].input);
const ccf = () => new ConditionalCheckFailedException({ message: "no", $metadata: {} });

beforeEach(() => {
  resetMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  mockChannels(CLIENT);
  ddbMock.on(ScanCommand, { TableName: CONNECTIONS }).resolves({ Items: live });
  ddbMock.on(GetCommand, { TableName: ROOMS }).resolves({ Item: room() });
  ddbMock.on(PutCommand).resolves({});
  ddbMock.on(UpdateCommand).resolves({});
  ddbMock.on(DeleteCommand).resolves({});
});

describe("the call link's token", () => {
  it("names the channel and carries the secret; anything else isn't one", () => {
    const token = encodeCallToken(CH, SECRET);
    expect(decodeCallToken(token)).toEqual({ channelId: CH, secret: SECRET });
    for (const bad of ["", "abc", `${token}!`, "Y2g.short", "Li4vLi4.s3cr3t-s3cr3t-s3cr3t"]) {
      expect(decodeCallToken(bad), bad).toBeNull();
    }
  });

  it("gives an external the same id in the same tab (rejoining keeps their admission)", () => {
    expect(externalUserId("room-1", "tab-0123456789abcdef")).toBe(EXT);
    expect(EXT).toMatch(/^ext_[\w-]{22}$/);
    expect(externalUserId("room-2", "tab-0123456789abcdef")).not.toBe(EXT);
    // No usable tab id: a fresh one each time.
    expect(externalUserId("room-1", "x")).not.toBe(externalUserId("room-1", "x"));
  });
});

describe("the WebSocket authorizer and call links", () => {
  const authEvent = (query: Record<string, string>) =>
    ({
      type: "REQUEST",
      methodArn: "arn:aws:execute-api:us-east-1:1:api/dev/$connect",
      queryStringParameters: query,
    }) as unknown as APIGatewayRequestAuthorizerEvent;
  const link = (extra: Record<string, string> = {}) =>
    authEvent({
      token: `call:${encodeCallToken(CH, SECRET)}`,
      room: "room-1",
      name: "Ana Cliente",
      cid: "tab-0123456789abcdef",
      ...extra,
    });

  it("lets in someone with a valid link: an external, tied to that call, with no email", async () => {
    const result = await authorize(link());
    expect(result.policyDocument.Statement[0]).toMatchObject({ Effect: "Allow" });
    expect(result.context).toEqual({
      userId: EXT,
      email: "",
      role: "guest",
      external: "1",
      callScope: CH,
      callRoomId: "room-1",
      name: "Ana Cliente",
    });
  });

  it("refuses a wrong secret, another call, an ended call, a call with no link, or no name", async () => {
    const denied = async (event: APIGatewayRequestAuthorizerEvent) =>
      (await authorize(event)).policyDocument.Statement[0]?.Effect;
    expect(
      await denied(link({ token: `call:${encodeCallToken(CH, "wrong-wrong-wrong-wrong")}` })),
    ).toBe("Deny");
    expect(await denied(link({ room: "room-0" }))).toBe("Deny"); // a link to an earlier call
    expect(await denied(link({ name: "  " }))).toBe("Deny");
    expect(await denied(link({ token: "call:garbage" }))).toBe("Deny");
    ddbMock.on(GetCommand, { TableName: ROOMS }).resolves({ Item: room({ linkToken: undefined }) });
    expect(await denied(link())).toBe("Deny");
    ddbMock.on(GetCommand, { TableName: ROOMS }).resolves({});
    expect(await denied(link())).toBe("Deny"); // the call ended
  });

  it("stores the external's connection without the directory or presence", async () => {
    await connect(asExternal("$connect"));
    const put = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
    expect(put).toMatchObject({
      TableName: CONNECTIONS,
      Item: {
        connectionId: "conn-ext",
        userId: EXT,
        role: "guest",
        external: true,
        callScope: CH,
        callRoomId: "room-1",
        name: "Ana Cliente",
      },
    });
    expect(updates()).toHaveLength(0); // no users row
    expect(sentEvents()).toEqual([]); // nobody is told they're online
  });
});

describe("what an external's connection may do", () => {
  it("is refused every chat route before any handler runs", async () => {
    await message(
      asExternal("message", { action: "message", channelId: CH, text: "hi", clientId: "c" }),
    );
    await history(asExternal("history", { action: "history", channelId: CH }));
    await user(asExternal("user", { action: "user", op: "list" }));
    expect(errors()).toEqual([
      ["conn-ext", "FORBIDDEN"],
      ["conn-ext", "FORBIDDEN"],
      ["conn-ext", "FORBIDDEN"],
    ]);
    expect(ddbMock.commandCalls(GetCommand, { TableName: "slack-test-messages" })).toHaveLength(0);
  });

  it("receives its call's events and nothing else, whatever a handler sends", async () => {
    const ext = [live[3]!];
    const roomEvent = {
      type: "call.room",
      channelId: CH,
      room: null,
      change: "ended",
      userId: "x",
    };
    expect(await deliver(ext, () => roomEvent as ServerEvent)).toBe(1);
    for (const type of [
      "message.new",
      "channel.list",
      "user.connected",
      "user.typing",
      "call.rooms",
    ]) {
      expect(await deliver(ext, () => ({ type }) as ServerEvent), type).toBe(0);
    }
  });

  it("can't act outside its call: another channel, the list of calls, a link, admitting, a DM", async () => {
    await callAsExternal({ signal: "join", channelId: "ch_other", media: "video" });
    await callAsExternal({ signal: "rooms" });
    await callAsExternal({ signal: "link", channelId: CH, callId: "room-1" });
    await callAsExternal({
      signal: "admit",
      channelId: CH,
      callId: "room-1",
      userId: EXT,
      admit: true,
    });
    await callAsExternal({
      signal: "offer",
      channelId: "dm_a_b",
      callId: "c",
      to: ALICE.userId,
      media: "video",
      sdp: "v",
    });
    await callAsExternal({
      signal: "offer",
      channelId: CH,
      callId: "room-0",
      to: ALICE.userId,
      media: "video",
      sdp: "v",
    });
    expect(errors().map(([, code]) => code)).toEqual(Array(6).fill("FORBIDDEN"));
    expect(updates()).toHaveLength(0);
  });
});

describe("the lobby", () => {
  it("puts a knock in the lobby and tells the channel and the external", async () => {
    ddbMock.on(UpdateCommand, { TableName: ROOMS }).resolves({ Attributes: room() });
    await callAsExternal({ signal: "knock" });
    const knock = updates().find((u) => u.TableName === ROOMS)!;
    expect(knock).toMatchObject({
      Key: { channelId: CH },
      UpdateExpression: "SET knocks.#u = :k",
      ConditionExpression: "roomId = :room AND attribute_exists(linkToken)",
      ExpressionAttributeNames: { "#u": EXT },
      ExpressionAttributeValues: {
        ":k": { name: "Ana Cliente", connectionId: "conn-ext", at: NOW },
        ":room": "room-1",
      },
    });
    const lobby = ofType<CallLobbyEvent>("call.lobby");
    expect(lobby).toEqual([
      [
        "conn-ext",
        { type: "call.lobby", status: "waiting", channelId: CH, roomId: "room-1", userId: EXT },
      ],
    ]);
  });

  it("announces who waits to the channel (guests too) and to this call's externals only", async () => {
    ddbMock.on(UpdateCommand, { TableName: ROOMS }).resolves({
      Attributes: room({
        knocks: { [EXT]: { name: "Ana Cliente", connectionId: "conn-ext", at: NOW } },
      }),
    });
    await callAsExternal({ signal: "knock" });
    const rooms = ofType<CallRoomEvent>("call.room");
    expect(rooms.map(([id]) => id).sort()).toEqual([
      "conn-alice",
      "conn-bob",
      "conn-ext",
      "conn-guest",
    ]);
    const [, event] = rooms[0]!;
    expect(event.change).toBe("waiting");
    expect(event.room?.waiting).toEqual([{ userId: EXT, name: "Ana Cliente", at: NOW }]);
    expect(JSON.stringify(event)).not.toMatch(/conn-|s3cr3t/); // no connection ids, no secret
  });

  it("says the call is over, or lets straight in someone already admitted", async () => {
    ddbMock.on(GetCommand, { TableName: ROOMS }).resolves({});
    await callAsExternal({ signal: "knock" });
    ddbMock.on(GetCommand, { TableName: ROOMS }).resolves({
      Item: room({ admitted: { [EXT]: { name: "Ana Cliente", connectionId: "conn-old", at: 1 } } }),
    });
    await callAsExternal({ signal: "knock" });
    expect(ofType<CallLobbyEvent>("call.lobby").map(([, e]) => e.status)).toEqual([
      "ended",
      "admitted",
    ]);
    expect(updates()).toHaveLength(0);
  });

  it("is answered only by someone seated in the call, never a guest", async () => {
    const knocking = room({
      participants: {
        [ALICE.userId]: seat("conn-alice"),
        [GUEST.userId]: seat("conn-guest", { kind: "guest" }),
      },
      knocks: { [EXT]: { name: "Ana Cliente", connectionId: "conn-ext", at: NOW } },
    });
    ddbMock.on(GetCommand, { TableName: ROOMS }).resolves({ Item: knocking });
    const admit = { signal: "admit", channelId: CH, callId: "room-1", userId: EXT, admit: true };
    await callAs(admit, BOB, "conn-bob"); // in the channel, not in the call
    await callAs(admit, GUEST, "conn-guest"); // in the call, but a guest
    expect(errors()).toEqual([
      ["conn-bob", "FORBIDDEN"],
      ["conn-guest", "FORBIDDEN"],
    ]);
    expect(updates()).toHaveLength(0);
  });

  it("lets the external in when someone in the call admits them", async () => {
    const entry = { name: "Ana Cliente", connectionId: "conn-ext", at: NOW };
    ddbMock
      .on(GetCommand, { TableName: ROOMS })
      .resolves({ Item: room({ knocks: { [EXT]: entry } }) });
    ddbMock.on(UpdateCommand, { TableName: ROOMS }).resolves({
      Attributes: room({ admitted: { [EXT]: entry } }),
    });
    await callAs({ signal: "admit", channelId: CH, callId: "room-1", userId: EXT, admit: true });
    expect(updates()[0]).toMatchObject({
      UpdateExpression: "SET admitted.#u = :k REMOVE knocks.#u",
      ConditionExpression: "roomId = :room AND knocks.#u.connectionId = :conn",
      ExpressionAttributeValues: { ":k": entry, ":conn": "conn-ext", ":room": "room-1" },
    });
    expect(ofType<CallLobbyEvent>("call.lobby")).toEqual([
      [
        "conn-ext",
        { type: "call.lobby", status: "admitted", channelId: CH, roomId: "room-1", userId: EXT },
      ],
    ]);
  });

  it("turns them away without letting them in", async () => {
    const entry = { name: "Ana Cliente", connectionId: "conn-ext", at: NOW };
    ddbMock
      .on(GetCommand, { TableName: ROOMS })
      .resolves({ Item: room({ knocks: { [EXT]: entry } }) });
    ddbMock.on(UpdateCommand, { TableName: ROOMS }).resolves({ Attributes: room() });
    await callAs({ signal: "admit", channelId: CH, callId: "room-1", userId: EXT, admit: false });
    expect(updates()[0]?.UpdateExpression).toBe("REMOVE knocks.#u");
    expect(ofType<CallLobbyEvent>("call.lobby").map(([, e]) => e.status)).toEqual(["denied"]);
  });
});

describe("joining as an external", () => {
  it("is refused until someone lets them in", async () => {
    await callAsExternal({ signal: "join", channelId: CH, media: "video" });
    expect(errors()).toEqual([["conn-ext", "FORBIDDEN"]]);
    expect(updates()).toHaveLength(0);
  });

  it("seats them, once admitted, in that call only, with an External badge", async () => {
    ddbMock.on(GetCommand, { TableName: ROOMS }).resolves({
      Item: room({ admitted: { [EXT]: { name: "Ana Cliente", connectionId: "conn-ext", at: 1 } } }),
    });
    ddbMock.on(UpdateCommand, { TableName: ROOMS }).resolves({
      Attributes: room({
        participants: {
          [ALICE.userId]: seat("conn-alice", { name: "Alice", joinedAt: NOW - 90_000 }),
          [EXT]: seat("conn-ext", { name: "Ana Cliente", kind: "external" }),
        },
      }),
    });
    await callAsExternal({ signal: "join", channelId: CH, media: "video" });
    const seatWrite = updates().find((u) => u.TableName === ROOMS)!;
    expect(seatWrite.ConditionExpression).toContain("attribute_exists(admitted.#u)");
    expect(seatWrite.ExpressionAttributeValues?.[":seat"]).toMatchObject({
      connectionId: "conn-ext",
      name: "Ana Cliente",
      kind: "external",
    });
    // No new call is ever started for them.
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    const joined = ofType<CallRoomEvent>("call.room").find(([id]) => id === "conn-ext")![1];
    expect(joined.room?.participants.map((p) => [p.name, p.kind])).toEqual([
      ["Alice", undefined],
      ["Ana Cliente", "external"],
    ]);
  });

  it("is told the call ended rather than starting one", async () => {
    ddbMock.on(GetCommand, { TableName: ROOMS }).resolves({});
    await callAsExternal({ signal: "join", channelId: CH, media: "video" });
    expect(ofType<CallLobbyEvent>("call.lobby").map(([, e]) => e.status)).toEqual(["ended"]);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("ends the call when the team leaves and only externals are left", async () => {
    ddbMock.on(UpdateCommand, { TableName: ROOMS }).resolves({
      Attributes: room({ participants: { [EXT]: seat("conn-ext", { kind: "external" }) } }),
    });
    await callAs({ signal: "leave", channelId: CH, callId: "room-1" });
    const del = ddbMock
      .commandCalls(DeleteCommand)
      .find((c) => c.args[0].input.TableName === ROOMS);
    expect(del?.args[0].input).toMatchObject({
      Key: { channelId: CH },
      ConditionExpression: "roomId = :room",
    });
    const ended = ofType<CallRoomEvent>("call.room");
    expect(ended.every(([, e]) => e.change === "ended" && e.room === null)).toBe(true);
    expect(ended.map(([id]) => id)).toContain("conn-ext");
  });
});

describe("sharing the link", () => {
  it("gives someone seated in the call the link: the same secret for everyone, until it ends", async () => {
    ddbMock.on(UpdateCommand, { TableName: ROOMS }).resolves({ Attributes: room() });
    await callAs({ signal: "link", channelId: CH, callId: "room-1" });
    expect(updates()[0]).toMatchObject({
      UpdateExpression:
        "SET linkToken = if_not_exists(linkToken, :t), knocks = if_not_exists(knocks, :e), " +
        "admitted = if_not_exists(admitted, :e)",
      ConditionExpression: "roomId = :room",
    });
    expect(ofType("call.link")).toEqual([
      [
        "conn-alice",
        { type: "call.link", channelId: CH, roomId: "room-1", token: encodeCallToken(CH, SECRET) },
      ],
    ]);
  });

  it("is refused to someone not in the call, or to a guest in it", async () => {
    await callAs({ signal: "link", channelId: CH, callId: "room-1" }, BOB, "conn-bob");
    ddbMock.on(GetCommand, { TableName: ROOMS }).resolves({
      Item: room({ participants: { [GUEST.userId]: seat("conn-guest", { kind: "guest" }) } }),
    });
    await callAs({ signal: "link", channelId: CH, callId: "room-1" }, GUEST, "conn-guest");
    expect(errors()).toEqual([
      ["conn-bob", "FORBIDDEN"],
      ["conn-guest", "FORBIDDEN"],
    ]);
    expect(ofType("call.link")).toEqual([]);
  });

  it("says so when the call ended between asking and making the link", async () => {
    ddbMock.on(UpdateCommand, { TableName: ROOMS }).rejects(ccf());
    await callAs({ signal: "link", channelId: CH, callId: "room-1" });
    expect(errors()).toEqual([["conn-alice", "CHANNEL_NOT_FOUND"]]);
  });
});

describe("an external's socket closing", () => {
  it("takes them out of the lobby (and their seat) without telling anyone they went offline", async () => {
    ddbMock.on(DeleteCommand, { TableName: CONNECTIONS }).resolves({
      Attributes: {
        connectionId: "conn-ext",
        userId: EXT,
        external: true,
        callScope: CH,
        callRoom: CH,
      },
    });
    ddbMock.on(UpdateCommand, { TableName: ROOMS }).resolves({ Attributes: room() });
    await disconnect(asExternal("$disconnect"));
    const exprs = updates()
      .filter((u) => u.TableName === ROOMS)
      .map((u) => u.UpdateExpression);
    expect(exprs).toContain("REMOVE #p.#u"); // their seat
    expect(exprs).toContain("REMOVE knocks.#u"); // their lobby spot
    expect(ofType("user.disconnected")).toEqual([]);
  });
});

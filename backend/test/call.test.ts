import { GoneException, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { DeleteCommand, GetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { compareIds, dmChannelId } from "@mindfultech/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../src/handlers/call";
import { ALICE, apiMock, BOB, ddbMock, resetMocks, sentEvents, wsEvent } from "./helpers";

const CAROL = { userId: "user-carol", email: "carol@example.com" };
const DM = dmChannelId(ALICE.userId, BOB.userId);

const connections = [
  { connectionId: "conn-alice", userId: ALICE.userId },
  { connectionId: "conn-alice-2", userId: ALICE.userId },
  { connectionId: "conn-bob", userId: BOB.userId },
  { connectionId: "conn-bob-2", userId: BOB.userId },
  { connectionId: "conn-carol", userId: CAROL.userId },
];

function call(body: Record<string, unknown>, user = ALICE, connectionId = "conn-alice") {
  return handler(
    wsEvent(
      "call",
      { action: "call", callId: "call-1", channelId: DM, to: BOB.userId, ...body },
      { user, connectionId },
    ),
  );
}

const recipients = () =>
  sentEvents()
    .map(([id]) => id)
    .sort(compareIds);

describe("call", () => {
  beforeEach(() => {
    resetMocks();
    ddbMock
      .on(ScanCommand, { TableName: "slack-test-connections" })
      .resolves({ Items: connections });
  });

  it("relays an offer to every connection of the callee, with the verified sender", async () => {
    const result = await call({ signal: "offer", media: "video", sdp: "v=0 offer", from: "spoof" });

    expect(result.statusCode).toBe(200);
    expect(recipients()).toEqual(["conn-bob", "conn-bob-2"]);
    expect(sentEvents()[0]?.[1]).toEqual({
      type: "call.offer",
      callId: "call-1",
      channelId: DM,
      from: ALICE.userId,
      media: "video",
      sdp: "v=0 offer",
    });
    // Signaling is relayed, never stored: no table but `connections` is touched.
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it("relays ICE candidates to the peer only", async () => {
    const candidate = { candidate: "candidate:1 1 udp 1 1.2.3.4 5 typ host", sdpMid: "0" };
    await call({ signal: "ice_candidate", candidate });

    expect(recipients()).toEqual(["conn-bob", "conn-bob-2"]);
    expect(sentEvents()[0]?.[1]).toMatchObject({ type: "call.ice_candidate", candidate });
  });

  it("fans a batch of ICE candidates out as one call.ice_candidate event each", async () => {
    const candidates = [
      { candidate: "candidate:1 1 udp 1 1.2.3.4 5 typ host", sdpMid: "0" },
      { candidate: "candidate:2 1 udp 1 5.6.7.8 9 typ srflx", sdpMid: "0" },
    ];
    await call({ signal: "ice_candidates", candidates });

    expect(recipients()).toEqual(["conn-bob", "conn-bob", "conn-bob-2", "conn-bob-2"]);
    const relayed = sentEvents()
      .filter(([id]) => id === "conn-bob")
      .map(([, event]) => event);
    expect(relayed).toEqual(
      candidates.map((candidate) =>
        expect.objectContaining({ type: "call.ice_candidate", from: ALICE.userId, candidate }),
      ),
    );
  });

  it("also tells the sender's other tabs when the call is answered, declined or ended", async () => {
    await call({ signal: "answer", sdp: "v=0 answer", to: ALICE.userId }, BOB, "conn-bob");
    expect(recipients()).toEqual(["conn-alice", "conn-alice-2", "conn-bob-2"]);
    expect(sentEvents()[0]?.[1]).toMatchObject({ type: "call.answer", from: BOB.userId });

    apiMock.resetHistory();
    await call({ signal: "decline", to: ALICE.userId }, BOB, "conn-bob");
    expect(recipients()).toEqual(["conn-alice", "conn-alice-2", "conn-bob-2"]);
    expect(sentEvents()[0]?.[1]).toMatchObject({ type: "call.decline", reason: "declined" });

    apiMock.resetHistory();
    await call({ signal: "end", reason: "no_answer" });
    expect(recipients()).toEqual(["conn-alice-2", "conn-bob", "conn-bob-2"]);
    expect(sentEvents()[0]?.[1]).toMatchObject({ type: "call.end", reason: "no_answer" });
  });

  it("relays ICE restarts to the peer only, never as a new call", async () => {
    await call({ signal: "renegotiate", kind: "offer", sdp: "v=0 restart", restart: 2 });
    expect(recipients()).toEqual(["conn-bob", "conn-bob-2"]);
    expect(sentEvents()[0]?.[1]).toEqual({
      type: "call.renegotiate",
      callId: "call-1",
      channelId: DM,
      from: ALICE.userId,
      kind: "offer",
      sdp: "v=0 restart",
      restart: 2,
    });

    // The peer offline (its socket is reconnecting): nothing comes back, the
    // sender re-sends until its 30-second limit.
    apiMock.resetHistory();
    ddbMock
      .on(ScanCommand, { TableName: "slack-test-connections" })
      .resolves({ Items: connections.filter((c) => c.userId !== BOB.userId) });
    await call({ signal: "renegotiate", kind: "offer", sdp: "v=0 restart", restart: 2 });
    expect(sentEvents()).toEqual([]);

    // Restart numbers start at 1.
    expect(
      (await call({ signal: "renegotiate", kind: "offer", sdp: "v=0", restart: 0 })).statusCode,
    ).toBe(400);
  });

  it("answers the caller with call.end 'unavailable' when the callee is offline", async () => {
    ddbMock
      .on(ScanCommand, { TableName: "slack-test-connections" })
      .resolves({ Items: connections.filter((c) => c.userId !== BOB.userId) });

    await call({ signal: "offer", media: "audio", sdp: "v=0" });

    expect(sentEvents()).toEqual([
      [
        "conn-alice",
        {
          type: "call.end",
          callId: "call-1",
          channelId: DM,
          from: BOB.userId,
          reason: "unavailable",
        },
      ],
    ]);
  });

  it("drops stale callee connections and reports unavailable if none was live", async () => {
    apiMock
      .on(PostToConnectionCommand)
      .rejects(new GoneException({ message: "gone", $metadata: {} }));
    apiMock.on(PostToConnectionCommand, { ConnectionId: "conn-alice" }).resolves({});

    await call({ signal: "offer", media: "audio", sdp: "v=0" });

    const deleted = ddbMock.commandCalls(DeleteCommand).map((c) => c.args[0].input.Key);
    expect(deleted).toEqual([{ connectionId: "conn-bob" }, { connectionId: "conn-bob-2" }]);
    expect(sentEvents().at(-1)).toEqual([
      "conn-alice",
      expect.objectContaining({ type: "call.end", reason: "unavailable" }),
    ]);
  });

  it("only allows calls between the two members of a DM", async () => {
    const forbidden = [
      call({ signal: "end", to: CAROL.userId }), // Carol is not in the DM
      call({ signal: "end", channelId: dmChannelId(BOB.userId, CAROL.userId) }, ALICE), // not mine
      call({ signal: "end", to: ALICE.userId }), // calling myself
    ];
    for (const result of await Promise.all(forbidden)) expect(result.statusCode).toBe(400);
    expect(sentEvents().map(([, e]) => e)).toEqual([
      expect.objectContaining({ type: "error", code: "FORBIDDEN" }),
      expect.objectContaining({ type: "error", code: "FORBIDDEN" }),
      expect.objectContaining({ type: "error", code: "FORBIDDEN" }),
    ]);
    expect(sentEvents().every(([id]) => id === "conn-alice")).toBe(true);
  });

  it("rejects calls outside DMs and malformed signals", async () => {
    const outside = await call({ signal: "end", channelId: "ch_general" });
    expect(outside.statusCode).toBe(400);
    expect(sentEvents()[0]?.[1]).toMatchObject({ code: "BAD_REQUEST" });

    apiMock.resetHistory();
    const malformed = await call({ signal: "offer", media: "video", sdp: "" });
    expect(malformed.statusCode).toBe(400);
    expect(recipients()).toEqual(["conn-alice"]);
    expect(sentEvents()[0]?.[1]).toMatchObject({ code: "BAD_REQUEST" });
  });
});

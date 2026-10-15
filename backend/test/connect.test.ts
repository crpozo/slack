import { DeleteCommand, PutCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handler as connect } from "../src/handlers/connect";
import { handler as disconnect } from "../src/handlers/disconnect";
import { ALICE, BOB, ddbMock, resetMocks, sentEvents, wsEvent } from "./helpers";

describe("connect", () => {
  beforeEach(resetMocks);

  it("stores the connection with a 2 h TTL", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    ddbMock.on(PutCommand).resolves({});

    const result = await connect(wsEvent("$connect"));

    expect(result.statusCode).toBe(200);
    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input).toEqual({
      TableName: "slack-test-connections",
      Item: {
        connectionId: "conn-alice",
        userId: ALICE.userId,
        userEmail: ALICE.email,
        connectedAt: 1_700_000_000_000,
        ttl: 1_700_000_000 + 7200,
        role: "member",
      },
    });
  });

  it("upserts the user directory without overwriting a chosen display name", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});

    await connect(wsEvent("$connect"));

    const input = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(input?.TableName).toBe("slack-test-users");
    expect(input?.Key).toEqual({ userId: ALICE.userId });
    expect(input?.UpdateExpression).toContain("displayName = if_not_exists(displayName, :name)");
    expect(input?.ExpressionAttributeValues).toEqual({
      ":email": ALICE.email,
      ":role": "member",
      ":name": "alice",
      ":now": 1_700_000_000_000,
    });
  });

  it("still connects if the directory upsert fails", async () => {
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).rejects(new Error("throttled"));
    const result = await connect(wsEvent("$connect"));
    expect(result.statusCode).toBe(200);
  });

  it("rejects a connection without authorizer context", async () => {
    const result = await connect(wsEvent("$connect", undefined, { user: null }));
    expect(result.statusCode).toBe(401);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("announces user.connected to every other connection", async () => {
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(ScanCommand).resolves({
      Items: [
        { connectionId: "conn-alice", userId: ALICE.userId },
        { connectionId: "conn-alice-2", userId: ALICE.userId },
        { connectionId: "conn-bob", userId: BOB.userId },
      ],
    });

    await connect(wsEvent("$connect"));

    // Not the connection being opened: it can't receive anything until $connect returns.
    expect(sentEvents()).toEqual([
      ["conn-alice-2", { type: "user.connected", userId: ALICE.userId }],
      ["conn-bob", { type: "user.connected", userId: ALICE.userId }],
    ]);
  });

  it("still connects if the presence broadcast fails", async () => {
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(ScanCommand).rejects(new Error("throttled"));
    expect((await connect(wsEvent("$connect"))).statusCode).toBe(200);
  });

  it("returns 500 if DynamoDB fails", async () => {
    ddbMock.on(PutCommand).rejects(new Error("boom"));
    const result = await connect(wsEvent("$connect"));
    expect(result.statusCode).toBe(500);
  });
});

describe("disconnect", () => {
  beforeEach(resetMocks);

  it("deletes the connection", async () => {
    ddbMock.on(DeleteCommand).resolves({});

    const result = await disconnect(wsEvent("$disconnect"));

    expect(result.statusCode).toBe(200);
    expect(ddbMock.commandCalls(DeleteCommand)[0]?.args[0].input).toEqual({
      TableName: "slack-test-connections",
      Key: { connectionId: "conn-alice" },
      ReturnValues: "ALL_OLD",
    });
  });

  it("still succeeds if the delete fails (TTL cleans up)", async () => {
    ddbMock.on(DeleteCommand).rejects(new Error("boom"));
    const result = await disconnect(wsEvent("$disconnect"));
    expect(result.statusCode).toBe(200);
  });
});

describe("disconnect presence", () => {
  beforeEach(() => {
    resetMocks();
    ddbMock.on(DeleteCommand).resolves({ Attributes: { userId: ALICE.userId } });
  });

  it("announces user.disconnected when it was the user's last connection", async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [{ connectionId: "conn-bob", userId: BOB.userId }] });

    await disconnect(wsEvent("$disconnect"));

    expect(ddbMock.commandCalls(ScanCommand)[0]?.args[0].input.ConsistentRead).toBe(true);
    expect(sentEvents()).toEqual([
      ["conn-bob", { type: "user.disconnected", userId: ALICE.userId }],
    ]);
  });

  it("stays quiet while the user has another tab or device open", async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        { connectionId: "conn-alice-2", userId: ALICE.userId },
        { connectionId: "conn-bob", userId: BOB.userId },
      ],
    });

    await disconnect(wsEvent("$disconnect"));

    expect(sentEvents()).toEqual([]);
  });

  it("falls back to the deleted row when there is no authorizer context", async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [{ connectionId: "conn-bob", userId: BOB.userId }] });

    await disconnect(wsEvent("$disconnect", undefined, { user: null }));

    expect(sentEvents()).toEqual([
      ["conn-bob", { type: "user.disconnected", userId: ALICE.userId }],
    ]);
  });
});

describe("connect as a guest", () => {
  it("stores the guest role on the connection and the directory row", async () => {
    resetMocks();
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    await connect(wsEvent("$connect", undefined, { user: { ...ALICE, role: "guest" } }));
    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item?.role).toBe("guest");
    expect(
      ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input.ExpressionAttributeValues?.[":role"],
    ).toBe("guest");
  });
});

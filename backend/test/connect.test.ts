import { DeleteCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handler as connect } from "../src/handlers/connect";
import { handler as disconnect } from "../src/handlers/disconnect";
import { ALICE, ddbMock, resetMocks, wsEvent } from "./helpers";

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
      },
    });
  });

  it("rejects a connection without authorizer context", async () => {
    const result = await connect(wsEvent("$connect", undefined, { user: null }));
    expect(result.statusCode).toBe(401);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
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
    });
  });

  it("still succeeds if the delete fails (TTL cleans up)", async () => {
    ddbMock.on(DeleteCommand).rejects(new Error("boom"));
    const result = await disconnect(wsEvent("$disconnect"));
    expect(result.statusCode).toBe(200);
  });
});

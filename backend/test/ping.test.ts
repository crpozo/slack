import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handler } from "../src/handlers/ping";
import { apiMock, ddbMock, resetMocks, wsEvent } from "./helpers";

const ping = (body: unknown) => handler(wsEvent("ping", body));

describe("ping", () => {
  beforeEach(() => {
    resetMocks();
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    ddbMock.on(UpdateCommand).resolves({});
  });

  it("answers 200 without replying or touching any table when it carries no activity", async () => {
    expect(await ping({ action: "ping" })).toEqual({ statusCode: 200 });
    expect(await ping("not json")).toEqual({ statusCode: 200 });
    expect(apiMock.calls()).toHaveLength(0);
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it("stamps activeAt on the caller's own connection while active, clears it when not", async () => {
    await ping({ action: "ping", active: true });
    await ping({ action: "ping", active: false });

    const [on, off] = ddbMock.commandCalls(UpdateCommand).map((c) => c.args[0].input);
    expect(on).toMatchObject({
      Key: { connectionId: "conn-alice" },
      UpdateExpression: "SET activeAt = :now",
      ConditionExpression: "attribute_exists(connectionId)",
      ExpressionAttributeValues: { ":now": 1_700_000_000_000 },
    });
    expect(off).toMatchObject({
      Key: { connectionId: "conn-alice" },
      UpdateExpression: "REMOVE activeAt",
    });
    expect(off?.ExpressionAttributeValues).toBeUndefined();
    expect(apiMock.calls()).toHaveLength(0);
  });

  it("never fails the frame, e.g. for a connection that is already gone", async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: "gone", $metadata: {} }));
    expect(await ping({ action: "ping", active: true })).toEqual({ statusCode: 200 });
    ddbMock.on(UpdateCommand).rejects(new Error("throttled"));
    expect(await ping({ action: "ping", active: true })).toEqual({ statusCode: 200 });
  });
});

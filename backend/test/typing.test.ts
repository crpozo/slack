import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../src/handlers/typing";
import {
  ALICE,
  BOB,
  ddbMock,
  GENERAL,
  mockChannels,
  privateRow,
  resetMocks,
  sentEvents,
  wsEvent,
} from "./helpers";

const typing = (channelId = "ch_general") =>
  handler(wsEvent("typing", { action: "typing", channelId }));

describe("typing", () => {
  beforeEach(() => {
    resetMocks();
    mockChannels(GENERAL, privateRow("ch_team", BOB.userId, [BOB.userId]));
    ddbMock.on(ScanCommand).resolves({
      Items: [
        { connectionId: "conn-alice", userId: ALICE.userId },
        { connectionId: "conn-alice-2", userId: ALICE.userId },
        { connectionId: "conn-bob", userId: BOB.userId },
      ],
    });
  });

  it("tells everyone else in the channel, never the typist's own tabs", async () => {
    expect((await typing()).statusCode).toBe(200);
    expect(sentEvents()).toEqual([
      ["conn-bob", { type: "user.typing", channelId: "ch_general", userId: ALICE.userId }],
    ]);
  });

  it("answers CHANNEL_NOT_FOUND for channels the caller can't see", async () => {
    await typing("ch_team");
    expect(sentEvents()).toMatchObject([
      ["conn-alice", { type: "error", code: "CHANNEL_NOT_FOUND" }],
    ]);
  });
});

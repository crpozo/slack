import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
  UserNotFoundException,
} from "@aws-sdk/client-cognito-identity-provider";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { QueryCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { ChannelListEvent } from "@mindfultech/shared";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { handler as call } from "../src/handlers/call";
import { handler as channel } from "../src/handlers/channel";
import { handler as history } from "../src/handlers/history";
import { handler as pin } from "../src/handlers/pin";
import { handler as tasks } from "../src/handlers/tasks";
import { handler as typing } from "../src/handlers/typing";
import { deliver } from "../src/lib/broadcast";
import type { HttpEvent } from "../src/lib/http";
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

// ---------------------------------------------------------------------------
// Phase 55: externals (guest accounts) in private channels. They see the
// private channels they were invited to and nothing else of the team's chat.
// ---------------------------------------------------------------------------

const cognitoMock = mockClient(CognitoIdentityProviderClient);
const GUEST = { userId: "user-guest", email: "client@acme.com", role: "guest" };
const asGuest = { user: GUEST, connectionId: "conn-guest" };
/** A client's channel: Alice created it, Bob and the external are in it. */
const CLIENT = privateRow("ch_client", ALICE.userId, [ALICE.userId, BOB.userId, GUEST.userId]);
/** A team-only private channel. */
const TEAM = privateRow("ch_team", ALICE.userId, [ALICE.userId, BOB.userId]);

const CONNECTIONS = [
  { connectionId: "conn-alice", userId: ALICE.userId },
  { connectionId: "conn-bob", userId: BOB.userId },
  { connectionId: "conn-guest", userId: GUEST.userId, role: "guest" },
];

beforeEach(() => {
  resetMocks();
  cognitoMock.reset();
  mockChannels(GENERAL, CLIENT, TEAM);
  ddbMock.on(ScanCommand, { TableName: "slack-test-connections" }).resolves({ Items: CONNECTIONS });
  ddbMock
    .on(ScanCommand, { TableName: "slack-test-channels" })
    .resolves({ Items: [GENERAL, CLIENT, TEAM] });
});

const toGuest = () => sentEvents().filter(([id]) => id === "conn-guest");

describe("what reaches an external", () => {
  it("their channel's events, never presence or anyone's profile", async () => {
    const live = CONNECTIONS as Parameters<typeof deliver>[0];
    await deliver(live, () => ({ type: "user.connected", userId: BOB.userId }));
    await deliver(live, () => ({
      type: "user.typing",
      channelId: "ch_client",
      userId: BOB.userId,
    }));
    expect(toGuest().map(([, e]) => e.type)).toEqual(["user.typing"]);
  });

  it("typing in #general or a team channel never reaches them; in their channel it does", async () => {
    await typing(wsEvent("typing", { action: "typing", channelId: "ch_general" }));
    await typing(wsEvent("typing", { action: "typing", channelId: "ch_team" }));
    expect(toGuest()).toEqual([]);
    await typing(wsEvent("typing", { action: "typing", channelId: "ch_client" }));
    expect(toGuest()).toEqual([
      ["conn-guest", { type: "user.typing", channelId: "ch_client", userId: ALICE.userId }],
    ]);
  });

  it("their channel list is only the private channels they're in", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] }); // unread counts
    await channel(wsEvent("channel", { action: "channel", op: "list" }, asGuest));
    const [[, event]] = sentEvents() as [[string, ChannelListEvent]];
    expect(event.channels.map((c) => c.channelId)).toEqual(["ch_client"]);
  });
});

describe("what an external may do", () => {
  it("type in their channel, never in #general or a team channel", async () => {
    await typing(wsEvent("typing", { action: "typing", channelId: "ch_client" }, asGuest));
    expect(
      sentEvents()
        .map(([id]) => id)
        .sort(),
    ).toEqual(["conn-alice", "conn-bob"]);
    for (const channelId of ["ch_general", "ch_team"]) {
      await typing(wsEvent("typing", { action: "typing", channelId }, asGuest));
      expect(sentEvents().at(-1)).toEqual([
        "conn-guest",
        expect.objectContaining({ type: "error", code: "CHANNEL_NOT_FOUND" }),
      ]);
    }
  });

  it("never read #general's history", async () => {
    await history(wsEvent("history", { action: "history", channelId: "ch_general" }, asGuest));
    expect(sentEvents().at(-1)?.[1]).toMatchObject({ type: "error", code: "CHANNEL_NOT_FOUND" });
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it("never call or pin: those routes stay closed before any handler runs", async () => {
    await call(wsEvent("call", { action: "call", signal: "rooms" }, asGuest));
    await pin(
      wsEvent(
        "pin",
        { action: "pin", channelId: "ch_client", sk: "1#a", messageId: "a", pinned: true },
        asGuest,
      ),
    );
    expect(sentEvents()).toEqual([
      ["conn-guest", expect.objectContaining({ type: "error", code: "FORBIDDEN" })],
      ["conn-guest", expect.objectContaining({ type: "error", code: "FORBIDDEN" })],
    ]);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});

describe("removing someone from a private channel", () => {
  const remove = (userId: string, user: object = ALICE) =>
    channel(
      wsEvent(
        "channel",
        { action: "channel", op: "remove", channelId: "ch_client", userId },
        { user: user as typeof ALICE },
      ),
    );

  it("the creator takes an external out: they lose the channel at once", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock
      .on(ScanCommand, { TableName: "slack-test-channels" })
      .resolves({ Items: [GENERAL, { ...CLIENT, members: [ALICE.userId, BOB.userId] }] });
    await remove(GUEST.userId);
    const update = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(update?.ExpressionAttributeValues?.[":members"]).toEqual([ALICE.userId, BOB.userId]);
    expect(update?.ConditionExpression).toBe("#type = :private AND members = :before");
    const lists = toGuest() as Array<[string, ChannelListEvent]>;
    expect(lists).toHaveLength(1);
    expect(lists[0]?.[1].channels).toEqual([]);
  });

  it("an admin in it may too; another member, or anyone removing the creator, may not", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await remove(GUEST.userId, BOB);
    expect(sentEvents().at(-1)?.[1]).toMatchObject({ code: "FORBIDDEN" });
    await remove(ALICE.userId, { ...BOB, role: "admin" });
    expect(sentEvents().at(-1)?.[1]).toMatchObject({ code: "FORBIDDEN" });
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    await remove(GUEST.userId, { ...BOB, role: "admin" });
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);
  });

  it("reads the list again when another change landed first", async () => {
    ddbMock
      .on(UpdateCommand)
      .rejectsOnce(new ConditionalCheckFailedException({ message: "changed", $metadata: {} }))
      .resolves({});
    await remove(GUEST.userId);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(2);
    expect(sentEvents().some(([, e]) => e.type === "error")).toBe(false);
  });
});

describe("inviting an external by email", () => {
  function request(
    body: unknown,
    user: { userId: string; email: string } = ALICE,
    groups?: string,
  ) {
    return {
      version: "2.0",
      routeKey: "POST /channels/{channelId}/invites",
      rawPath: "/channels/ch_client/invites",
      headers: {},
      pathParameters: { channelId: "ch_client" },
      body: JSON.stringify(body),
      isBase64Encoded: false,
      requestContext: {
        http: { method: "POST", path: "/channels/ch_client/invites" },
        authorizer: {
          jwt: {
            claims: {
              sub: user.userId,
              email: user.email,
              ...(groups && { "cognito:groups": groups }),
            },
            scopes: [],
          },
        },
      },
    } as unknown as HttpEvent;
  }
  const invite = async (...args: Parameters<typeof request>) => {
    const r = (await tasks(request(...args))) as { statusCode: number; body: string };
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : undefined };
  };

  beforeEach(() => {
    mockChannels(GENERAL, TEAM, { ...CLIENT, members: [ALICE.userId, BOB.userId] });
    ddbMock.on(UpdateCommand, { TableName: "slack-test-channels" }).resolves({});
    ddbMock.on(UpdateCommand, { TableName: "slack-test-users" }).resolves({
      Attributes: {
        userId: GUEST.userId,
        email: GUEST.email,
        role: "guest",
        displayName: "client",
      },
    });
  });

  it("creates a guest account, adds it to the channel, and only the team hears about the new profile", async () => {
    cognitoMock
      .on(AdminGetUserCommand)
      .rejects(new UserNotFoundException({ message: "no", $metadata: {} }));
    cognitoMock.on(AdminCreateUserCommand).resolves({
      User: { Attributes: [{ Name: "sub", Value: GUEST.userId }] },
    });
    cognitoMock.on(AdminAddUserToGroupCommand).resolves({});

    const { status, body } = await invite({ email: " Client@ACME.com " });

    expect(status).toBe(200);
    expect(body.invited).toEqual({ userId: GUEST.userId, role: "guest", created: true });
    expect(cognitoMock.commandCalls(AdminAddUserToGroupCommand)[0]?.args[0].input.GroupName).toBe(
      "guests",
    );
    const add = ddbMock.commandCalls(UpdateCommand, { TableName: "slack-test-channels" })[0]
      ?.args[0].input;
    expect(add?.UpdateExpression).toBe("SET members = list_append(members, :new)");
    expect(add?.ExpressionAttributeValues?.[":new"]).toEqual([GUEST.userId]);
    // The new profile (so the team sees "External"): never sent to a guest.
    const profiles = sentEvents().filter(([, e]) => e.type === "user.updated");
    expect(profiles.map(([id]) => id).sort()).toEqual(["conn-alice", "conn-bob"]);
    // The external's own list: only the client channel.
    const theirs = toGuest().find(([, e]) => e.type === "channel.list")?.[1] as ChannelListEvent;
    expect(theirs.channels.map((c) => c.channelId)).toEqual(["ch_client"]);
  });

  it("only the creator or an admin, never a guest, only private channels, a valid email", async () => {
    expect((await invite({ email: "x@y.ec" }, BOB)).status).toBe(403);
    expect((await invite({ email: "x@y.ec" }, GUEST, "[guests]")).status).toBe(403);
    expect((await invite({ email: "not-an-email" })).status).toBe(400);
    // Carol isn't in the channel: as if it didn't exist.
    expect(
      (await invite({ email: "x@y.ec" }, { userId: "user-carol", email: "c@x.ec" })).status,
    ).toBe(404);
    expect(cognitoMock.calls()).toHaveLength(0);
  });
});

describe("the team's AI and calls stay closed to externals", () => {
  it("AI Notes and call clips answer 403 to a guest before any lookup", async () => {
    const { handler: notes } = await import("../src/handlers/call-notes");
    const { handler: clips } = await import("../src/handlers/call-transcribe");
    const event = (routeKey: string) =>
      ({
        version: "2.0",
        routeKey,
        rawPath: "/",
        headers: {},
        pathParameters: { callId: "c1" },
        isBase64Encoded: false,
        requestContext: {
          http: { method: routeKey.split(" ")[0], path: "/" },
          authorizer: {
            jwt: {
              claims: { sub: GUEST.userId, email: GUEST.email, "cognito:groups": "[guests]" },
              scopes: [],
            },
          },
        },
      }) as unknown as HttpEvent;
    for (const [fn, route] of [
      [notes, "GET /notes"],
      [notes, "POST /notes/{callId}/ask"],
      [clips, "POST /calls/{callId}/clips"],
    ] as const) {
      const r = (await fn(event(route))) as { statusCode: number };
      expect(r.statusCode).toBe(403);
    }
    expect(ddbMock.calls()).toHaveLength(0);
  });
});

describe("Vault cards never reach an external with their details", () => {
  const card = {
    messageId: "m1",
    channelId: "ch_client",
    sk: "1#m1",
    userId: ALICE.userId,
    userEmail: ALICE.email,
    text: "🔒 Shared a Secret: AWS root",
    attachments: [],
    createdAt: 1,
    reactions: {},
    kind: "vault" as const,
    vault: { secretId: "vs_1", name: "AWS root", username: "admin@aws" },
  };

  it("live: the team gets the card, the external only a line", async () => {
    await deliver(CONNECTIONS as Parameters<typeof deliver>[0], () => ({
      type: "message.new",
      message: card,
      clientId: "",
    }));
    const byConn = new Map(sentEvents().map(([id, e]) => [id, JSON.stringify(e)]));
    expect(byConn.get("conn-alice")).toContain("admin@aws");
    expect(byConn.get("conn-guest")).not.toContain("admin@aws");
    expect(byConn.get("conn-guest")).not.toContain("AWS root");
    expect(byConn.get("conn-guest")).toContain("A secret shared with the MindfulTech team");
  });

  it("in history too", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [card] });
    await history(wsEvent("history", { action: "history", channelId: "ch_client" }, asGuest));
    const page = JSON.stringify(sentEvents().at(-1)?.[1]);
    expect(page).toContain("history.page");
    expect(page).not.toContain("AWS root");
    expect(page).not.toContain("admin@aws");
  });
});

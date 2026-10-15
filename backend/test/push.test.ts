import { GetParameterCommand, ParameterNotFound, SSMClient } from "@aws-sdk/client-ssm";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { dmChannelId, type Channel, type Message } from "@mindfultech/shared";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import webpush, { WebPushError } from "web-push";
import { handler } from "../src/handlers/push";
import type { HttpEvent } from "../src/lib/http";
import { notifyOffline, pushRecipients } from "../src/lib/notify";
import { endpointKey, sendPush } from "../src/lib/push";
import { resetVapidCache } from "../src/lib/vapid";
import { ALICE, BOB, ddbMock, dmRow, GENERAL, privateRow, resetMocks } from "./helpers";

vi.mock("web-push", async (importOriginal) => {
  const actual = await importOriginal<{ default: Record<string, unknown> }>();
  return { ...actual, default: { ...actual.default, sendNotification: vi.fn() } };
});
const sendNotification = vi.mocked(webpush.sendNotification);

const ssmMock = mockClient(SSMClient);
const VAPID = { publicKey: "BPub", privateKey: "priv", subject: "mailto:ops@example.com" };
const PUSH = "slack-test-push";
const CAROL = { userId: "user-carol", email: "carol@example.com" };
const subscription = (n = 1) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/device-${n}`,
  expirationTime: null,
  keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA", auth: "tBHItJI5svbpez7KI4CCXg" },
});

function request(routeKey: string, body?: unknown, user = ALICE): HttpEvent {
  return {
    routeKey,
    headers: { "user-agent": "Mozilla/5.0 Test" },
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: {
      authorizer: { jwt: { claims: { sub: user.userId, email: user.email }, scopes: [] } },
    },
  } as unknown as HttpEvent;
}
const call = async (routeKey: string, body?: unknown) => {
  const r = (await handler(request(routeKey, body))) as { statusCode: number; body: string };
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : undefined };
};

const message = (channelId: string, text: string, userId = ALICE.userId): Message => ({
  messageId: "m1",
  channelId,
  sk: "1#m1",
  userId,
  userEmail: userId === ALICE.userId ? ALICE.email : BOB.email,
  text,
  attachments: [],
  createdAt: 1,
});

beforeEach(() => {
  resetMocks();
  ssmMock.reset();
  resetVapidCache();
  sendNotification.mockReset();
  sendNotification.mockResolvedValue({ statusCode: 201, body: "", headers: {} });
  ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: JSON.stringify(VAPID) } });
  ddbMock.on(PutCommand).resolves({});
  ddbMock.on(DeleteCommand).resolves({});
  ddbMock.on(QueryCommand).resolves({ Items: [] });
  ddbMock.on(GetCommand, { TableName: "slack-test-users" }).resolves({
    Item: { displayName: "Alicia" },
  });
});

describe("push HTTP API", () => {
  it("serves the public key, read decrypted from the one SSM parameter", async () => {
    const { status, body } = await call("GET /push/key");
    expect(status).toBe(200);
    expect(body).toEqual({ publicKey: "BPub" }); // never the private key
    expect(ssmMock.commandCalls(GetParameterCommand)[0]?.args[0].input).toEqual({
      Name: "/slack/test/vapid",
      WithDecryption: true,
    });
  });

  it("answers 503 while the stage has no VAPID keys", async () => {
    ssmMock.on(GetParameterCommand).rejects(new ParameterNotFound({ message: "x", $metadata: {} }));
    expect((await call("GET /push/key")).status).toBe(503);
  });

  it("saves the caller's subscription keyed by a hash of its endpoint", async () => {
    const { status } = await call("POST /push/subscribe", { subscription: subscription() });
    expect(status).toBe(204);
    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input).toMatchObject({
      TableName: PUSH,
      Item: {
        userId: ALICE.userId,
        sk: endpointKey(subscription().endpoint),
        subscription: subscription(),
        userAgent: "Mozilla/5.0 Test",
      },
    });
  });

  it("refuses endpoints that aren't browser push services (no SSRF)", async () => {
    const evil = { ...subscription(), endpoint: "https://169.254.169.254/latest/meta-data" };
    const { status, body } = await call("POST /push/subscribe", { subscription: evil });
    expect(status).toBe(400);
    expect(body.message).toMatch(/push service/);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("removes only the caller's own subscription", async () => {
    const endpoint = subscription().endpoint;
    expect((await call("DELETE /push/subscribe", { endpoint })).status).toBe(204);
    expect(ddbMock.commandCalls(DeleteCommand)[0]?.args[0].input.Key).toEqual({
      userId: ALICE.userId,
      sk: endpointKey(endpoint),
    });
  });
});

describe("sendPush", () => {
  const payload = {
    title: "Alicia",
    body: "hi",
    url: "/app/x",
    tag: "dm_a_b",
    sound: "default" as const,
  };

  it("sends to every device of each user with the VAPID keys", async () => {
    ddbMock.on(QueryCommand, { TableName: PUSH }).resolves({
      Items: [
        { userId: BOB.userId, sk: "a", subscription: subscription(1), createdAt: 1 },
        { userId: BOB.userId, sk: "b", subscription: subscription(2), createdAt: 1 },
      ],
    });

    expect(await sendPush([BOB.userId], payload)).toBe(2);

    expect(sendNotification).toHaveBeenCalledTimes(2);
    const [sub, body, options] = sendNotification.mock.calls[0]!;
    expect(sub).toEqual(subscription(1));
    expect(JSON.parse(String(body))).toEqual(payload);
    expect(options).toMatchObject({ vapidDetails: VAPID, TTL: 3600, urgency: "high" });
  });

  it("deletes subscriptions the push service reports gone, and never throws", async () => {
    ddbMock.on(QueryCommand, { TableName: PUSH }).resolves({
      Items: [{ userId: BOB.userId, sk: "a", subscription: subscription(), createdAt: 1 }],
    });
    sendNotification.mockRejectedValue(new WebPushError("Gone", 410, {}, "", "x"));

    expect(await sendPush([BOB.userId], payload)).toBe(0);
    expect(ddbMock.commandCalls(DeleteCommand)[0]?.args[0].input).toEqual({
      TableName: PUSH,
      Key: { userId: BOB.userId, sk: endpointKey(subscription().endpoint) },
    });
  });

  it("skips stored rows whose endpoint isn't allowed", async () => {
    ddbMock.on(QueryCommand, { TableName: PUSH }).resolves({
      Items: [
        {
          userId: BOB.userId,
          sk: "a",
          subscription: { ...subscription(), endpoint: "https://evil.example.com/x" },
          createdAt: 1,
        },
      ],
    });
    expect(await sendPush([BOB.userId], payload)).toBe(0);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("does nothing when push isn't configured", async () => {
    ssmMock.on(GetParameterCommand).rejects(new ParameterNotFound({ message: "x", $metadata: {} }));
    expect(await sendPush([BOB.userId], payload)).toBe(0);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });
});

describe("push recipients", () => {
  const users = [
    { userId: ALICE.userId, email: ALICE.email, displayName: "Alicia" },
    { userId: BOB.userId, email: BOB.email, displayName: "Bob Builder" },
    { userId: CAROL.userId, email: CAROL.email, displayName: "Carol" },
  ];
  beforeEach(() => {
    ddbMock.on(ScanCommand, { TableName: "slack-test-users" }).resolves({ Items: users });
  });

  it("is the other person of a DM", async () => {
    const dm = dmRow(ALICE.userId, BOB.userId);
    expect(await pushRecipients(dm, message(dm.channelId, "hey"))).toEqual([BOB.userId]);
  });

  it("is the members a channel message @mentions, by display name or email prefix", async () => {
    const recipients = await pushRecipients(
      GENERAL,
      message("ch_general", "@bobbuilder and @carol, not @alicia (me) or @nobody"),
    );
    expect(recipients.sort()).toEqual([BOB.userId, CAROL.userId].sort());
    expect(
      await pushRecipients(GENERAL, message("ch_general", "ping @bob")), // email local part
    ).toEqual([BOB.userId]);
  });

  it("is every other member of a private channel, mention or not, and nobody outside it", async () => {
    const secret = privateRow("ch_secret", ALICE.userId, [ALICE.userId, BOB.userId]);
    expect(await pushRecipients(secret, message("ch_secret", "@carol @bob"))).toEqual([BOB.userId]);
    expect(await pushRecipients(secret, message("ch_secret", "no mentions"))).toEqual([BOB.userId]);
  });

  it("reads no users for a public message without mentions", async () => {
    ddbMock.resetHistory();
    expect(await pushRecipients(GENERAL, message("ch_general", "no mentions"))).toEqual([]);
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(0);
  });
});

describe("notifyOffline", () => {
  const dm: Channel = dmRow(ALICE.userId, BOB.userId);
  beforeEach(() => {
    ddbMock.on(QueryCommand, { TableName: PUSH }).resolves({
      Items: [{ userId: BOB.userId, sk: "a", subscription: subscription(), createdAt: 1 }],
    });
  });

  it("pushes a DM to an offline peer with the sender, a preview and a link", async () => {
    await notifyOffline(
      dm,
      message(dm.channelId, `  hello\n${"x".repeat(200)}`),
      new Set([ALICE.userId]),
    );

    const payload = JSON.parse(String(sendNotification.mock.calls[0]?.[1]));
    expect(payload).toMatchObject({
      title: "Alicia",
      url: `/app/${encodeURIComponent(dmChannelId(ALICE.userId, BOB.userId))}`,
      tag: dm.channelId,
      sound: "default",
    });
    expect(payload.body).toHaveLength(120);
    expect(payload.body.startsWith("hello x")).toBe(true);
    expect(payload.body.endsWith("…")).toBe(true);
  });

  it("doesn't push to someone who is active in the app", async () => {
    await notifyOffline(dm, message(dm.channelId, "hi"), new Set([ALICE.userId, BOB.userId]));
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("says a voice message is a voice message", async () => {
    await notifyOffline(
      dm,
      {
        ...message(dm.channelId, ""),
        attachments: [
          { key: "k", name: "voice-x.m4a", size: 9, contentType: "audio/mp4", durationMs: 3000 },
        ],
      },
      new Set(),
    );
    expect(JSON.parse(String(sendNotification.mock.calls[0]?.[1])).body).toBe("🎤 Voice message");
  });

  it("titles channel notifications with the channel name", async () => {
    ddbMock.on(ScanCommand, { TableName: "slack-test-users" }).resolves({
      Items: [{ userId: BOB.userId, email: BOB.email, displayName: "Bob" }],
    });
    await notifyOffline(GENERAL, message("ch_general", "@bob look"), new Set());
    expect(JSON.parse(String(sendNotification.mock.calls[0]?.[1])).title).toBe(
      "Alicia in #general",
    );
  });
});

describe("activeUserIds", () => {
  it("counts only connections that reported activity within the window", async () => {
    const { activeUserIds } = await import("../src/lib/broadcast");
    const { ACTIVE_WINDOW_MS } = await import("@mindfultech/shared");
    const now = 1_700_000_000_000;
    const active = activeUserIds(
      [
        { connectionId: "a", userId: "alice", activeAt: now - 1000 },
        // Open in the background (desktop app, sleeping iPhone): still gets pushes.
        { connectionId: "b", userId: "bob" },
        { connectionId: "c", userId: "carol", activeAt: now - ACTIVE_WINDOW_MS },
      ],
      now,
    );
    expect([...active]).toEqual(["alice"]);
  });
});

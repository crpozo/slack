import {
  DecryptCommand,
  EncryptCommand,
  InvalidCiphertextException,
  KMSClient,
} from "@aws-sdk/client-kms";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import type { Message, VaultSecret } from "@mindfultech/shared";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../src/handlers/vault";
import type { HttpEvent } from "../src/lib/http";
import type { VaultRow } from "../src/lib/vault";
import {
  ALICE,
  BOB,
  ddbMock,
  GENERAL,
  mockChannels,
  privateRow,
  resetMocks,
  sentEvents,
} from "./helpers";

const VAULT = "slack-test-vault";
const KEY = "arn:aws:kms:us-east-1:123456789012:key/test-vault-key";
const CAROL = { userId: "user-carol", email: "carol@example.com" };
const ADMIN = { userId: "user-admin", email: "admin@example.com" };
const PROJECT = privateRow("ch_project", ALICE.userId, [ALICE.userId, BOB.userId]);
const ARCHIVED = { ...privateRow("ch_old", ALICE.userId, [ALICE.userId]), archived: true };

// --- KMS, faked: a "ciphertext" that only decrypts with the context it was made with ---

const kmsMock = mockClient(KMSClient);
function fakeKms() {
  kmsMock.reset();
  kmsMock.on(EncryptCommand).callsFake(({ Plaintext, EncryptionContext, KeyId }) => ({
    KeyId,
    CiphertextBlob: Buffer.from(
      JSON.stringify({
        key: KeyId,
        ctx: EncryptionContext,
        // Reversed base64: nothing a test could mistake for the plaintext.
        data: Buffer.from(Plaintext as Uint8Array)
          .toString("base64")
          .split("")
          .reverse()
          .join(""),
      }),
    ),
  }));
  kmsMock.on(DecryptCommand).callsFake(({ CiphertextBlob, EncryptionContext, KeyId }) => {
    const blob = JSON.parse(Buffer.from(CiphertextBlob as Uint8Array).toString("utf8")) as {
      key: string;
      ctx: Record<string, string>;
      data: string;
    };
    if (blob.key !== KeyId || JSON.stringify(blob.ctx) !== JSON.stringify(EncryptionContext)) {
      throw new InvalidCiphertextException({ message: "context mismatch", $metadata: {} });
    }
    return { Plaintext: Buffer.from(blob.data.split("").reverse().join(""), "base64") };
  });
}

// --- An in-memory vault table (and its byChannel index) behind the DynamoDB mock ---------

let table: Map<string, VaultRow>;
const INDEX_FIELDS = [
  "secretId",
  "channelId",
  "name",
  "username",
  "website",
  "createdBy",
  "createdByName",
  "createdAt",
];
const projected = (row: VaultRow) =>
  Object.fromEntries(Object.entries(row).filter(([k]) => INDEX_FIELDS.includes(k)));
let messages: Message[];

function fakeTables() {
  table = new Map();
  messages = [];
  ddbMock.on(PutCommand, { TableName: VAULT }).callsFake(({ Item }: { Item: VaultRow }) => {
    table.set(Item.secretId, structuredClone(Item));
    return {};
  });
  ddbMock.on(GetCommand, { TableName: VAULT }).callsFake(({ Key }: { Key: VaultRow }) => ({
    Item: table.get(Key.secretId),
  }));
  ddbMock.on(DeleteCommand, { TableName: VAULT }).callsFake(({ Key }: { Key: VaultRow }) => {
    table.delete(Key.secretId);
    return {};
  });
  ddbMock
    .on(QueryCommand, { TableName: VAULT, IndexName: "byChannel" })
    .callsFake(
      ({ ExpressionAttributeValues: v }: { ExpressionAttributeValues: { ":c": string } }) => ({
        Items: [...table.values()].filter((r) => r.channelId === v[":c"]).map(projected),
      }),
    );
  ddbMock.on(ScanCommand, { TableName: VAULT, IndexName: "byChannel" }).callsFake(() => ({
    Items: [...table.values()].map(projected),
  }));
  ddbMock
    .on(PutCommand, { TableName: "slack-test-messages" })
    .callsFake(({ Item }: { Item: Message }) => {
      messages.push(structuredClone(Item));
      return {};
    });
  ddbMock
    .on(GetCommand, { TableName: "slack-test-users" })
    .resolves({ Item: { displayName: "Alice Andrade" } });
  ddbMock.on(ScanCommand, { TableName: "slack-test-channels" }).resolves({
    Items: [GENERAL, PROJECT, ARCHIVED],
  });
  ddbMock.on(ScanCommand, { TableName: "slack-test-connections" }).resolves({
    Items: [
      { connectionId: "conn-alice", userId: ALICE.userId },
      { connectionId: "conn-bob", userId: BOB.userId },
      { connectionId: "conn-carol", userId: CAROL.userId },
    ],
  });
  mockChannels(GENERAL, PROJECT, ARCHIVED);
}

// --- Requests -----------------------------------------------------------------------

type Caller = { userId: string; email: string };
function request(
  routeKey: string,
  opts: { body?: unknown; params?: Record<string, string>; user?: Caller; groups?: string } = {},
) {
  const user = opts.user ?? ALICE;
  return {
    version: "2.0",
    routeKey,
    rawPath: "/vault",
    headers: {},
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    isBase64Encoded: false,
    pathParameters: opts.params,
    requestContext: {
      http: { method: routeKey.split(" ")[0] },
      authorizer: {
        jwt: {
          claims: {
            sub: user.userId,
            email: user.email,
            ...(opts.groups && { "cognito:groups": `[${opts.groups}]` }),
          },
          scopes: [],
        },
      },
    },
  } as unknown as HttpEvent;
}
async function call(routeKey: string, opts: Parameters<typeof request>[1] = {}) {
  const result = (await handler(request(routeKey, opts))) as {
    statusCode: number;
    body: string;
    headers?: Record<string, string>;
  };
  return { ...result, status: result.statusCode, json: result.body ? JSON.parse(result.body) : {} };
}

const save = (body: Record<string, unknown>, user: Caller = ALICE) =>
  call("POST /vault", { body: { channelId: "ch_project", name: "AWS root", ...body }, user });
const reveal = (secretId: string, user: Caller = ALICE) =>
  call("GET /vault/reveal/{secretId}", { params: { secretId }, user });

beforeEach(() => {
  resetMocks();
  fakeKms();
  fakeTables();
});

describe("saving a secret (POST /vault)", () => {
  it("encrypts the password with the Vault key, bound to its row, and stores only the ciphertext", async () => {
    const res = await save({
      password: "Tr0ub4dor&3 ",
      username: " root@mindfultech.ec ",
      website: "console.aws.amazon.com",
    });
    expect(res.status).toBe(201);
    const secret = res.json.secret as VaultSecret;
    expect(secret).toMatchObject({
      channelId: "ch_project",
      name: "AWS root",
      username: "root@mindfultech.ec",
      website: "https://console.aws.amazon.com/",
      createdBy: ALICE.userId,
      createdByName: "Alice Andrade",
    });
    expect(secret.secretId).toMatch(/^vs_[0-9A-Z]{26}$/);
    expect(JSON.stringify(res.json)).not.toContain("Tr0ub4dor");
    expect(res.json.shared).toBe(false);

    const [encrypt] = kmsMock.commandCalls(EncryptCommand);
    expect(encrypt?.args[0].input).toMatchObject({
      KeyId: KEY,
      EncryptionContext: { purpose: "vault", secretId: secret.secretId, channelId: "ch_project" },
    });
    expect(Buffer.from(encrypt!.args[0].input.Plaintext as Uint8Array).toString()).toBe(
      "Tr0ub4dor&3 ",
    );

    const stored = table.get(secret.secretId)!;
    expect(stored.encryptedPassword).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(JSON.stringify(stored)).not.toContain("Tr0ub4dor");
    expect(stored).not.toHaveProperty("password");
    const put = ddbMock.commandCalls(PutCommand, { TableName: VAULT })[0]!.args[0].input;
    expect(put.ConditionExpression).toBe("attribute_not_exists(secretId)");
  });

  it("stores nothing when KMS fails", async () => {
    kmsMock.on(EncryptCommand).rejects(new Error("KMS is down"));
    expect((await save({ password: "pw" })).status).toBe(500);
    expect(table.size).toBe(0);
  });

  it("only saves into a channel the caller is in, and not an archived one", async () => {
    expect((await save({ password: "pw" }, CAROL)).status).toBe(404);
    expect((await save({ channelId: "ch_old", password: "pw" })).status).toBe(404);
    expect((await save({ channelId: "ch_nope", password: "pw" })).status).toBe(404);
    expect((await save({ channelId: "ch_general", password: "pw" }, CAROL)).status).toBe(201);
    expect(kmsMock.commandCalls(EncryptCommand)).toHaveLength(1);
  });

  it("refuses an empty password, a missing name and a website that isn't http(s)", async () => {
    expect((await save({ password: "   " })).status).toBe(400);
    expect((await save({ name: "", password: "pw" })).status).toBe(400);
    const bad = await save({ password: "pw", website: "javascript:alert(1)" });
    expect(bad.status).toBe(400);
    expect(bad.json.message).toMatch(/^website:/);
    expect(kmsMock.commandCalls(EncryptCommand)).toHaveLength(0);
  });

  it("closes the Vault to guests", async () => {
    expect((await call("GET /vault", { groups: "guests" })).status).toBe(403);
    const guest = await call("POST /vault", {
      body: { channelId: "ch_general", name: "x", password: "pw" },
      groups: "guests",
    });
    expect(guest.status).toBe(403);
  });
});

describe("/secret: sharing a secret as a chat card", () => {
  it("posts a 🔒 card with the name and id only, to the channel's members", async () => {
    const res = await save({ password: "hunter2-but-longer", share: true });
    expect(res.status).toBe(201);
    expect(res.json.shared).toBe(true);
    const secretId = res.json.secret.secretId as string;
    expect(messages).toHaveLength(1);
    const card = messages[0]!;
    expect(card).toMatchObject({
      channelId: "ch_project",
      userId: ALICE.userId,
      kind: "vault",
      text: "🔒 Shared a Secret: AWS root",
      vault: { secretId, name: "AWS root" },
    });
    expect(res.json.message.messageId).toBe(card.messageId);

    const events = sentEvents();
    expect(events.map(([conn]) => conn).sort()).toEqual(["conn-alice", "conn-bob"]);
    expect(events[0]?.[1]).toMatchObject({ type: "message.new", message: { kind: "vault" } });
    expect(JSON.stringify([messages, events])).not.toContain("hunter2");
  });

  it("keeps the secret when the card can't be posted", async () => {
    ddbMock.on(PutCommand, { TableName: "slack-test-messages" }).rejects(new Error("throttled"));
    const res = await save({ password: "pw", share: true });
    expect(res.status).toBe(201);
    expect(res.json.shared).toBe(false);
    expect(table.size).toBe(1);
  });
});

describe("listing (GET /vault, GET /vault/{channelId})", () => {
  it("lists the caller's channels' secrets, newest first, without any ciphertext", async () => {
    await save({ password: "one" });
    await save({ channelId: "ch_general", name: "Figma", password: "two" });
    const alice = await call("GET /vault");
    expect(alice.status).toBe(200);
    expect(alice.json.secrets.map((s: VaultSecret) => s.name).sort()).toEqual([
      "AWS root",
      "Figma",
    ]);
    expect(alice.body).not.toMatch(/encryptedPassword|one|two/);

    const carol = await call("GET /vault", { user: CAROL });
    expect(carol.json.secrets.map((s: VaultSecret) => s.name)).toEqual(["Figma"]);
  });

  it("lists one channel's for its members; a private channel is 'not found' to anyone else", async () => {
    await save({ password: "one" });
    const bob = await call("GET /vault/{channelId}", {
      params: { channelId: "ch_project" },
      user: BOB,
    });
    expect(bob.json.secrets).toHaveLength(1);
    expect(bob.json.secrets[0]).not.toHaveProperty("encryptedPassword");
    const carol = await call("GET /vault/{channelId}", {
      params: { channelId: "ch_project" },
      user: CAROL,
    });
    expect(carol.status).toBe(404);
  });
});

describe("revealing (GET /vault/reveal/{secretId})", () => {
  it("decrypts for a member of the channel, uncached", async () => {
    const { json } = await save({ password: "Tr0ub4dor&3 " });
    const res = await reveal(json.secret.secretId, BOB);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ secretId: json.secret.secretId, password: "Tr0ub4dor&3 " });
    expect(res.headers?.["cache-control"]).toBe("no-store");
    const [decrypt] = kmsMock.commandCalls(DecryptCommand);
    expect(decrypt?.args[0].input).toMatchObject({
      KeyId: KEY,
      EncryptionContext: { purpose: "vault", channelId: "ch_project" },
    });
  });

  it("is 'not found' for anyone outside the channel, and never asks KMS", async () => {
    const { json } = await save({ password: "pw" });
    const res = await reveal(json.secret.secretId, CAROL);
    expect(res.status).toBe(404);
    expect(kmsMock.commandCalls(DecryptCommand)).toHaveLength(0);
    expect((await call("GET /vault/reveal/{secretId}", { params: { secretId: "x" } })).status).toBe(
      404,
    );
  });

  it("doesn't decrypt a ciphertext moved to another row or channel", async () => {
    const { json } = await save({ password: "pw" });
    const row = table.get(json.secret.secretId)!;
    // Someone with table access re-files it under a public channel.
    table.set(row.secretId, { ...row, channelId: "ch_general" });
    const res = await reveal(row.secretId, CAROL);
    expect(res.status).toBe(500);
    expect(res.json.message).toBe("Something went wrong");
  });

  it("says when the secret was deleted", async () => {
    const res = await reveal("vs_01JBZZZZZZZZZZZZZZZZZZZZZZ");
    expect(res.status).toBe(404);
    expect(res.json.message).toBe("This secret was deleted");
  });
});

describe("deleting (DELETE /vault/secrets/{secretId})", () => {
  it("lets whoever saved it, or an admin, delete it; not other members", async () => {
    const first = (await save({ channelId: "ch_general", password: "pw" })).json.secret;
    const second = (await save({ channelId: "ch_general", password: "pw" })).json.secret;
    const del = (secretId: string, user: Caller, groups?: string) =>
      call("DELETE /vault/secrets/{secretId}", { params: { secretId }, user, groups });
    expect((await del(first.secretId, BOB)).status).toBe(403);
    expect((await del(first.secretId, ALICE)).status).toBe(200);
    expect((await del(second.secretId, ADMIN, "admins")).status).toBe(200);
    expect(table.size).toBe(0);
    expect((await reveal(first.secretId)).status).toBe(404);
  });
});

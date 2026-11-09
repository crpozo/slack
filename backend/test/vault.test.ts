import {
  DecryptCommand,
  EncryptCommand,
  InvalidCiphertextException,
  KMSClient,
} from "@aws-sdk/client-kms";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  VAULT_METADATA_ATTRIBUTES,
  VAULT_PIN_ATTRIBUTES,
  type Message,
  type VaultSecret,
} from "@mindfultech/shared";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handler } from "../src/handlers/vault";
import type { HttpEvent } from "../src/lib/http";
import type { VaultRow } from "../src/lib/vault";
import { useBcryptCost } from "../src/lib/vaultPin";
import { applyUpdate, evaluateCondition } from "./fakeExpressions";
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
const USERS = "slack-test-users";
const KEY = "arn:aws:kms:us-east-1:123456789012:key/test-vault-key";
const CAROL = { userId: "user-carol", email: "carol@example.com" };
const ADMIN = { userId: "user-admin", email: "admin@example.com" };
const GUEST = { userId: "user-guest", email: "guest@client.com" };
const PROJECT = privateRow("ch_project", ALICE.userId, [ALICE.userId, BOB.userId]);
const ARCHIVED = { ...privateRow("ch_old", ALICE.userId, [ALICE.userId]), archived: true };
const T0 = 1_800_000_000_000;
const PIN = "4821";

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
const decryptsFor = (purpose: string) =>
  kmsMock
    .commandCalls(DecryptCommand)
    .filter((c) => c.args[0].input.EncryptionContext?.purpose === purpose).length;

// --- In-memory tables behind the DynamoDB mock (real update/condition semantics) ---------

let vault: Map<string, VaultRow>;
let users: Map<string, Record<string, unknown>>;
let messages: Message[];

type Input = {
  Key: { userId: string };
  UpdateExpression: string;
  ConditionExpression?: string;
  ExpressionAttributeValues?: Record<string, unknown>;
  ExpressionAttributeNames?: Record<string, string>;
  ReturnValues?: string;
};
function conditionFailed(): never {
  throw new ConditionalCheckFailedException({
    message: "The conditional request failed",
    $metadata: {},
  });
}

function fakeTables() {
  vault = new Map();
  messages = [];
  users = new Map(
    [ALICE, BOB, CAROL, ADMIN, GUEST].map((u) => [
      u.userId,
      {
        userId: u.userId,
        email: u.email,
        role: u === ADMIN ? "admin" : u === GUEST ? "guest" : "member",
        displayName: u.email.split("@")[0],
      },
    ]),
  );
  ddbMock
    .on(PutCommand, { TableName: VAULT })
    .callsFake(
      ({ Item, ConditionExpression }: { Item: VaultRow; ConditionExpression?: string }) => {
        if (
          !evaluateCondition(
            ConditionExpression,
            vault.get(Item.secretId) as Record<string, unknown> | undefined,
          )
        )
          conditionFailed();
        vault.set(Item.secretId, structuredClone(Item));
        return {};
      },
    );
  ddbMock.on(GetCommand, { TableName: VAULT }).callsFake(({ Key }: { Key: VaultRow }) => ({
    Item: structuredClone(vault.get(Key.secretId)),
  }));
  ddbMock.on(DeleteCommand, { TableName: VAULT }).callsFake(({ Key }: { Key: VaultRow }) => {
    vault.delete(Key.secretId);
    return {};
  });
  ddbMock
    .on(ScanCommand, { TableName: VAULT })
    .callsFake(
      ({
        ProjectionExpression,
        ExpressionAttributeNames,
      }: {
        ProjectionExpression: string;
        ExpressionAttributeNames: Record<string, string>;
      }) => {
        const attrs = ProjectionExpression.split(/,\s*/).map((n) => ExpressionAttributeNames[n]!);
        return {
          Items: [...vault.values()].map((r) =>
            Object.fromEntries(Object.entries(r).filter(([k]) => attrs.includes(k))),
          ),
        };
      },
    );
  ddbMock
    .on(GetCommand, { TableName: USERS })
    .callsFake(({ Key }: { Key: { userId: string } }) => ({
      Item: structuredClone(users.get(Key.userId)),
    }));
  ddbMock.on(UpdateCommand, { TableName: USERS }).callsFake((input: Input) => {
    const row = users.get(input.Key.userId);
    const values = input.ExpressionAttributeValues ?? {};
    const names = input.ExpressionAttributeNames ?? {};
    if (!evaluateCondition(input.ConditionExpression, row, values, names)) conditionFailed();
    const next = applyUpdate(row ?? { ...input.Key }, input.UpdateExpression, values, names);
    users.set(input.Key.userId, next);
    return input.ReturnValues ? { Attributes: structuredClone(next) } : {};
  });
  ddbMock.on(ScanCommand, { TableName: USERS }).callsFake(() => ({
    Items: [...users.values()].map(({ userId, role }) => ({ userId, role })),
  }));
  ddbMock
    .on(PutCommand, { TableName: "slack-test-messages" })
    .callsFake(({ Item }: { Item: Message }) => {
      messages.push(structuredClone(Item));
      return {};
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
const sessions = new Map<string, string>();
const groupsOf = (user: Caller) =>
  user === ADMIN ? "admins" : user === GUEST ? "guests" : undefined;

function request(
  routeKey: string,
  opts: { body?: unknown; params?: Record<string, string>; user?: Caller; token?: string } = {},
) {
  const user = opts.user ?? ALICE;
  const groups = groupsOf(user);
  const token = opts.token ?? sessions.get(user.userId);
  return {
    version: "2.0",
    routeKey,
    rawPath: "/vault",
    headers: token ? { "x-vault-session": token } : {},
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
            ...(groups && { "cognito:groups": `[${groups}]` }),
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

/** Sets the person's PIN (the first one opens the Vault) and keeps the session. */
async function unlockAs(user: Caller, pin = PIN) {
  const res = await call("POST /vault/pin", { body: { pin }, user });
  expect(res.status).toBe(201);
  sessions.set(user.userId, res.json.token);
  return res.json.token as string;
}
const save = (body: Record<string, unknown>, user: Caller = ALICE) =>
  call("POST /vault", { body: { channelId: "ch_project", name: "AWS root", ...body }, user });
const reveal = (secretId: string, user: Caller = ALICE, pin = PIN) =>
  call("POST /vault/reveal/{secretId}", { params: { secretId }, user, body: { pin } });
const list = (user: Caller) => call("GET /vault", { user });
const names = (res: { json: { secrets: VaultSecret[] } }) =>
  res.json.secrets.map((s) => s.name).sort();
const verify = (pin: string, user: Caller = ALICE) =>
  call("POST /vault/pin/verify", { body: { pin }, user });

beforeEach(() => {
  resetMocks();
  fakeKms();
  fakeTables();
  sessions.clear();
  useBcryptCost(4);
  vi.useFakeTimers({ now: T0, toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  useBcryptCost(null);
});

describe("saving a secret (POST /vault)", () => {
  it("encrypts the password with the Vault key, bound to its row, and stores only the ciphertext", async () => {
    const res = await save({
      password: "Tr0ub4dor&3 ",
      username: " root@mindfultech.ec ",
      website: "console.aws.amazon.com",
      allowedUserIds: [BOB.userId],
    });
    expect(res.status).toBe(201);
    const secret = res.json.secret as VaultSecret;
    expect(secret).toMatchObject({
      channelId: "ch_project",
      name: "AWS root",
      username: "root@mindfultech.ec",
      website: "https://console.aws.amazon.com/",
      createdBy: ALICE.userId,
      createdByName: "alice",
      allowedUserIds: [BOB.userId],
    });
    expect(secret.secretId).toMatch(/^vs_[0-9A-Z]{26}$/);
    expect(JSON.stringify(res.json)).not.toContain("Tr0ub4dor");

    const [encrypt] = kmsMock.commandCalls(EncryptCommand);
    expect(encrypt?.args[0].input).toMatchObject({
      KeyId: KEY,
      EncryptionContext: { purpose: "vault", secretId: secret.secretId, channelId: "ch_project" },
    });
    const stored = vault.get(secret.secretId)!;
    expect(JSON.stringify(stored)).not.toContain("Tr0ub4dor");
    expect(stored).not.toHaveProperty("password");
  });

  it("only files secrets under a channel the caller is in, and not an archived one", async () => {
    expect((await save({ password: "pw" }, CAROL)).status).toBe(404);
    expect((await save({ channelId: "ch_old", password: "pw" })).status).toBe(404);
    expect((await save({ channelId: "ch_general", password: "pw" }, CAROL)).status).toBe(201);
  });

  it("shares only with teammates: never a guest or someone unknown", async () => {
    const guest = await save({ password: "pw", allowedUserIds: [GUEST.userId] });
    expect(guest.status).toBe(400);
    expect(guest.json.message).toMatch(/^allowedUserIds:/);
    expect((await save({ password: "pw", allowedUserIds: ["user-nobody"] })).status).toBe(400);
    expect(vault.size).toBe(0);
    expect(kmsMock.commandCalls(EncryptCommand)).toHaveLength(0);
  });

  it("refuses an empty password and a website that isn't http(s)", async () => {
    expect((await save({ password: "   " })).status).toBe(400);
    expect((await save({ password: "pw", website: "javascript:alert(1)" })).status).toBe(400);
  });

  it("closes the Vault to guests", async () => {
    for (const route of ["GET /vault", "GET /vault/pin", "POST /vault"]) {
      expect((await call(route, { user: GUEST, body: {} })).status).toBe(403);
    }
  });
});

describe("RBAC: admins see every secret, staff only theirs and those shared with them", () => {
  beforeEach(async () => {
    for (const u of [ALICE, BOB, CAROL, ADMIN]) await unlockAs(u);
    await save({ name: "Shared with Bob", password: "for-bob", allowedUserIds: [BOB.userId] });
    await save({ name: "Alice only", password: "alice-only" });
    await save({ name: "Carol's own", channelId: "ch_general", password: "c" }, CAROL);
  });

  it("lists by role and assignment", async () => {
    expect(names(await list(ADMIN))).toEqual(["Alice only", "Carol's own", "Shared with Bob"]);
    expect(names(await list(ALICE))).toEqual(["Alice only", "Shared with Bob"]);
    expect(names(await list(BOB))).toEqual(["Shared with Bob"]);
    // Carol is in neither list: the channel she can't see, nor Alice's own, ever reach her.
    expect(names(await list(CAROL))).toEqual(["Carol's own"]);
    const bob = await list(BOB);
    expect(bob.body).not.toMatch(/encryptedPassword|for-bob/);
    expect(bob.headers?.["cache-control"]).toBe("no-store");
  });

  it("doesn't let a staff member query, by channel, a secret not assigned to them", async () => {
    const bob = await call("GET /vault/channels/{channelId}", {
      params: { channelId: "ch_project" },
      user: BOB,
    });
    // Bob is in #project, but only one of its two secrets is his.
    expect(names(bob)).toEqual(["Shared with Bob"]);
  });

  it("doesn't let a staff member reveal an unassigned secret, even with the right PIN", async () => {
    const aliceOnly = [...vault.values()].find((r) => r.name === "Alice only")!;
    const res = await reveal(aliceOnly.secretId, BOB);
    expect(res.status).toBe(404);
    expect(res.body).not.toContain("alice-only");
    // Refused before the PIN or the password were touched.
    expect(decryptsFor("vault")).toBe(0);
    expect(decryptsFor("vault-pin")).toBe(0);
    expect((await reveal(aliceOnly.secretId, ADMIN)).json.password).toBe("alice-only");
  });

  it("makes everyone a secret is shared with a co-admin: they edit, re-share and delete it", async () => {
    const forBob = [...vault.values()].find((r) => r.name === "Shared with Bob")!;
    const edit = (user: Caller, allowedUserIds: string[], name = "Shared with Bob") =>
      call("PUT /vault/secrets/{secretId}", {
        params: { secretId: forBob.secretId },
        user,
        body: { channelId: "ch_project", name, allowedUserIds },
      });
    const remove = (user: Caller) =>
      call("DELETE /vault/secrets/{secretId}", { params: { secretId: forBob.secretId }, user });

    // Carol can't see it, so she can't touch it either (and isn't told it exists).
    expect((await edit(CAROL, [CAROL.userId])).status).toBe(404);
    expect((await remove(CAROL)).status).toBe(404);
    expect(vault.has(forBob.secretId)).toBe(true);

    // Bob didn't save it, but it's shared with him: he renames it and shares it with Carol.
    const byBob = await edit(BOB, [BOB.userId, CAROL.userId], "Renamed by Bob");
    expect(byBob.status).toBe(200);
    expect(byBob.json.secret).toMatchObject({
      name: "Renamed by Bob",
      createdBy: ALICE.userId, // still Alice's: a co-admin doesn't take it over
      allowedUserIds: [BOB.userId, CAROL.userId],
    });
    expect(names(await list(CAROL))).toEqual(["Carol's own", "Renamed by Bob"]);
    expect((await reveal(forBob.secretId, CAROL)).json.password).toBe("for-bob");
    // An edit keeps the password and its ciphertext.
    expect(vault.get(forBob.secretId)!.encryptedPassword).toBe(forBob.encryptedPassword);

    // Its saver takes it away from Bob: he's no longer a co-admin, and can't delete it.
    expect((await edit(ALICE, [CAROL.userId])).status).toBe(200);
    expect(names(await list(BOB))).toEqual([]);
    expect((await reveal(forBob.secretId, BOB)).status).toBe(404);
    expect((await edit(BOB, [BOB.userId])).status).toBe(404);
    expect((await remove(BOB)).status).toBe(404);

    // Carol, now a co-admin, deletes it.
    expect((await remove(CAROL)).status).toBe(200);
    expect(vault.has(forBob.secretId)).toBe(false);
  });

  it("re-encrypts when a secret moves to another channel, or gets a new password", async () => {
    const forBob = [...vault.values()].find((r) => r.name === "Shared with Bob")!;
    const moved = await call("PUT /vault/secrets/{secretId}", {
      params: { secretId: forBob.secretId },
      body: {
        channelId: "ch_general",
        name: "Moved",
        allowedUserIds: [BOB.userId],
        website: "",
      },
    });
    expect(moved.status).toBe(200);
    expect(moved.json.secret).toMatchObject({ channelId: "ch_general", updatedAt: T0 });
    expect((await reveal(forBob.secretId, BOB)).json.password).toBe("for-bob");
    await call("PUT /vault/secrets/{secretId}", {
      params: { secretId: forBob.secretId },
      user: ADMIN,
      body: { channelId: "ch_general", name: "Moved", allowedUserIds: [], password: "rotated!" },
    });
    expect((await reveal(forBob.secretId, ALICE)).json.password).toBe("rotated!");
    expect((await reveal(forBob.secretId, BOB)).status).toBe(404);
  });
});

describe("/secret: sharing a secret as a chat card", () => {
  it("shares it with the channel's members and posts a 🔒 card with no password", async () => {
    const res = await save({ password: "hunter2-but-longer", share: true });
    expect(res.status).toBe(201);
    expect(res.json.secret.allowedUserIds).toEqual([BOB.userId]);
    expect(messages[0]).toMatchObject({
      kind: "vault",
      text: "🔒 Shared a Secret: AWS root",
      vault: { secretId: res.json.secret.secretId, name: "AWS root" },
    });
    expect(
      sentEvents()
        .map(([conn]) => conn)
        .sort(),
    ).toEqual(["conn-alice", "conn-bob"]);
    expect(JSON.stringify([messages, sentEvents()])).not.toContain("hunter2");
  });

  it("refuses a channel with people from outside MindfulTech (Phase 55): nothing saved or posted", async () => {
    mockChannels(
      GENERAL,
      privateRow("ch_client", ALICE.userId, [ALICE.userId, BOB.userId, GUEST.userId]),
    );
    const res = await save({ channelId: "ch_client", password: "pw", share: true });
    expect(res.status).toBe(400);
    expect(res.json.message).toMatch(/outside MindfulTech/);
    expect(vault.size).toBe(0);
    expect(messages).toHaveLength(0);
  });

  it("in a public channel, shares it with the whole team but never guests", async () => {
    const res = await save({ channelId: "ch_general", password: "pw", share: true });
    expect(res.json.secret.allowedUserIds.sort()).toEqual(
      [ADMIN.userId, BOB.userId, CAROL.userId].sort(),
    );
  });
});

describe("the Vault PIN", () => {
  it("is set once, refused when too easy, and stored only as a KMS-wrapped bcrypt hash", async () => {
    expect((await call("GET /vault/pin")).json).toEqual({ hasPin: false, attemptsLeft: 5 });
    expect((await call("POST /vault/pin", { body: { pin: "1234" } })).status).toBe(400);
    expect((await call("POST /vault/pin", { body: { pin: "12345" } })).status).toBe(400);
    const token = await unlockAs(ALICE);
    expect(token).toMatch(/^[\w-]{43}$/);
    expect((await call("POST /vault/pin", { body: { pin: "9052" } })).status).toBe(409);

    const row = users.get(ALICE.userId)!;
    expect(JSON.stringify(row)).not.toContain(PIN);
    expect(row.vaultSessionHash).not.toBe(token);
    const blob = JSON.parse(Buffer.from(String(row.vaultPin), "base64").toString()) as {
      ctx: Record<string, string>;
    };
    expect(blob.ctx).toEqual({ purpose: "vault-pin", userId: ALICE.userId });
    // One Encrypt (the 409 doesn't hash again), and what KMS wrapped is a bcrypt hash.
    const wraps = kmsMock.commandCalls(EncryptCommand).map((c) => c.args[0].input);
    expect(wraps).toHaveLength(1);
    expect(Buffer.from(wraps[0]!.Plaintext as Uint8Array).toString()).toMatch(/^\$2[aby]\$04\$/);
  });

  it("keeps the list behind it: no session, a wrong or an expired one is 'locked'", async () => {
    await save({ password: "pw" });
    expect((await list(ALICE)).json).toMatchObject({ code: "VAULT_LOCKED" });
    expect((await list(ALICE)).status).toBe(401);
    const token = await unlockAs(ALICE);
    expect((await call("GET /vault", { token: "x".repeat(43) })).status).toBe(401);
    expect((await call("GET /vault", { token: token.slice(0, -1) })).status).toBe(401);
    expect((await call("GET /vault", { token, user: BOB })).status).toBe(401); // not Bob's
    expect(names(await list(ALICE))).toEqual(["AWS root"]);
    vi.setSystemTime(T0 + 15 * 60_000);
    expect((await list(ALICE)).status).toBe(401);
    const again = await verify(PIN);
    expect(again.status).toBe(200);
    sessions.set(ALICE.userId, again.json.token);
    expect((await list(ALICE)).status).toBe(200);
  });

  it("locks after 5 wrong PINs: 15 minutes, then twice as long each time", async () => {
    await unlockAs(ALICE);
    for (const left of [4, 3, 2, 1]) {
      const res = await verify("0001");
      expect([res.status, res.json.code, res.json.attemptsLeft]).toEqual([401, "PIN_WRONG", left]);
    }
    const fifth = await verify("0001");
    expect(fifth.status).toBe(423);
    expect(fifth.json).toMatchObject({ code: "PIN_LOCKED", lockedUntil: T0 + 15 * 60_000 });
    // Locked: even the right PIN isn't checked.
    const compares = decryptsFor("vault-pin");
    expect((await verify(PIN)).status).toBe(423);
    expect(decryptsFor("vault-pin")).toBe(compares);
    expect((await call("GET /vault/pin")).json).toMatchObject({ attemptsLeft: 0 });

    vi.setSystemTime(T0 + 15 * 60_000);
    expect((await call("GET /vault/pin")).json).toEqual({ hasPin: true, attemptsLeft: 5 });
    for (let i = 0; i < 5; i++) await verify("0001");
    expect(users.get(ALICE.userId)!.vaultPinLockedUntil).toBe(T0 + 15 * 60_000 + 30 * 60_000);

    // A right PIN after the lock clears the count and the escalation.
    vi.setSystemTime(T0 + 45 * 60_000);
    expect((await verify(PIN)).status).toBe(200);
    expect(users.get(ALICE.userId)).toMatchObject({ vaultPinFailures: 0, vaultPinLockouts: 0 });
  });

  it("allows at most 5 comparisons even when guesses arrive all at once", async () => {
    await unlockAs(ALICE);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => verify(String(1000 + i * 7))),
    );
    expect(decryptsFor("vault-pin")).toBeLessThanOrEqual(5);
    expect(results.filter((r) => r.status === 401).length).toBeLessThanOrEqual(4);
    expect(results.some((r) => r.status === 423)).toBe(true);
    expect((await verify(PIN)).status).toBe(423);
  });

  it("reveals while the Vault is unlocked, with no PIN again", async () => {
    const token = await unlockAs(ALICE);
    const { json } = await save({ password: "S3cret" });
    const res = await call("POST /vault/reveal/{secretId}", {
      params: { secretId: json.secret.secretId },
      token,
    });
    expect(res.json.password).toBe("S3cret");
    // A made-up session is no session: the PIN is asked for.
    const forged = await call("POST /vault/reveal/{secretId}", {
      params: { secretId: json.secret.secretId },
      token: "not-a-session",
    });
    expect(forged.status).toBe(400);
    expect(forged.body).not.toContain("S3cret");
  });

  it("without a session asks for the PIN; a wrong one counts against the same limit", async () => {
    await unlockAs(ALICE);
    const { json } = await save({ password: "S3cret" });
    sessions.delete(ALICE.userId);
    const wrong = await reveal(json.secret.secretId, ALICE, "0001");
    expect([wrong.status, wrong.json.attemptsLeft]).toEqual([401, 4]);
    expect(wrong.body).not.toContain("S3cret");
    expect(decryptsFor("vault")).toBe(0);
    const right = await reveal(json.secret.secretId);
    expect(right.json.password).toBe("S3cret");
    expect(right.headers?.["cache-control"]).toBe("no-store");
    // Before setting a PIN, nothing is revealed.
    const bobs = await save({ password: "x", allowedUserIds: [BOB.userId] });
    expect((await reveal(bobs.json.secret.secretId, BOB)).json.code).toBe("PIN_NOT_SET");
  });

  it("can be reset by an admin only (a forgotten PIN)", async () => {
    await unlockAs(BOB);
    const reset = (user: Caller) =>
      call("DELETE /vault/pin/{userId}", { params: { userId: BOB.userId }, user });
    expect((await reset(ALICE)).status).toBe(403);
    expect((await reset(ADMIN)).status).toBe(200);
    expect((await call("GET /vault/pin", { user: BOB })).json.hasPin).toBe(false);
    expect((await list(BOB)).status).toBe(401); // the old session is gone too
    expect(
      (await call("DELETE /vault/pin/{userId}", { params: { userId: "user-x" }, user: ADMIN }))
        .status,
    ).toBe(404);
  });
});

describe("staying inside the vault Lambda's IAM policy", () => {
  it("writes only the PIN's attributes on users rows, and Scans only metadata", async () => {
    await unlockAs(ALICE);
    await unlockAs(BOB);
    await verify("0001");
    await verify(PIN);
    await save({ password: "pw", allowedUserIds: [BOB.userId], share: true });
    await list(ALICE);
    await call("DELETE /vault/pin/{userId}", { params: { userId: BOB.userId }, user: ADMIN });

    const attributesIn = (expr = "", names: Record<string, string> = {}) =>
      (expr.match(/(?<![:\w])#?[A-Za-z_]\w*/g) ?? [])
        .filter(
          (t) =>
            !/^(SET|REMOVE|AND|OR|if_not_exists|attribute_exists|attribute_not_exists)$/.test(t),
        )
        .map((t) => (t.startsWith("#") ? names[t]! : t));
    const updates = ddbMock.commandCalls(UpdateCommand, { TableName: USERS });
    expect(updates.length).toBeGreaterThan(5);
    for (const { args } of updates) {
      const { UpdateExpression, ConditionExpression, ExpressionAttributeNames } = args[0].input;
      for (const attr of [
        ...attributesIn(UpdateExpression, ExpressionAttributeNames),
        ...attributesIn(ConditionExpression, ExpressionAttributeNames),
      ]) {
        expect(VAULT_PIN_ATTRIBUTES).toContain(attr);
      }
    }
    for (const { args } of ddbMock.commandCalls(ScanCommand, { TableName: VAULT })) {
      const { Select, ProjectionExpression = "", ExpressionAttributeNames = {} } = args[0].input;
      expect(Select).toBe("SPECIFIC_ATTRIBUTES");
      const attrs = attributesIn(ProjectionExpression, ExpressionAttributeNames);
      expect(attrs.length).toBeGreaterThan(0);
      for (const attr of attrs) expect(VAULT_METADATA_ATTRIBUTES).toContain(attr);
    }
    for (const { args } of ddbMock.commandCalls(ScanCommand, { TableName: USERS })) {
      expect(args[0].input.Select).toBe("SPECIFIC_ATTRIBUTES");
      expect(
        attributesIn(args[0].input.ProjectionExpression, args[0].input.ExpressionAttributeNames),
      ).toEqual(["userId", "role"]);
    }
  });
});

describe("tampering", () => {
  it("doesn't decrypt a ciphertext moved to another row or channel", async () => {
    await unlockAs(ALICE);
    await unlockAs(CAROL);
    const { json } = await save({ password: "pw", allowedUserIds: [CAROL.userId] });
    const row = vault.get(json.secret.secretId)!;
    vault.set(row.secretId, { ...row, channelId: "ch_general" });
    const res = await reveal(row.secretId, CAROL);
    expect(res.status).toBe(500);
    expect(res.json.message).toBe("Something went wrong");
  });
});

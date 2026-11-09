import {
  canAccessVaultSecret,
  canManageVaultSecret,
  CreateVaultSecretSchema,
  newMessageSk,
  normalizeWebsite,
  SetVaultPinSchema,
  UpdateVaultSecretSchema,
  VAULT_SESSION_HEADER,
  vaultCardText,
  VaultPinSchema,
  type Channel,
  type Message,
  type VaultCard,
  type VaultPage,
  type VaultPinRefusal,
  type VaultReveal,
  type VaultSecret,
} from "@mindfultech/shared";
import { paginateScan, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { deliver, listConnections } from "../lib/broadcast";
import { channelAudience, getAccessibleChannel, touchChannel } from "../lib/channels";
import { ddb, tables } from "../lib/ddb";
import {
  forbidden,
  HttpError,
  httpHandler,
  json,
  notFound,
  parseBody,
  pathParam,
  type HttpCaller,
  type HttpEvent,
  type HttpResult,
} from "../lib/http";
import { errorFields, log } from "../lib/logger";
import { displayNameOf } from "../lib/users";
import {
  decryptPassword,
  deleteVaultRow,
  encryptPassword,
  getVaultRow,
  putVaultRow,
  replaceVaultRow,
  scanSecrets,
  SECRET_ID,
  type VaultRow,
} from "../lib/vault";
import { checkPin, pinStatus, resetPin, sessionIsOpen, setPin, unlock } from "../lib/vaultPin";

/** Never cached by a browser or a proxy. */
const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };

const noStore = (status: number, body: unknown): HttpResult => ({
  statusCode: status,
  headers: { "content-type": "application/json", ...NO_STORE },
  body: JSON.stringify(body),
});

function secretIdOf(event: HttpEvent): string {
  const id = pathParam(event, "secretId");
  if (!SECRET_ID.test(id)) throw notFound("Secret not found");
  return id;
}

/**
 * The channel the caller may file a secret under (public, or theirs). Anything
 * else is "not found", so private channels stay hidden.
 */
async function channelFor(channelId: string, caller: HttpCaller, allowArchived: boolean) {
  const channel = await getAccessibleChannel(channelId, caller, { allowArchived });
  if (!channel) throw notFound("Channel not found");
  return channel;
}

/** Everyone on the team who may be given a secret: the directory without guests. */
async function teamMemberIds(): Promise<Set<string>> {
  return (await scanDirectory()).team;
}

/** The directory split in two: the team, and the externals (guest accounts). */
async function scanDirectory(): Promise<{ team: Set<string>; guests: Set<string> }> {
  const ids = new Set<string>();
  const guests = new Set<string>();
  const pages = paginateScan(
    { client: ddb },
    {
      TableName: tables.users,
      Select: "SPECIFIC_ATTRIBUTES",
      ProjectionExpression: "userId, #role",
      ExpressionAttributeNames: { "#role": "role" },
    },
  );
  for await (const page of pages) {
    for (const item of page.Items ?? []) {
      (item.role === "guest" ? guests : ids).add(String(item.userId));
    }
  }
  return { team: ids, guests };
}

/** The people a secret is shared with, checked against the team (no guests, no strangers). */
async function allowedList(ids: string[], ownerId: string): Promise<string[]> {
  const others = ids.filter((id) => id !== ownerId);
  if (others.length === 0) return [];
  const team = await teamMemberIds();
  const unknown = others.filter((id) => !team.has(id));
  if (unknown.length) {
    throw new HttpError(400, "allowedUserIds: only teammates (not guests) can be given a secret");
  }
  return others;
}

/**
 * `/secret`: the card is posted for the channel's members, so they get the
 * secret: teammates only. A channel with people from outside MindfulTech
 * (Phase 55) takes no secret at all: its card would be read by them.
 */
async function channelMemberIds(channel: Channel, ownerId: string): Promise<string[]> {
  const { team, guests } = await scanDirectory();
  const members = channel.type === "public" ? [...team] : (channel.members ?? []);
  if (members.some((id) => guests.has(id))) {
    throw new HttpError(
      400,
      "People from outside MindfulTech are in this channel: share the secret in a team channel",
    );
  }
  return [...new Set(members)].filter((id) => id !== ownerId && team.has(id));
}

/** The caller's secret, if they may see it; "not found" otherwise (it isn't theirs to know of). */
async function accessibleRow(secretId: string, caller: HttpCaller): Promise<VaultRow> {
  const row = await getVaultRow(secretId);
  if (!row || !canAccessVaultSecret(row, caller.userId, caller.role)) {
    if (row) log.warn("vault access refused", { secretId, userId: caller.userId });
    throw notFound("Secret not found");
  }
  return row;
}

/** Lists, edits and deletes need the Vault unlocked with the PIN (`POST /vault/pin/verify`). */
async function requireSession(event: HttpEvent, caller: HttpCaller): Promise<HttpResult | null> {
  const token = event.headers?.[VAULT_SESSION_HEADER];
  if (await sessionIsOpen(caller.userId, token)) return null;
  const body: VaultPinRefusal & { message: string } = {
    code: "VAULT_LOCKED",
    message: "The Vault is locked: enter your PIN",
  };
  return noStore(401, body);
}

/** Posts the "🔒 Shared a Secret" card in the secret's channel (best effort past the write). */
async function postCard(secret: VaultSecret, channel: Channel, caller: HttpCaller) {
  const now = Date.now();
  const card: VaultCard = {
    secretId: secret.secretId,
    name: secret.name,
    ...(secret.username && { username: secret.username }),
    ...(secret.website && { website: secret.website }),
  };
  const message: Message = {
    messageId: ulid(now),
    channelId: secret.channelId,
    sk: newMessageSk(now),
    userId: caller.userId,
    userEmail: caller.email,
    text: vaultCardText(card),
    attachments: [],
    createdAt: now,
    reactions: {},
    kind: "vault",
    vault: card,
  };
  await ddb.send(
    new PutCommand({
      TableName: tables.messages,
      Item: message,
      ConditionExpression: "attribute_not_exists(sk)",
    }),
  );
  await touchChannel(message.channelId, now);
  try {
    const inAudience = channelAudience(channel);
    await deliver(await listConnections(), (c) =>
      inAudience(c) ? { type: "message.new", message, clientId: "" } : null,
    );
  } catch (err) {
    log.error("vault card broadcast failed", { channelId: message.channelId, ...errorFields(err) });
  }
  return message;
}

const websiteOf = (input: string | undefined) =>
  input ? (normalizeWebsite(input) ?? undefined) : undefined;

/**
 * `POST /vault`: encrypts the password with KMS, then stores it, shared with
 * `allowedUserIds` (or, with `share`, the channel's members); optionally a
 * card in the chat.
 */
async function create(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const input = parseBody(CreateVaultSecretSchema, event);
  const channel = await channelFor(input.channelId, caller, false);
  const now = Date.now();
  const secretId = `vs_${ulid(now)}`;
  const website = websiteOf(input.website);
  const allowedUserIds =
    input.allowedUserIds !== undefined
      ? await allowedList(input.allowedUserIds, caller.userId)
      : input.share
        ? await channelMemberIds(channel, caller.userId)
        : [];
  const secret: VaultSecret = {
    secretId,
    channelId: input.channelId,
    name: input.name,
    ...(input.username && { username: input.username }),
    ...(website && { website }),
    createdBy: caller.userId,
    createdByName: await displayNameOf(caller),
    allowedUserIds,
    createdAt: now,
  };
  const row: VaultRow = {
    ...secret,
    encryptedPassword: await encryptPassword(input.password, secret),
  };
  await putVaultRow(row);
  log.info("vault secret saved", {
    secretId,
    channelId: secret.channelId,
    userId: caller.userId,
    allowed: allowedUserIds.length,
  });

  let message: Message | undefined;
  if (input.share) {
    try {
      message = await postCard(secret, channel, caller);
    } catch (err) {
      // The secret is saved either way; the client says the card didn't go out.
      log.error("vault card not posted", { secretId, ...errorFields(err) });
    }
  }
  return json(201, { secret, ...(message && { message }), shared: !!message });
}

/**
 * `PUT /vault/secrets/{secretId}` (Phase 46): anyone it's shared with (its
 * saver, a co-admin listed in `allowedUserIds` since Phase 56, or an admin) changes
 * the details, who it's shared with, the channel, or the password. Moving it
 * to another channel re-encrypts it (the channel is in its KMS context).
 */
async function update(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const secretId = secretIdOf(event);
  const input = parseBody(UpdateVaultSecretSchema, event);
  const row = await accessibleRow(secretId, caller);
  if (!canManageVaultSecret(row, caller.userId, caller.role)) {
    throw forbidden("Only people this secret is shared with can change it");
  }
  if (input.channelId !== row.channelId) await channelFor(input.channelId, caller, false);
  const website = websiteOf(input.website);
  const next: VaultSecret = {
    secretId,
    channelId: input.channelId,
    name: input.name,
    ...(input.username && { username: input.username }),
    ...(website && { website }),
    createdBy: row.createdBy,
    ...(row.createdByName && { createdByName: row.createdByName }),
    allowedUserIds: await allowedList(input.allowedUserIds, row.createdBy),
    createdAt: row.createdAt,
    updatedAt: Date.now(),
  };
  const password =
    input.password ?? (input.channelId !== row.channelId ? await decryptPassword(row) : null);
  await replaceVaultRow({
    ...next,
    encryptedPassword:
      password === null ? row.encryptedPassword : await encryptPassword(password, next),
  });
  log.info("vault secret updated", {
    secretId,
    userId: caller.userId,
    newPassword: input.password !== undefined,
    moved: input.channelId !== row.channelId,
    allowed: next.allowedUserIds.length,
  });
  return json(200, { secret: next });
}

/**
 * `POST /vault/reveal/{secretId}`: the password, for someone the secret is
 * shared with (anyone else gets "not found"), while their Vault is unlocked
 * (the session header, Phase 52: one PIN for `VAULT_SESSION_MS`) or with
 * their PIN in the body. Logged, never with the password.
 */
async function reveal(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const secretId = secretIdOf(event);
  const unlocked = await sessionIsOpen(caller.userId, event.headers?.[VAULT_SESSION_HEADER]);
  const pin = unlocked ? null : parseBody(VaultPinSchema, event).pin;
  const row = await getVaultRow(secretId);
  if (!row) throw notFound("This secret was deleted");
  if (!canAccessVaultSecret(row, caller.userId, caller.role)) {
    log.warn("vault reveal refused", { secretId, userId: caller.userId });
    throw notFound("Secret not found");
  }
  if (pin !== null) {
    const check = await checkPin(caller.userId, pin);
    if (!check.ok) return noStore(check.status, check.body);
  }
  const password = await decryptPassword(row);
  log.info("vault secret revealed", {
    secretId,
    channelId: row.channelId,
    userId: caller.userId,
    via: unlocked ? "session" : "pin",
  });
  const body: VaultReveal = { secretId, password };
  return noStore(200, body);
}

/** `DELETE /vault/secrets/{secretId}`: anyone it's shared with (Phase 56, co-admins), or an admin. */
async function remove(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const secretId = secretIdOf(event);
  const row = await accessibleRow(secretId, caller);
  if (!canManageVaultSecret(row, caller.userId, caller.role)) {
    throw forbidden("Only people this secret is shared with can delete it");
  }
  await deleteVaultRow(secretId);
  log.info("vault secret deleted", { secretId, channelId: row.channelId, userId: caller.userId });
  return json(200, { deleted: secretId });
}

/** What the caller may see: every secret for an admin, else theirs and those shared with them. */
async function visibleSecrets(caller: HttpCaller, channelId?: string): Promise<VaultSecret[]> {
  return (await scanSecrets()).filter(
    (s) =>
      (!channelId || s.channelId === channelId) &&
      canAccessVaultSecret(s, caller.userId, caller.role),
  );
}

/**
 * Vault (Phase 45; access and the PIN, Phase 46): the team's passwords and API
 * keys. Lists are metadata only and need the Vault unlocked; a password leaves
 * the server only through `reveal`, with the PIN. Guests never reach it.
 */
export const handler = httpHandler(async (event, caller): Promise<HttpResult> => {
  if (caller.role === "guest") throw forbidden("Guests only have access to their boards");
  switch (event.routeKey) {
    case "GET /vault/pin":
      return noStore(200, await pinStatus(caller.userId));
    case "POST /vault/pin": {
      const { pin } = parseBody(SetVaultPinSchema, event);
      return noStore(201, await setPin(caller.userId, pin));
    }
    case "POST /vault/pin/verify": {
      const { pin } = parseBody(VaultPinSchema, event);
      const result = await unlock(caller.userId, pin);
      return result.ok ? noStore(200, result.unlock) : noStore(result.status, result.body);
    }
    case "DELETE /vault/pin/{userId}": {
      if (caller.role !== "admin") throw forbidden("Only an admin can reset someone's Vault PIN");
      const userId = pathParam(event, "userId");
      try {
        await resetPin(userId);
      } catch (err) {
        if (err instanceof Error && err.name === "ConditionalCheckFailedException") {
          throw notFound("No such person");
        }
        throw err;
      }
      log.info("vault pin reset", { userId, by: caller.userId });
      return json(200, { reset: userId });
    }
    case "POST /vault":
      return create(event, caller);
    case "POST /vault/reveal/{secretId}":
      return reveal(event, caller);
  }

  // Everything else shows or changes the Vault's contents: unlocked only.
  const locked = await requireSession(event, caller);
  if (locked) return locked;
  switch (event.routeKey) {
    case "GET /vault": {
      const body: VaultPage = { secrets: await visibleSecrets(caller) };
      return noStore(200, body);
    }
    case "GET /vault/channels/{channelId}": {
      const body: VaultPage = {
        secrets: await visibleSecrets(caller, pathParam(event, "channelId")),
      };
      return noStore(200, body);
    }
    case "PUT /vault/secrets/{secretId}":
      return update(event, caller);
    case "DELETE /vault/secrets/{secretId}":
      return remove(event, caller);
    default:
      throw notFound(`No route for ${event.routeKey}`);
  }
});

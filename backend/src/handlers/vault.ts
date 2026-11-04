import {
  CreateVaultSecretSchema,
  newMessageSk,
  normalizeWebsite,
  vaultCardText,
  type Message,
  type VaultCard,
  type VaultPage,
  type VaultReveal,
  type VaultSecret,
} from "@mindfultech/shared";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { deliver, listConnections } from "../lib/broadcast";
import {
  channelAudience,
  getAccessibleChannel,
  scanChannels,
  touchChannel,
  visibleTo,
} from "../lib/channels";
import { ddb, tables } from "../lib/ddb";
import {
  forbidden,
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
  listChannelSecrets,
  listSecretsIn,
  putVaultRow,
  SECRET_ID,
  type VaultRow,
} from "../lib/vault";

/** Never cached by a browser or a proxy. */
const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };

function secretIdOf(event: HttpEvent): string {
  const id = pathParam(event, "secretId");
  if (!SECRET_ID.test(id)) throw notFound("Secret not found");
  return id;
}

/**
 * The channel the caller may use (public, or theirs). Anything else is "not
 * found", so private channels and their secrets stay hidden.
 */
async function channelFor(channelId: string, caller: HttpCaller, allowArchived: boolean) {
  const channel = await getAccessibleChannel(channelId, caller.userId, { allowArchived });
  if (!channel) throw notFound("Channel not found");
  return channel;
}

/** Posts the "🔒 Shared a Secret" card in the secret's channel (best effort past the write). */
async function postCard(secret: VaultSecret, caller: HttpCaller): Promise<Message> {
  const channel = await channelFor(secret.channelId, caller, false);
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

/** `POST /vault`: encrypts the password with KMS, then stores it; optionally a card in chat. */
async function create(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const input = parseBody(CreateVaultSecretSchema, event);
  await channelFor(input.channelId, caller, false);
  const now = Date.now();
  const secretId = `vs_${ulid(now)}`;
  const website = input.website ? (normalizeWebsite(input.website) ?? undefined) : undefined;
  const secret: VaultSecret = {
    secretId,
    channelId: input.channelId,
    name: input.name,
    ...(input.username && { username: input.username }),
    ...(website && { website }),
    createdBy: caller.userId,
    createdByName: await displayNameOf(caller),
    createdAt: now,
  };
  const row: VaultRow = {
    ...secret,
    encryptedPassword: await encryptPassword(input.password, secret),
  };
  await putVaultRow(row);
  log.info("vault secret saved", { secretId, channelId: secret.channelId, userId: caller.userId });

  let message: Message | undefined;
  if (input.share) {
    try {
      message = await postCard(secret, caller);
    } catch (err) {
      // The secret is saved either way; the client says the card didn't go out.
      log.error("vault card not posted", { secretId, ...errorFields(err) });
    }
  }
  return json(201, { secret, ...(message && { message }), shared: !!message });
}

/**
 * `GET /vault/reveal/{secretId}`: the password, decrypted by KMS, for a member
 * of the secret's channel only (anyone else gets "not found"). Logged, never
 * with the password.
 */
async function reveal(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const secretId = secretIdOf(event);
  const row = await getVaultRow(secretId);
  if (!row) throw notFound("This secret was deleted");
  const channel = await getAccessibleChannel(row.channelId, caller.userId, {
    allowArchived: true,
  });
  if (!channel) {
    log.warn("vault reveal refused", { secretId, channelId: row.channelId, userId: caller.userId });
    throw notFound("Secret not found");
  }
  const password = await decryptPassword(row);
  log.info("vault secret revealed", { secretId, channelId: row.channelId, userId: caller.userId });
  const body: VaultReveal = { secretId, password };
  return {
    statusCode: 200,
    headers: { "content-type": "application/json", ...NO_STORE },
    body: JSON.stringify(body),
  };
}

/** `DELETE /vault/secrets/{secretId}`: whoever saved it, or an admin. */
async function remove(event: HttpEvent, caller: HttpCaller): Promise<HttpResult> {
  const secretId = secretIdOf(event);
  const row = await getVaultRow(secretId);
  if (!row) throw notFound("Secret not found");
  const visible = await getAccessibleChannel(row.channelId, caller.userId, {
    allowArchived: true,
  });
  if (!visible) throw notFound("Secret not found");
  if (row.createdBy !== caller.userId && caller.role !== "admin") {
    throw forbidden("Only whoever saved this secret, or an admin, can delete it");
  }
  await deleteVaultRow(secretId);
  log.info("vault secret deleted", { secretId, channelId: row.channelId, userId: caller.userId });
  return json(200, { deleted: secretId });
}

/**
 * Vault (Phase 45): the team's passwords and API keys, per channel. Lists are
 * metadata only; a password leaves the server only through `reveal`. Guests
 * never reach it.
 */
export const handler = httpHandler(async (event, caller): Promise<HttpResult> => {
  if (caller.role === "guest") throw forbidden("Guests only have access to their boards");
  switch (event.routeKey) {
    case "GET /vault": {
      const channels = visibleTo(await scanChannels(), caller.userId);
      const body: VaultPage = {
        secrets: await listSecretsIn(new Set(channels.map((c) => c.channelId))),
      };
      return json(200, body);
    }
    case "GET /vault/{channelId}": {
      const channel = await channelFor(pathParam(event, "channelId"), caller, true);
      const body: VaultPage = { secrets: await listChannelSecrets(channel.channelId) };
      return json(200, body);
    }
    case "POST /vault":
      return create(event, caller);
    case "GET /vault/reveal/{secretId}":
      return reveal(event, caller);
    case "DELETE /vault/secrets/{secretId}":
      return remove(event, caller);
    default:
      throw notFound(`No route for ${event.routeKey}`);
  }
});

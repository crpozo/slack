import type { APIGatewayAuthorizerResult, APIGatewayRequestAuthorizerEvent } from "aws-lambda";
import { CALL_TOKEN_PREFIX, cleanExternalName, roleFromGroups } from "@mindfultech/shared";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { callForToken, externalUserId } from "../lib/callLinks";
import { requireEnv } from "../lib/env";
import { errorFields, log } from "../lib/logger";

let verifier: ReturnType<typeof createVerifier> | undefined;

function createVerifier() {
  return CognitoJwtVerifier.create({
    userPoolId: requireEnv("USER_POOL_ID"),
    clientId: requireEnv("USER_POOL_CLIENT_ID"),
    tokenUse: "id",
  });
}

function policy(
  principalId: string,
  effect: "Allow" | "Deny",
  resource: string,
  context?: Record<string, string>,
): APIGatewayAuthorizerResult {
  return {
    principalId,
    policyDocument: {
      Version: "2012-10-17",
      Statement: [{ Action: "execute-api:Invoke", Effect: effect, Resource: resource }],
    },
    context,
  };
}

/**
 * Phase 59: someone with a call link (`?token=call:<token>&room=<roomId>&name=…&cid=…`):
 * allowed only while that call goes on and the link's secret matches. Their
 * connection is an external's, tied to that call (see `getCaller`).
 */
async function authorizeCallLink(
  event: APIGatewayRequestAuthorizerEvent,
  token: string,
): Promise<APIGatewayAuthorizerResult> {
  const query = event.queryStringParameters ?? {};
  const roomId = query.room ?? "";
  const name = cleanExternalName(query.name);
  if (!/^[\w-]{1,64}$/.test(roomId) || !name) {
    return policy("anonymous", "Deny", event.methodArn);
  }
  try {
    const room = await callForToken(token.slice(CALL_TOKEN_PREFIX.length), roomId);
    if (!room) {
      log.info("call link denied", { roomId });
      return policy("anonymous", "Deny", event.methodArn);
    }
    const userId = externalUserId(room.roomId, query.cid);
    log.info("call link authorized", { channelId: room.channelId, roomId, userId });
    return policy(userId, "Allow", event.methodArn, {
      userId,
      email: "",
      role: "guest",
      external: "1",
      callScope: room.channelId,
      callRoomId: room.roomId,
      name,
    });
  } catch (err) {
    log.warn("call link check failed", errorFields(err));
    return policy("anonymous", "Deny", event.methodArn);
  }
}

/**
 * `$connect` REQUEST authorizer: validates the Cognito id token passed as
 * `?token=` (or, Phase 59, a call link's `call:` token). Any failure denies
 * the connection. Tokens are never logged.
 */
export const handler = async (
  event: APIGatewayRequestAuthorizerEvent,
): Promise<APIGatewayAuthorizerResult> => {
  const token = event.queryStringParameters?.token;
  if (!token) return policy("anonymous", "Deny", event.methodArn);
  if (token.startsWith(CALL_TOKEN_PREFIX)) return authorizeCallLink(event, token);

  try {
    verifier ??= createVerifier();
    const payload = await verifier.verify(token);
    const email = payload.email;
    if (typeof email !== "string") throw new Error("id token has no email claim");

    // The role rides along to every route (and onto the connection row).
    const role = roleFromGroups(payload["cognito:groups"]);
    log.info("connection authorized", { sub: payload.sub, role });
    return policy(payload.sub, "Allow", event.methodArn, { userId: payload.sub, email, role });
  } catch (err) {
    log.info("connection denied", errorFields(err));
    return policy("anonymous", "Deny", event.methodArn);
  }
};

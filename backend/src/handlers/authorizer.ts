import type { APIGatewayAuthorizerResult, APIGatewayRequestAuthorizerEvent } from "aws-lambda";
import { CognitoJwtVerifier } from "aws-jwt-verify";
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
 * `$connect` REQUEST authorizer: validates the Cognito id token passed as
 * `?token=`. Any failure denies the connection. The token is never logged.
 */
export const handler = async (
  event: APIGatewayRequestAuthorizerEvent,
): Promise<APIGatewayAuthorizerResult> => {
  const token = event.queryStringParameters?.token;
  if (!token) return policy("anonymous", "Deny", event.methodArn);

  try {
    verifier ??= createVerifier();
    const payload = await verifier.verify(token);
    const email = payload.email;
    if (typeof email !== "string") throw new Error("id token has no email claim");

    log.info("connection authorized", { sub: payload.sub });
    return policy(payload.sub, "Allow", event.methodArn, { userId: payload.sub, email });
  } catch (err) {
    log.info("connection denied", errorFields(err));
    return policy("anonymous", "Deny", event.methodArn);
  }
};

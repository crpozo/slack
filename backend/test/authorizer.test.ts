import type { APIGatewayRequestAuthorizerEvent } from "aws-lambda";
import { describe, expect, it } from "vitest";
import { handler } from "../src/handlers/authorizer";

const methodArn = "arn:aws:execute-api:us-east-1:123456789012:abc123/prod/$connect";

describe("authorizer (F1 stub)", () => {
  it("denies by default", async () => {
    const event = {
      type: "REQUEST",
      methodArn,
      queryStringParameters: { token: "basura" },
    } as unknown as APIGatewayRequestAuthorizerEvent;

    const result = await handler(event);

    expect(result.policyDocument.Statement).toEqual([
      { Action: "execute-api:Invoke", Effect: "Deny", Resource: methodArn },
    ]);
  });
});

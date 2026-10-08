import type { APIGatewayRequestAuthorizerEvent } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";

const verify = vi.fn();
vi.mock("aws-jwt-verify", () => ({
  CognitoJwtVerifier: { create: () => ({ verify }) },
}));

const { handler } = await import("../src/handlers/authorizer");

const methodArn = "arn:aws:execute-api:us-east-1:123456789012:abc123/prod/$connect";

function event(token?: string): APIGatewayRequestAuthorizerEvent {
  return {
    type: "REQUEST",
    methodArn,
    queryStringParameters: token === undefined ? {} : { token },
  } as unknown as APIGatewayRequestAuthorizerEvent;
}

describe("authorizer", () => {
  beforeEach(() => {
    verify.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("allows a valid id token and forwards userId/email", async () => {
    verify.mockResolvedValue({ sub: "user-alice", email: "alice@example.com" });

    const result = await handler(event("valid"));

    expect(verify).toHaveBeenCalledWith("valid");
    expect(result.principalId).toBe("user-alice");
    expect(result.policyDocument.Statement).toEqual([
      { Action: "execute-api:Invoke", Effect: "Allow", Resource: methodArn },
    ]);
    expect(result.context).toEqual({ userId: "user-alice", email: "alice@example.com" });
  });

  it("denies an invalid token", async () => {
    verify.mockRejectedValue(new Error("Invalid signature"));

    const result = await handler(event("basura"));

    expect(result.policyDocument.Statement).toEqual([
      { Action: "execute-api:Invoke", Effect: "Deny", Resource: methodArn },
    ]);
    expect(result.context).toBeUndefined();
  });

  it("denies without a token", async () => {
    const result = await handler(event());
    expect(verify).not.toHaveBeenCalled();
    expect(result.policyDocument.Statement[0]).toMatchObject({ Effect: "Deny" });
  });

  it("denies a token without email claim", async () => {
    verify.mockResolvedValue({ sub: "user-alice" });
    const result = await handler(event("no-email"));
    expect(result.policyDocument.Statement[0]).toMatchObject({ Effect: "Deny" });
  });

  it("never logs the token", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    verify.mockResolvedValue({ sub: "user-alice", email: "alice@example.com" });
    await handler(event("super-secret-token"));
    verify.mockRejectedValue(new Error("bad"));
    await handler(event("super-secret-token"));
    expect(logSpy.mock.calls.flat().join(" ")).not.toContain("super-secret-token");
  });
});

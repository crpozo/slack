import { DISCOVERY_URL } from "@mindfultech/shared";
import type { CustomMessageTriggerEvent } from "aws-lambda";
import { describe, expect, it } from "vitest";
import { DISCOVERY_INVITE_SUBJECT, handler } from "../src/handlers/cognito-custom-message";

// Phase 68: the pool shared with Discovery says which app an invitation is for.

/** A Custom message event as Cognito sends it (with its placeholders). */
const event = (
  triggerSource: CustomMessageTriggerEvent["triggerSource"],
  clientMetadata?: Record<string, string>,
): CustomMessageTriggerEvent =>
  ({
    version: "1",
    region: "us-east-1",
    userPoolId: "us-east-1_TEST",
    userName: "11111111-2222-4333-8444-555555555555",
    callerContext: { awsSdkVersion: "aws-sdk-js-3", clientId: "CLIENT" },
    triggerSource,
    request: {
      userAttributes: { email: "entrevistada@example.com" },
      codeParameter: "{####}",
      linkParameter: "{##Click Here##}",
      usernameParameter: "{username}",
      ...(clientMetadata ? { clientMetadata } : {}),
    },
    response: { smsMessage: null, emailMessage: null, emailSubject: null },
  }) as CustomMessageTriggerEvent;

describe("Cognito Custom message trigger", () => {
  it("writes Discovery's invitation for an AdminCreateUser that Discovery sends", async () => {
    const result = await handler(event("CustomMessage_AdminCreateUser", { app: "discovery" }));
    expect(result.response.emailSubject).toBe(DISCOVERY_INVITE_SUBJECT);
    expect(result.response.emailSubject).toMatch(/Discovery/);
    const body = result.response.emailMessage ?? "";
    expect(body).toContain(`href="${DISCOVERY_URL}"`);
    expect(DISCOVERY_URL).toBe("https://discovery.mindfultech.ec");
    expect(body).toContain("{####}");
    expect(body).toContain("{username}");
    expect(result.response.emailSubject).toBe("You're invited to MindfulTech Discovery");
    expect(body).toBe(
      "Hi! You've been invited to take part in <b>MindfulTech Discovery</b>.<br><br>" +
        'Sign in at <a href="https://discovery.mindfultech.ec">discovery.mindfultech.ec</a> with:<br>' +
        "Email: {username}<br>Temporary password: {####}<br><br>" +
        "You'll choose your own password the first time you sign in. " +
        "The temporary password expires in 7 days.",
    );
    // SMS stays Cognito's: the pool's own template.
    expect(result.response.smsMessage).toBeNull();
  });

  it("leaves this app's invitations (no clientMetadata) to the pool's template", async () => {
    const input = event("CustomMessage_AdminCreateUser");
    const before = structuredClone(input);
    const result = await handler(input);
    expect(result).toEqual(before);
    expect(result.response).toEqual({ smsMessage: null, emailMessage: null, emailSubject: null });
  });

  it("leaves an invitation for another app untouched", async () => {
    const input = event("CustomMessage_AdminCreateUser", { app: "slack" });
    const before = structuredClone(input);
    expect(await handler(input)).toEqual(before);
  });

  it("leaves every other message (e.g. ForgotPassword) untouched, even from Discovery", async () => {
    for (const source of [
      "CustomMessage_ForgotPassword",
      "CustomMessage_ResendCode",
      "CustomMessage_Authentication",
    ] as const) {
      const input = event(source, { app: "discovery" });
      const before = structuredClone(input);
      expect(await handler(input)).toEqual(before);
    }
  });
});

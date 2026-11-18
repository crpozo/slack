import {
  DISCOVERY_CLIENT_METADATA_APP,
  DISCOVERY_URL,
  TEMPORARY_PASSWORD_VALIDITY_DAYS,
} from "@mindfultech/shared";
import type { CustomMessageTriggerEvent } from "aws-lambda";

export const DISCOVERY_INVITE_SUBJECT = "You're invited to MindfulTech Discovery";

/**
 * Discovery's invitation (Phase 68), in English like the app itself. Cognito swaps in the
 * placeholders it gives us: the username (the email) and the temporary
 * password, which it requires in the message.
 */
export function discoveryInvitation(usernameParameter: string, codeParameter: string): string {
  const host = DISCOVERY_URL.replace(/^https:\/\//, "");
  return (
    "Hi! You've been invited to take part in <b>MindfulTech Discovery</b>.<br><br>" +
    `Sign in at <a href="${DISCOVERY_URL}">${host}</a> with:<br>` +
    `Email: ${usernameParameter}<br>Temporary password: ${codeParameter}<br><br>` +
    "You'll choose your own password the first time you sign in. " +
    `The temporary password expires in ${TEMPORARY_PASSWORD_VALIDITY_DAYS} days.`
  );
}

/**
 * The pool's Custom message trigger (Phase 68). The pool is shared with
 * Discovery: an AdminCreateUser (or its RESEND) that Discovery sends with
 * `ClientMetadata: { app: "discovery" }` gets Discovery's invitation, so the
 * person knows which app they're joining. Anything else is returned
 * untouched, and Cognito keeps using the pool's own `userInvitation`
 * template and its default messages: this app's invitations don't change.
 */
export function handler(event: CustomMessageTriggerEvent): Promise<CustomMessageTriggerEvent> {
  // Nothing to wait for (Phase 69): Lambda only needs the promise.
  if (
    event.triggerSource !== "CustomMessage_AdminCreateUser" ||
    event.request.clientMetadata?.app !== DISCOVERY_CLIENT_METADATA_APP
  ) {
    return Promise.resolve(event);
  }
  const { usernameParameter, codeParameter } = event.request;
  event.response.emailSubject = DISCOVERY_INVITE_SUBJECT;
  event.response.emailMessage = discoveryInvitation(
    usernameParameter ?? "{username}",
    codeParameter,
  );
  return Promise.resolve(event);
}

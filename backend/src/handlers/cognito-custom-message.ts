import {
  DISCOVERY_CLIENT_METADATA_APP,
  DISCOVERY_URL,
  TEMPORARY_PASSWORD_VALIDITY_DAYS,
} from "@mindfultech/shared";
import type { CustomMessageTriggerEvent } from "aws-lambda";

export const DISCOVERY_INVITE_SUBJECT = "Te invitamos a MindfulTech Discovery";

/**
 * Discovery's invitation (Phase 68), in Spanish. Cognito swaps in the
 * placeholders it gives us: the username (the email) and the temporary
 * password, which it requires in the message.
 */
export function discoveryInvitation(usernameParameter: string, codeParameter: string): string {
  const host = DISCOVERY_URL.replace(/^https:\/\//, "");
  return (
    "¡Hola! Te invitamos a participar en <b>MindfulTech Discovery</b>.<br><br>" +
    `Ingresa en <a href="${DISCOVERY_URL}">${host}</a> con:<br>` +
    `Correo: ${usernameParameter}<br>Contraseña temporal: ${codeParameter}<br><br>` +
    "La primera vez que ingreses elegirás tu propia contraseña. " +
    `La contraseña temporal vence en ${TEMPORARY_PASSWORD_VALIDITY_DAYS} días.`
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
export async function handler(
  event: CustomMessageTriggerEvent,
): Promise<CustomMessageTriggerEvent> {
  if (
    event.triggerSource !== "CustomMessage_AdminCreateUser" ||
    event.request.clientMetadata?.app !== DISCOVERY_CLIENT_METADATA_APP
  ) {
    return event;
  }
  const { usernameParameter, codeParameter } = event.request;
  event.response.emailSubject = DISCOVERY_INVITE_SUBJECT;
  event.response.emailMessage = discoveryInvitation(
    usernameParameter ?? "{username}",
    codeParameter,
  );
  return event;
}

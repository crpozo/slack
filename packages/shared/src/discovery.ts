// ---------------------------------------------------------------------------
// Discovery (Phase 68): a separate MindfulTech app (its own repo) that shares
// this app's Cognito User Pool. It imports the pool (never creates or changes
// it), with its own app client and groups. Its external interviewees are
// created with AdminCreateUser and added to `guests` before they first sign
// in, so here they see an empty guest layout.
// ---------------------------------------------------------------------------

/** Where Discovery lives: the invitation email's link and the sidebar's. */
export const DISCOVERY_URL = "https://discovery.mindfultech.ec";

/**
 * The `ClientMetadata.app` Discovery sends with AdminCreateUser (and its
 * RESEND): the Custom message trigger then writes Discovery's invitation.
 */
export const DISCOVERY_CLIENT_METADATA_APP = "discovery";

/** Days a temporary password lasts (the pool's default, said in the email). */
export const TEMPORARY_PASSWORD_VALIDITY_DAYS = 7;

/**
 * The SSM parameter holding a stage's User Pool ID; Discovery reads it with
 * `StringParameter.valueForStringParameter`.
 */
export const userPoolIdParameterName = (stage: string): string => `/slack/${stage}/user-pool-id`;

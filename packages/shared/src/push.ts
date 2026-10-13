import { z } from "zod";

// ---------------------------------------------------------------------------
// Web Push (Phase 8): browsers subscribe through the HTTP API; the message
// Lambda pushes to people who have no live WebSocket connection.
// ---------------------------------------------------------------------------

/**
 * Hosts of the browsers' push services. Subscriptions pointing anywhere else
 * are refused, so the message Lambda can't be made to POST to arbitrary URLs.
 */
const PUSH_SERVICE_HOSTS = [
  "fcm.googleapis.com", // Chrome, Edge (Chromium), Opera, Samsung Internet
  "updates.push.services.mozilla.com", // Firefox
  ".push.apple.com", // Safari (macOS, iOS 16.4+ home-screen apps)
  ".notify.windows.com", // legacy Edge / Windows
];

/** Whether `endpoint` is an https URL of a known browser push service. */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_SERVICE_HOSTS.some((h) => (h.startsWith(".") ? host.endsWith(h) : host === h));
}

/** Base64url without padding, as browsers encode subscription keys. */
const base64url = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[\w-]+=*$/, "must be base64url");

/** `PushSubscription.toJSON()`, validated. */
export const PushSubscriptionSchema = z.object({
  endpoint: z
    .string()
    .max(2048)
    .refine(isAllowedPushEndpoint, "endpoint must be a browser push service"),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: base64url(256), auth: base64url(64) }),
});
export type PushSubscriptionJSON = z.infer<typeof PushSubscriptionSchema>;

export const SubscribePushSchema = z.object({ subscription: PushSubscriptionSchema });
export const UnsubscribePushSchema = z.object({ endpoint: z.string().min(1).max(2048) });

/** What the service worker shows. Kept small: push payloads are capped around 4 KB. */
export interface PushPayload {
  title: string;
  body: string;
  /** App path to open on click, e.g. `/app/ch_general`. */
  url: string;
  /** Collapses notifications of the same conversation into one. */
  tag: string;
}

export const PUSH_PREVIEW_LENGTH = 120;

/**
 * `@handles` in a message, lowercased and de-duplicated. A handle is letters,
 * digits, `.`, `_` or `-`, e.g. `@ana`, `@ana.maria`. Matched against display
 * names (spaces removed) and email local parts by the server.
 */
export function findMentions(text: string): string[] {
  const handles = new Set<string>();
  for (const match of text.matchAll(/(?:^|[^\p{L}\p{N}_.@-])@([\p{L}\p{N}._-]{1,64})/gu)) {
    const handle = trimTrailingPunctuation(match[1] ?? "").toLowerCase();
    if (handle) handles.add(handle);
  }
  return [...handles];
}

/** "@ana." at the end of a sentence means "ana" (a loop: `[._-]+$` backtracks super-linearly). */
function trimTrailingPunctuation(handle: string): string {
  let end = handle.length;
  while (end > 0 && "._-".includes(handle[end - 1] ?? "")) end--;
  return handle.slice(0, end);
}

/** Handle a user answers to: their display name without spaces, lowercased. */
export const mentionHandle = (displayName: string) => displayName.replace(/\s+/g, "").toLowerCase();

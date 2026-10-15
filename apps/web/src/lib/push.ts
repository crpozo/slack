import { create } from "zustand";
import { isDesktopApp } from "./desktop";
import { pushApi, tasksApiConfigured, TasksApiError } from "./tasksApi";

/**
 * Web Push on this device. The service worker (`/sw.js`) shows notifications;
 * the server only pushes when you have no open connection (DMs and @mentions).
 *   unsupported   — no Push API (or no HTTP API configured)
 *   needs-install — iOS Safari: works only from a Home Screen app (iOS 16.4+)
 *   unconfigured  — this deployment has no VAPID keys yet
 *   denied        — the browser blocks notifications for this site
 *   off / on      — the user's choice on this device
 */
export type PushStatus = "unsupported" | "needs-install" | "unconfigured" | "denied" | "off" | "on";

interface PushState {
  status: PushStatus;
  busy: boolean;
  /** Why the last subscribe failed (shown under the switch), cleared on success. */
  lastError: string | null;
}

export const usePush = create<PushState>(() => ({ status: "off", busy: false, lastError: null }));

const set = (patch: Partial<PushState>) => usePush.setState(patch);

/** Breadcrumbs for the browser console (`[push]`): the first thing to read when a device gets nothing. */
const trace = (step: string, detail?: Record<string, unknown>) =>
  console.info("[push]", step, detail ?? "");

export function pushErrorMessage(err: unknown): string {
  if (err instanceof DOMException && err.name === "NotAllowedError") {
    return "Notifications are blocked for this app. Allow them in the system settings, then try again.";
  }
  if (err instanceof TasksApiError) return `The server rejected the subscription (${err.status}).`;
  return err instanceof Error ? err.message : String(err);
}

const isIos = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** What this browser can do, before asking the server anything. */
export function detectPushSupport(): PushStatus {
  // The desktop app keeps its socket open and notifies natively (lib/desktop.ts).
  if (typeof window === "undefined" || !tasksApiConfigured() || isDesktopApp())
    return "unsupported";
  const apis = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (!apis) return isIos() && !isStandalone() ? "needs-install" : "unsupported";
  if (Notification.permission === "denied") return "denied";
  return "off";
}

/** Base64url (VAPID public key) → bytes, as `pushManager.subscribe` wants it. */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = (value + "=".repeat((4 - (value.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Whether `subscription` was made with `publicKey` (false after a key rotation). */
export function sameKey(applicationServerKey: ArrayBuffer | null, publicKey: string): boolean {
  if (!applicationServerKey) return false;
  const a = new Uint8Array(applicationServerKey);
  const b = base64UrlToBytes(publicKey);
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

// "Off" chosen in the app, per user, survives reloads (the browser permission stays granted).
const optOutKey = (userId: string) => `slack.push.off.${userId}`;
function optedOut(userId: string): boolean {
  try {
    return localStorage.getItem(optOutKey(userId)) === "1";
  } catch {
    return false;
  }
}
function setOptedOut(userId: string, value: boolean): void {
  try {
    if (value) localStorage.setItem(optOutKey(userId), "1");
    else localStorage.removeItem(optOutKey(userId));
  } catch {
    // Storage blocked: the choice just won't survive a reload.
  }
}

/** Registers `/sw.js` (needed for notification clicks too). Safe to call repeatedly. */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch (err) {
    console.error("[push] service worker registration failed", err);
    return null;
  }
}

/** A VAPID public key: a P-256 point in uncompressed form, 65 bytes starting with 0x04. */
export function isValidVapidKey(key: string): boolean {
  try {
    const bytes = base64UrlToBytes(key);
    return bytes.length === 65 && bytes[0] === 0x04;
  } catch {
    return false;
  }
}

/** The browser's push service (FCM, Mozilla, Apple) kept refusing the subscription. */
export class PushServiceError extends Error {
  override name = "PushServiceError";
}

const RETRY_DELAYS_MS = [1000, 3000, 8000];
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * `pushManager.subscribe`, retried with backoff when the push service fails
 * ("Registration failed - push service error" is an AbortError from FCM). A
 * leftover subscription made with another key (InvalidStateError) is removed
 * first. A permission refusal is never retried.
 */
export async function subscribeWithRetry(
  manager: Pick<PushManager, "subscribe" | "getSubscription">,
  applicationServerKey: Uint8Array<ArrayBuffer>,
  delays: readonly number[] = RETRY_DELAYS_MS,
  sleep: (ms: number) => Promise<void> = wait,
): Promise<PushSubscription> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await manager.subscribe({ userVisibleOnly: true, applicationServerKey });
    } catch (err) {
      console.warn("[push] subscribe attempt failed", { attempt, error: String(err) });
      if (err instanceof DOMException && err.name === "NotAllowedError") throw err;
      // Whatever half-made subscription is left would make the next try fail too.
      const stale = await manager.getSubscription().catch(() => null);
      await stale?.unsubscribe().catch(() => false);
      const delay = delays[attempt];
      if (delay === undefined) {
        throw new PushServiceError(
          "Your browser's push service didn't respond. Try again in a minute. " +
            "(In Brave, enable “Use Google services for push messaging” in Settings → Privacy.)",
          { cause: err },
        );
      }
      await sleep(delay);
    }
  }
}

/** An active service worker registration (subscribing before activation fails). */
async function activeRegistration(): Promise<ServiceWorkerRegistration> {
  if (!(await registerServiceWorker())) throw new Error("Service worker unavailable");
  const ready = navigator.serviceWorker.ready;
  const timeout = wait(10_000).then(() => {
    throw new Error("The service worker didn't start. Reload the page and try again.");
  });
  return Promise.race([ready, timeout]);
}

/** Subscribes this browser with the server's key (re-subscribing after a rotation) and saves it. */
async function doSubscribe(): Promise<void> {
  // The key first: never call the push service with a missing or malformed one.
  const publicKey = (await pushApi.publicKey()).trim();
  if (!isValidVapidKey(publicKey)) {
    throw new Error("The server's push key is invalid. Ask an admin to re-run the vapid setup.");
  }
  const registration = await activeRegistration();
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !sameKey(subscription.options.applicationServerKey, publicKey)) {
    trace("key rotated: dropping the old subscription");
    await subscription.unsubscribe();
    subscription = null;
  }
  trace(subscription ? "reusing the browser's subscription" : "subscribing with the push service");
  subscription ??= await subscribeWithRetry(registration.pushManager, base64UrlToBytes(publicKey));
  await pushApi.subscribe(subscription.toJSON() as Parameters<typeof pushApi.subscribe>[0]);
  trace("subscription saved", {
    host: new URL(subscription.endpoint).host,
    expires: subscription.expirationTime,
    standalone: isStandalone(),
  });
}

// One attempt at a time: the sign-in sync and the "Enable" button used to race.
let inFlight: Promise<void> | null = null;
function subscribe(): Promise<void> {
  inFlight ??= doSubscribe().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Set when the silent sign-in sync failed, so it's retried when the app comes back. */
let syncFailed = false;

function failureStatus(err: unknown): PushStatus {
  return err instanceof TasksApiError && err.status === 503 ? "unconfigured" : "off";
}

/**
 * After sign-in: if notifications are already allowed and the user didn't turn
 * them off here, make sure the server has this device's current subscription.
 * Never prompts.
 */
export async function syncPush(userId: string): Promise<void> {
  const support = detectPushSupport();
  if (support !== "off") return set({ status: support });
  if (Notification.permission !== "granted" || optedOut(userId)) return set({ status: "off" });
  try {
    await subscribe();
    syncFailed = false;
    set({ status: "on", lastError: null });
  } catch (err) {
    // Silent on purpose: retried on the next visit or when the tab comes back.
    console.error("[push] sign-in sync failed", err);
    syncFailed = true;
    set({ status: failureStatus(err), lastError: pushErrorMessage(err) });
  }
}

/** The app is visible again: retry a sign-in sync that failed (e.g. push service hiccup). */
export function retryPushSyncIfFailed(userId: string): void {
  if (syncFailed && !inFlight) void syncPush(userId);
}

/** The "Enable notifications" button: asks permission (needs a click), then subscribes. */
export async function enablePush(userId: string): Promise<PushStatus> {
  set({ busy: true });
  try {
    const permission = await Notification.requestPermission();
    trace("permission", { permission });
    if (permission !== "granted") {
      set({ status: permission === "denied" ? "denied" : "off" });
      return usePush.getState().status;
    }
    await subscribe();
    setOptedOut(userId, false);
    set({ status: "on", lastError: null });
  } catch (err) {
    console.error("[push] enabling failed", err);
    set({ status: failureStatus(err), lastError: pushErrorMessage(err) });
    throw err;
  } finally {
    set({ busy: false });
  }
  return "on";
}

/** Forgets this device on the server and in the browser. */
async function dropSubscription(): Promise<void> {
  const registration = await navigator.serviceWorker?.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  await pushApi.unsubscribe(subscription.endpoint).catch(() => {});
  await subscription.unsubscribe().catch(() => false);
}

/** The switch turned off: no more notifications on this device for this user. */
export async function disablePush(userId: string): Promise<void> {
  set({ busy: true });
  try {
    setOptedOut(userId, true);
    await dropSubscription();
    set({ status: "off" });
  } finally {
    set({ busy: false });
  }
}

/** Before signing out (while the token still works): the next person here won't get your pushes. */
export async function signOutPush(): Promise<void> {
  if (detectPushSupport() === "unsupported" || !("serviceWorker" in navigator)) return;
  await dropSubscription().catch(() => {});
  set({ status: "off" });
}

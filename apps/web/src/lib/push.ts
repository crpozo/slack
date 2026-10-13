import { create } from "zustand";
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

export const usePush = create<{ status: PushStatus; busy: boolean }>(() => ({
  status: "off",
  busy: false,
}));

const set = (patch: Partial<{ status: PushStatus; busy: boolean }>) => usePush.setState(patch);

const isIos = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** What this browser can do, before asking the server anything. */
export function detectPushSupport(): PushStatus {
  if (typeof window === "undefined" || !tasksApiConfigured()) return "unsupported";
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
  } catch {
    return null;
  }
}

/** Subscribes this browser with the server's key (re-subscribing after a rotation) and saves it. */
async function subscribe(): Promise<void> {
  const publicKey = await pushApi.publicKey();
  const registration = (await registerServiceWorker()) && (await navigator.serviceWorker.ready);
  if (!registration) throw new Error("Service worker unavailable");
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !sameKey(subscription.options.applicationServerKey, publicKey)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToBytes(publicKey),
  });
  await pushApi.subscribe(subscription.toJSON() as Parameters<typeof pushApi.subscribe>[0]);
}

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
    set({ status: "on" });
  } catch (err) {
    set({ status: failureStatus(err) });
  }
}

/** The "Enable notifications" button: asks permission (needs a click), then subscribes. */
export async function enablePush(userId: string): Promise<PushStatus> {
  set({ busy: true });
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      set({ status: permission === "denied" ? "denied" : "off" });
      return usePush.getState().status;
    }
    await subscribe();
    setOptedOut(userId, false);
    set({ status: "on" });
  } catch (err) {
    set({ status: failureStatus(err) });
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

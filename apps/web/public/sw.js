// Service worker (Phase 8): shows Web Push notifications and opens the
// conversation when one is clicked. Served with Cache-Control: no-cache so
// updates reach every browser. Deliberately caches nothing (no offline mode).
//
// Debugging on iPhone: Settings → Safari → Advanced → Web Inspector, then on a
// Mac, Safari → Develop → <phone> → Service Workers. Every step logs as `[sw]`.

const log = (...args) => console.log("[sw]", ...args);
const logError = (...args) => console.error("[sw]", ...args);

self.addEventListener("install", () => {
  log("installed");
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  log("activated");
  event.waitUntil(self.clients.claim());
});

/** The payload sent by the server (`PushPayload`), or a plain-text fallback. */
function parsePayload(event) {
  if (!event.data) return {};
  try {
    return event.data.json();
  } catch {
    return { body: event.data.text() };
  }
}

self.addEventListener("push", (event) => {
  const data = parsePayload(event);
  const title = typeof data.title === "string" && data.title ? data.title : "MindfulTech Slack";
  // One notification per conversation (the tag is the channel/DM id): a newer
  // message replaces the older one of the same chat and re-announces it, while
  // notifications from different chats stack.
  const tag = typeof data.tag === "string" && data.tag ? data.tag : undefined;
  log("push received", { tag, hasTitle: typeof data.title === "string" });
  // iOS (and Chrome) revoke the subscription when a push shows no notification:
  // always show one, even for an unparseable payload.
  event.waitUntil(
    self.registration
      .showNotification(title, {
        body: typeof data.body === "string" ? data.body : "",
        tag,
        renotify: tag !== undefined,
        icon: "/icons/icon-192.png",
        badge: "/icons/badge-96.png",
        data: { url: typeof data.url === "string" ? data.url : "/" },
      })
      .then(
        () => log("notification shown", { tag }),
        (err) => logError("showNotification failed", err),
      ),
  );
});

// The push service replaced this device's subscription (iOS does so after a
// while, Chrome after a key change). Re-subscribe with the same key right away
// so the device keeps a working endpoint; the app saves it on its next launch
// (it always re-sends the current subscription after sign-in).
self.addEventListener("pushsubscriptionchange", (event) => {
  const key = event.oldSubscription?.options?.applicationServerKey ?? null;
  log("subscription changed", { hadKey: key !== null });
  if (!key) return;
  event.waitUntil(
    self.registration.pushManager
      .subscribe({ userVisibleOnly: true, applicationServerKey: key })
      .then(async (subscription) => {
        log("re-subscribed", { host: new URL(subscription.endpoint).host });
        const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        for (const client of windows) client.postMessage({ type: "push.resubscribed" });
      })
      .catch((err) => logError("re-subscribe failed", err)),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url ?? "/", self.location.origin);
  log("notification clicked", { path: target.pathname });
  // Only ever open pages of this app.
  if (target.origin !== self.location.origin) return;
  event.waitUntil(
    (async () => {
      try {
        const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        const open = windows.find((client) => new URL(client.url).origin === target.origin);
        if (open) {
          await open.focus();
          // The SPA navigates itself (keeps its WebSocket and state).
          open.postMessage({ type: "navigate", path: target.pathname });
          return;
        }
        await self.clients.openWindow(target.href);
      } catch (err) {
        logError("notificationclick failed", err);
      }
    })(),
  );
});

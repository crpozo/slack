// Service worker (Phase 8): shows Web Push notifications and opens the
// conversation when one is clicked. Served with Cache-Control: no-cache so
// updates reach every browser. Deliberately caches nothing (no offline mode).

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = typeof data.title === "string" && data.title ? data.title : "MindfulTech Slack";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === "string" ? data.body : "",
      // One notification per conversation, replaced (and re-announced) by newer messages.
      tag: typeof data.tag === "string" ? data.tag : undefined,
      renotify: typeof data.tag === "string",
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      data: { url: typeof data.url === "string" ? data.url : "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url ?? "/", self.location.origin);
  // Only ever open pages of this app.
  if (target.origin !== self.location.origin) return;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((client) => new URL(client.url).origin === target.origin);
      if (open) {
        await open.focus();
        // The SPA navigates itself (keeps its WebSocket and state).
        open.postMessage({ type: "navigate", path: target.pathname });
        return;
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});

import type { WsStatus } from "./ws";

/** API Gateway closes WebSockets idle for 10 minutes; well inside that. */
export const HEARTBEAT_INTERVAL_MS = 3 * 60_000;

interface HeartbeatClient {
  status: WsStatus;
  onStatus: (handler: (status: WsStatus) => void) => () => void;
  send: (action: "ping", payload: { active?: boolean }) => void;
}

/**
 * Sends `{ action: "ping" }` every `intervalMs` while the socket is open.
 * Nothing is sent while connecting or reconnecting (a queued ping would be
 * pointless), and the timer restarts on every (re)connection.
 *
 * With `isActive`, every ping carries `active` (is the app in front of the
 * person?), and one is sent as soon as the socket opens, so the server knows
 * right away not to push to their phone.
 * @returns a function that stops the heartbeat.
 */
export function startHeartbeat(
  client: HeartbeatClient,
  isActive?: () => boolean,
  intervalMs: number = HEARTBEAT_INTERVAL_MS,
): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;

  const stop = () => {
    clearInterval(timer);
    timer = undefined;
  };
  const ping = () => client.send("ping", isActive ? { active: isActive() } : {});
  const start = () => {
    stop();
    if (isActive) ping();
    timer = setInterval(ping, intervalMs);
  };
  const sync = (status: WsStatus) => (status === "open" ? start() : stop());

  sync(client.status);
  const unsubscribe = client.onStatus(sync);
  return () => {
    unsubscribe();
    stop();
  };
}

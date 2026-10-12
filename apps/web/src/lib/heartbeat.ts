import type { WsStatus } from "./ws";

/** API Gateway closes WebSockets idle for 10 minutes; well inside that. */
export const HEARTBEAT_INTERVAL_MS = 3 * 60_000;

interface HeartbeatClient {
  status: WsStatus;
  onStatus: (handler: (status: WsStatus) => void) => () => void;
  send: (action: "ping", payload: Record<never, never>) => void;
}

/**
 * Sends `{ action: "ping" }` every `intervalMs` while the socket is open.
 * Nothing is sent while connecting or reconnecting (a queued ping would be
 * pointless), and the timer restarts on every (re)connection.
 * @returns a function that stops the heartbeat.
 */
export function startHeartbeat(
  client: HeartbeatClient,
  intervalMs: number = HEARTBEAT_INTERVAL_MS,
): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;

  const stop = () => {
    clearInterval(timer);
    timer = undefined;
  };
  const start = () => {
    stop();
    timer = setInterval(() => client.send("ping", {}), intervalMs);
  };
  const sync = (status: WsStatus) => (status === "open" ? start() : stop());

  sync(client.status);
  const unsubscribe = client.onStatus(sync);
  return () => {
    unsubscribe();
    stop();
  };
}

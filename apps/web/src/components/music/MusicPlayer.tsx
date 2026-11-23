import {
  controlsMusic,
  currentTrack,
  MUSIC_DRIFT_SECONDS,
  MUSIC_HEARTBEAT_MS,
  musicPositionMs,
  MUSIC_REACTIONS,
  type MusicRoom,
} from "@mindfultech/shared";
import {
  ChevronDown,
  ChevronUp,
  LogOut,
  Music,
  Pause,
  Play,
  SkipForward,
  Volume2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import { useChat } from "../../store";
import { useMusic } from "../../store/music";

// ---------------------------------------------------------------------------
// Música (Phase 78): the player of the room this person is in. It stays on
// screen over whatever they're doing. The sound is YouTube's own player in a
// frame; this component only keeps it on the room's clock: the server says
// what plays and since when, and every couple of seconds the frame is told to
// play, pause or jump if it has drifted. So everyone hears the same moment,
// and only the DJ's buttons change it.
// ---------------------------------------------------------------------------

const PLACE_KEY = "slack.music.place";
const PLAYER_ORIGIN = "https://www.youtube-nocookie.com";
/** YouTube's player states. */
const ENDED = 0;
const PLAYING = 1;
const BUFFERING = 3;

const clock = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function MusicPlayer() {
  const me = useChat((s) => s.me);
  const showToast = useChat((s) => s.showToast);
  const room = useMusic((s) => s.rooms.find((r) => r.roomId === s.joinedId));
  const offset = useMusic((s) => s.offset);
  const volume = useMusic((s) => s.volume);
  const setVolume = useMusic((s) => s.setVolume);
  const leave = useMusic((s) => s.leave);
  const control = useMusic((s) => s.control);
  const heartbeat = useMusic((s) => s.heartbeat);
  const navigate = useNavigate();
  const [open, setOpen] = useState(true);
  const frame = useRef<HTMLIFrameElement>(null);
  /** What the frame last said about itself. */
  const info = useRef({ time: 0, state: -1, duration: 0, at: 0 });
  const [now, setNow] = useState({ time: 0, duration: 0, state: -1 });
  const endedFor = useRef("");
  const roomRef = useRef<MusicRoom | undefined>(room);
  roomRef.current = room;
  const track = room ? currentTrack(room) : null;
  const dj = !!room && !!me && controlsMusic(room, me.userId, me.role);

  const post = useCallback((func: string, args: unknown[] = []) => {
    frame.current?.contentWindow?.postMessage(
      JSON.stringify({ event: "command", func, args }),
      PLAYER_ORIGIN,
    );
  }, []);

  // Where the frame starts: the room's position at the moment this track is shown.
  const [src, setSrc] = useState("");
  const trackId = track?.id ?? "";
  const videoId = track?.videoId ?? "";
  useEffect(() => {
    const current = roomRef.current;
    if (!current || !videoId) {
      setSrc("");
      return;
    }
    const start = Math.floor(musicPositionMs(current, Date.now() + offset) / 1000);
    info.current = { time: start, state: -1, duration: 0, at: Date.now() };
    endedFor.current = "";
    setSrc(
      `${PLAYER_ORIGIN}/embed/${videoId}?enablejsapi=1&autoplay=1&controls=0&disablekb=1&playsinline=1&rel=0&start=${start}&origin=${encodeURIComponent(location.origin)}`,
    );
    // The offset is read when the track changes, not followed.
  }, [trackId, videoId]);

  // A few seconds for a new track to start before saying the browser held it back.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    setSettled(false);
    const timer = setTimeout(() => setSettled(true), 5000);
    return () => clearTimeout(timer);
  }, [src]);

  // The frame reports its time and state once it's asked to.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== PLAYER_ORIGIN || event.source !== frame.current?.contentWindow) return;
      let data: { event?: string; info?: Record<string, unknown> | null };
      try {
        data = JSON.parse(String(event.data)) as typeof data;
      } catch {
        return;
      }
      const i = data.info;
      if (!i || (data.event !== "infoDelivery" && data.event !== "initialDelivery")) return;
      if (typeof i.currentTime === "number") {
        info.current.time = i.currentTime;
        info.current.at = Date.now();
      }
      if (typeof i.duration === "number" && i.duration > 0) info.current.duration = i.duration;
      if (typeof i.playerState === "number") {
        info.current.state = i.playerState;
        const current = roomRef.current;
        // The song is over: tell the room once (whoever says it first moves everyone on).
        if (i.playerState === ENDED && current?.trackId && endedFor.current !== current.trackId) {
          endedFor.current = current.trackId;
          void control(current.roomId, { action: "ended", trackId: current.trackId }).catch(
            () => {},
          );
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [control]);

  const listen = useCallback(() => {
    frame.current?.contentWindow?.postMessage(
      JSON.stringify({ event: "listening", id: "music", channel: "widget" }),
      PLAYER_ORIGIN,
    );
    post("setVolume", [volume]);
  }, [post, volume]);

  // Keep the frame on the room's clock.
  useEffect(() => {
    if (!src) return;
    const tick = () => {
      const current = roomRef.current;
      if (!current) return;
      listen();
      const expected = musicPositionMs(current, Date.now() + offset) / 1000;
      const { state, time, at, duration } = info.current;
      // What the frame's time is by now (it reports every so often).
      const actual = state === PLAYING ? time + (Date.now() - at) / 1000 : time;
      if (current.playing) {
        if (state !== PLAYING && state !== BUFFERING && state !== ENDED) post("playVideo");
        if (
          Math.abs(actual - expected) > MUSIC_DRIFT_SECONDS &&
          (!duration || expected < duration)
        ) {
          post("seekTo", [expected, true]);
          info.current.time = expected;
          info.current.at = Date.now();
        }
      } else {
        if (state === PLAYING || state === BUFFERING) post("pauseVideo");
        if (Math.abs(time - expected) > MUSIC_DRIFT_SECONDS) post("seekTo", [expected, true]);
      }
      setNow({ time: Math.min(expected, duration || expected), duration, state });
    };
    const timer = setInterval(tick, 1500);
    return () => clearInterval(timer);
  }, [src, offset, post, listen]);

  useEffect(() => post("setVolume", [volume]), [volume, post]);

  // "Still here", so the room knows who is listening.
  const joined = !!room;
  useEffect(() => {
    if (!joined) return;
    const timer = setInterval(() => void heartbeat(), MUSIC_HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [joined, heartbeat]);

  // Movable (Phase 79): dragged by its header, kept on screen, remembered.
  const box = useRef<HTMLElement>(null);
  const [place, setPlace] = useState<{ x: number; y: number } | null>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PLACE_KEY) ?? "null") as unknown;
      const p = saved as { x?: unknown; y?: unknown } | null;
      return p && typeof p.x === "number" && typeof p.y === "number" ? { x: p.x, y: p.y } : null;
    } catch {
      return null;
    }
  });
  const drag = useRef<{ dx: number; dy: number; moved: boolean } | null>(null);
  const clamp = useCallback((x: number, y: number) => {
    const el = box.current;
    const w = el?.offsetWidth ?? 320;
    const h = el?.offsetHeight ?? 100;
    return {
      x: Math.min(Math.max(8, x), Math.max(8, window.innerWidth - w - 8)),
      y: Math.min(Math.max(8, y), Math.max(8, window.innerHeight - Math.min(h, 60) - 8)),
    };
  }, []);
  const onDragStart = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || !box.current) return;
    const rect = box.current.getBoundingClientRect();
    drag.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, moved: false };
  };
  const onDragMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const next = clamp(e.clientX - d.dx, e.clientY - d.dy);
    if (!d.moved) {
      const rect = box.current!.getBoundingClientRect();
      // A few pixels of slack: a click on a button isn't a drag.
      if (Math.abs(next.x - rect.left) + Math.abs(next.y - rect.top) < 5) return;
      d.moved = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    setPlace(next);
  };
  const onDragEnd = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d?.moved) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    const el = box.current;
    if (el) {
      const rect = el.getBoundingClientRect();
      try {
        localStorage.setItem(PLACE_KEY, JSON.stringify({ x: rect.left, y: rect.top }));
      } catch {
        // A nicety.
      }
    }
    // The click that ends a drag isn't a press of what's under it.
    window.addEventListener("click", (c) => c.stopPropagation(), { capture: true, once: true });
  };
  // A smaller window: back inside it.
  useEffect(() => {
    const onResize = () => setPlace((p) => (p ? clamp(p.x, p.y) : p));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clamp]);

  // Who came in or left: said once, in a toast.
  const notice = useMusic((s) => s.notice);
  const said = useRef(0);
  useEffect(() => {
    if (notice && notice.id !== said.current) {
      said.current = notice.id;
      showToast(`🎵 ${notice.text}`, "info");
    }
  }, [notice, showToast]);
  const reactions = useMusic((s) => s.reactions);
  const dropReaction = useMusic((s) => s.dropReaction);

  if (!room) return null;
  const act = (input: Parameters<typeof control>[1]) =>
    void control(room.roomId, input).catch((err: unknown) =>
      showToast(err instanceof Error ? err.message : "No se pudo.", "error"),
    );
  // The browser didn't let it start by itself: one tap from the person does.
  const blocked =
    settled && room.playing && !!src && now.state !== PLAYING && now.state !== BUFFERING;

  return (
    <aside
      ref={box}
      style={place ? { left: place.x, top: place.y } : undefined}
      className={`glass-strong fixed z-40 w-[min(20rem,calc(100vw-1.5rem))] overflow-hidden rounded-2xl border border-white/10 text-ink shadow-2xl ${
        place ? "" : "bottom-24 right-3 md:bottom-4 md:right-4"
      }`}
      aria-label={`Música: ${room.name}`}
      data-music-player={room.roomId}
    >
      <header
        className="flex cursor-grab touch-none select-none items-center gap-2 px-3 py-2 active:cursor-grabbing"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        title="Arrastra para mover"
        data-music-drag
      >
        <Music size={16} className="shrink-0 text-primary" aria-hidden="true" />
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={() => void navigate("/app/music")}
          title="Abrir las salas de música"
        >
          <span className="block truncate text-sm font-semibold">{room.name}</span>
          <span className="block truncate text-xs text-ink-secondary">
            {track ? track.title : "Sin canciones todavía"}
          </span>
        </button>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="rounded-md p-1 text-ink-secondary hover:bg-surface-hover hover:text-ink"
          aria-label={open ? "Minimizar el reproductor" : "Mostrar el reproductor"}
        >
          {open ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
        </button>
        <button
          type="button"
          onClick={() => void leave()}
          className="rounded-md p-1 text-ink-secondary hover:bg-error/15 hover:text-error"
          aria-label="Salir de la sala"
          title="Salir de la sala"
        >
          <LogOut size={16} />
        </button>
      </header>
      {/* Kept mounted when minimized, so the music goes on. */}
      <div className={open ? "" : "h-0 overflow-hidden"}>
        <div className="relative aspect-video bg-black">
          {src ? (
            <iframe
              ref={frame}
              key={trackId}
              src={src}
              title={track?.title ?? "Música"}
              allow="autoplay; encrypted-media"
              referrerPolicy="strict-origin-when-cross-origin"
              onLoad={listen}
              // The room decides what plays: the frame itself isn't clickable.
              className="pointer-events-none h-full w-full"
            />
          ) : (
            <p className="flex h-full items-center justify-center px-4 text-center text-xs text-white/70">
              {dj
                ? "Agrega un enlace de YouTube en la sala para empezar."
                : "El DJ aún no ha puesto música."}
            </p>
          )}
          {/* Reactions float up over the picture and go. */}
          <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-live="polite">
            {reactions.map((r, i) => (
              <span
                key={r.id}
                onAnimationEnd={() => dropReaction(r.id)}
                style={{ left: `${10 + ((r.id * 37 + i * 11) % 70)}%` }}
                className="music-reaction absolute bottom-1 flex flex-col items-center text-2xl"
              >
                {r.emoji}
                <span className="rounded bg-black/55 px-1 text-[10px] font-semibold text-white">
                  {r.name}
                </span>
              </span>
            ))}
          </div>
          {blocked && (
            <button
              type="button"
              onClick={() => post("playVideo")}
              className="absolute inset-0 flex items-center justify-center bg-black/55 text-sm font-semibold text-white"
            >
              ▶ Toca para escuchar
            </button>
          )}
        </div>
        <div className="space-y-2 px-3 py-2">
          <div className="flex items-center gap-2 text-xs tabular-nums text-ink-secondary">
            <span>{clock(now.time)}</span>
            <input
              type="range"
              min={0}
              max={Math.max(1, Math.floor(now.duration))}
              value={Math.min(Math.floor(now.time), Math.floor(now.duration) || 0)}
              disabled={!dj || !now.duration}
              onChange={(e) => act({ action: "seek", positionMs: Number(e.target.value) * 1000 })}
              aria-label="Posición de la canción"
              className="h-1 min-w-0 flex-1 accent-primary disabled:opacity-60"
            />
            <span>{now.duration ? clock(now.duration) : "--:--"}</span>
          </div>
          <div className="flex items-center gap-2">
            {dj && (
              <>
                <button
                  type="button"
                  onClick={() => act({ action: room.playing ? "pause" : "play" })}
                  disabled={!track}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-on-primary disabled:opacity-50"
                  aria-label={room.playing ? "Pausar para todos" : "Reproducir para todos"}
                  title={room.playing ? "Pausar para todos" : "Reproducir para todos"}
                >
                  {room.playing ? <Pause size={16} /> : <Play size={16} />}
                </button>
                <button
                  type="button"
                  onClick={() => act({ action: "next" })}
                  disabled={room.queue.length < 2}
                  className="rounded-md p-1.5 text-ink-secondary hover:bg-surface-hover hover:text-ink disabled:opacity-40"
                  aria-label="Siguiente canción"
                  title="Siguiente canción"
                >
                  <SkipForward size={16} />
                </button>
              </>
            )}
            <Volume2 size={16} className="ml-auto shrink-0 text-ink-secondary" aria-hidden="true" />
            <input
              type="range"
              min={0}
              max={100}
              value={volume}
              onChange={(e) => setVolume(Number(e.target.value))}
              aria-label="Tu volumen"
              title="Tu volumen (solo para ti)"
              className="h-1 w-24 accent-primary"
            />
          </div>
          <div
            className="flex items-center justify-between gap-1"
            role="group"
            aria-label="Reaccionar"
          >
            {MUSIC_REACTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => act({ action: "react", emoji })}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-lg transition hover:scale-125 hover:bg-surface-hover"
                aria-label={`Reaccionar con ${emoji}`}
                title="Que todos lo vean"
              >
                {emoji}
              </button>
            ))}
          </div>
          <p className="text-xs text-ink-secondary" data-music-listeners>
            DJ: {room.djName} · {room.listeners.length}{" "}
            {room.listeners.length === 1 ? "persona escuchando" : "personas escuchando"}
            {room.listeners.length > 0 && `: ${room.listeners.map((l) => l.name).join(", ")}`}
          </p>
        </div>
      </div>
    </aside>
  );
}

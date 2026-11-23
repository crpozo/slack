import {
  canUseMusic,
  controlsMusic,
  currentTrack,
  MAX_MUSIC_ROOM_NAME,
  type MusicRoom,
} from "@mindfultech/shared";
import { Headphones, Music, Play, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { tasksApiConfigured } from "../../lib/tasksApi";
import { useChat } from "../../store";
import { useMusic } from "../../store/music";
import { MenuIcon } from "../icons";

/**
 * Música (`/app/music`, Phase 78): the rooms. Anyone on the team opens one
 * (and is its DJ), joins one or leaves; the DJ queues YouTube links and
 * decides what plays for everyone. The sound itself is the floating player
 * (`MusicPlayer`), which stays on while you work elsewhere.
 */
function RoomCard({ room }: Readonly<{ room: MusicRoom }>) {
  const me = useChat((s) => s.me);
  const showToast = useChat((s) => s.showToast);
  const joinedId = useMusic((s) => s.joinedId);
  const busy = useMusic((s) => s.busy);
  const join = useMusic((s) => s.join);
  const leave = useMusic((s) => s.leave);
  const remove = useMusic((s) => s.remove);
  const control = useMusic((s) => s.control);
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const mine = joinedId === room.roomId;
  const dj = !!me && controlsMusic(room, me.userId, me.role);
  const track = currentTrack(room);
  const djHere = room.listeners.some((l) => l.userId === room.djId);
  const fail = (err: unknown) =>
    showToast(err instanceof Error ? err.message : "No se pudo completar.", "error");

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!url.trim() || adding) return;
    setAdding(true);
    try {
      await control(room.roomId, { action: "add", url: url.trim() });
      setUrl("");
    } catch (err) {
      fail(err);
    }
    setAdding(false);
  }

  return (
    <li
      className={`rounded-2xl border p-4 ${mine ? "border-primary/60 bg-primary/5" : "border-line"}`}
      data-music-room={room.roomId}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-bold text-ink">
            <Music size={18} className="shrink-0 text-primary" aria-hidden="true" />
            <span className="truncate">{room.name}</span>
            {room.playing && (
              <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-semibold text-primary">
                En vivo
              </span>
            )}
          </h2>
          <p className="mt-0.5 text-sm text-ink-secondary">
            DJ: {room.djName}
            {!djHere && " (no está en la sala)"}
          </p>
          <p className="mt-1 truncate text-sm text-ink">
            {track ? `♪ ${track.title}` : "Sin música todavía"}
          </p>
          <p className="mt-1 flex items-center gap-1.5 text-xs text-ink-secondary">
            <Headphones size={14} aria-hidden="true" />
            {room.listeners.length === 0
              ? "Nadie escuchando"
              : room.listeners.map((l) => l.name).join(", ")}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {mine ? (
            <button
              type="button"
              onClick={() => void leave()}
              className="rounded-lg border border-line px-3 py-1.5 text-sm font-semibold text-ink hover:bg-surface-hover"
            >
              Salir
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => void join(room.roomId).catch(fail)}
              className="btn-primary"
            >
              <Play size={16} aria-hidden="true" />
              Unirme
            </button>
          )}
          {mine && !dj && !djHere && (
            <button
              type="button"
              onClick={() => void control(room.roomId, { action: "claim" }).catch(fail)}
              className="rounded-lg border border-line px-3 py-1.5 text-sm font-semibold text-ink hover:bg-surface-hover"
              title="El DJ no está: toma el control de la sala"
            >
              Ser el DJ
            </button>
          )}
          {dj &&
            (confirming ? (
              <button
                type="button"
                onClick={() => void remove(room.roomId).catch(fail)}
                className="rounded-lg bg-error/15 px-3 py-1.5 text-sm font-semibold text-error"
              >
                Sí, eliminar la sala
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="rounded-lg p-2 text-ink-secondary hover:bg-error/15 hover:text-error"
                aria-label={`Eliminar la sala ${room.name}`}
                title="Eliminar la sala"
              >
                <Trash2 size={16} />
              </button>
            ))}
        </div>
      </div>

      {(mine || dj) && (
        <div className="mt-3 border-t border-line pt-3">
          {dj && (
            <form onSubmit={(e) => void add(e)} className="mb-2 flex gap-2">
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="Pega un enlace de YouTube…"
                aria-label="Enlace de YouTube"
                className="input min-w-0 flex-1"
              />
              <button
                type="submit"
                className="btn-primary shrink-0"
                disabled={adding || !url.trim()}
              >
                {adding ? "Agregando…" : "Agregar"}
              </button>
            </form>
          )}
          {room.queue.length === 0 ? (
            <p className="text-sm text-ink-secondary">
              {dj ? "La lista está vacía: agrega la primera canción." : "La lista está vacía."}
            </p>
          ) : (
            <ol className="space-y-1" aria-label="Lista de canciones">
              {room.queue.map((t, i) => {
                const on = t.id === room.trackId;
                return (
                  <li
                    key={t.id}
                    className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${on ? "bg-primary/10" : ""}`}
                  >
                    <span className="w-5 shrink-0 text-xs tabular-nums text-ink-secondary">
                      {on ? "♪" : i + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={`block truncate ${on ? "font-semibold text-ink" : "text-ink"}`}
                      >
                        {t.title}
                      </span>
                      <span className="block truncate text-xs text-ink-secondary">
                        Agregada por {t.addedByName}
                      </span>
                    </span>
                    {dj && !on && (
                      <button
                        type="button"
                        onClick={() =>
                          void control(room.roomId, { action: "select", trackId: t.id }).catch(fail)
                        }
                        className="rounded-md p-1.5 text-ink-secondary hover:bg-surface-hover hover:text-ink"
                        aria-label={`Reproducir ${t.title}`}
                        title="Reproducir ahora para todos"
                      >
                        <Play size={14} />
                      </button>
                    )}
                    {dj && (
                      <button
                        type="button"
                        onClick={() =>
                          void control(room.roomId, { action: "remove", trackId: t.id }).catch(fail)
                        }
                        className="rounded-md p-1.5 text-ink-secondary hover:bg-error/15 hover:text-error"
                        aria-label={`Quitar ${t.title}`}
                        title="Quitar de la lista"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}
    </li>
  );
}

export function MusicView({ onOpenSidebar }: Readonly<{ onOpenSidebar?: () => void }>) {
  const me = useChat((s) => s.me);
  const showToast = useChat((s) => s.showToast);
  const rooms = useMusic((s) => s.rooms);
  const loaded = useMusic((s) => s.loaded);
  const error = useMusic((s) => s.error);
  const busy = useMusic((s) => s.busy);
  const load = useMusic((s) => s.load);
  const create = useMusic((s) => s.create);
  const [name, setName] = useState("");
  const allowed = canUseMusic(me?.role) && tasksApiConfigured();
  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  async function open(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    try {
      await create(name.trim());
      setName("");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "No se pudo crear la sala.", "error");
    }
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-music-view>
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2.5 sm:px-4">
        {onOpenSidebar && (
          <button
            type="button"
            onClick={onOpenSidebar}
            className="rounded-md p-1.5 text-ink-secondary hover:bg-surface-hover md:hidden"
            aria-label="Abrir el menú"
          >
            <MenuIcon />
          </button>
        )}
        <h1 className="text-base font-bold text-ink">Música</h1>
        <span className="hidden text-xs text-ink-secondary sm:inline">
          Todos escuchan lo mismo, al mismo tiempo
        </span>
      </header>
      {!allowed ? (
        <p className="p-6 text-sm text-ink-secondary">
          {canUseMusic(me?.role)
            ? "La música no está configurada en este despliegue."
            : "La música es para el equipo de MindfulTech."}
        </p>
      ) : (
        <main className="min-h-0 flex-1 overflow-y-auto p-3 pb-40 sm:p-4 sm:pb-40">
          <form onSubmit={(e) => void open(e)} className="mb-4 flex flex-wrap gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={MAX_MUSIC_ROOM_NAME}
              placeholder="Nombre de la sala: Viernes de rock, Foco, Lo-fi…"
              aria-label="Nombre de la sala"
              className="input min-w-0 flex-1"
            />
            <button type="submit" className="btn-primary" disabled={busy || !name.trim()}>
              Crear sala y ser el DJ
            </button>
          </form>
          {error && (
            <p
              role="alert"
              className="mb-3 rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-sm text-ink"
            >
              {error}
            </p>
          )}
          {!loaded ? (
            <p className="text-sm text-ink-secondary" aria-busy="true">
              Cargando…
            </p>
          ) : rooms.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-line p-8 text-center">
              <Music size={28} className="mx-auto text-primary" aria-hidden="true" />
              <p className="mt-2 text-sm font-semibold text-ink">Aún no hay salas</p>
              <p className="mt-1 text-sm text-ink-secondary">
                Crea una, pega enlaces de YouTube y el resto del equipo se une para escuchar lo
                mismo que tú, en el mismo segundo.
              </p>
            </div>
          ) : (
            <ul className="space-y-3">
              {rooms.map((room) => (
                <RoomCard key={room.roomId} room={room} />
              ))}
            </ul>
          )}
        </main>
      )}
    </div>
  );
}

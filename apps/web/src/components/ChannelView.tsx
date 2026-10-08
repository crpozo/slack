import { canAccessChannel, isDmChannel } from "@mindfultech/shared";
import { useRef, useState, type DragEvent } from "react";
import { Link } from "react-router-dom";
import { channelLabel } from "../lib/channels";
import { useChat } from "../store";
import { Composer, type ComposerHandle } from "./Composer";
import { HashIcon, MenuIcon } from "./icons";
import { MessageList } from "./MessageList";

export function ChannelView({
  channelId,
  onOpenSidebar,
}: {
  channelId: string;
  onOpenSidebar: () => void;
}) {
  const me = useChat((s) => s.me);
  const channel = useChat((s) => s.channels.find((c) => c.channelId === channelId));
  const channelsLoaded = useChat((s) => s.channelsLoaded);
  const directory = useChat((s) => s.directory);
  const composer = useRef<ComposerHandle>(null);
  const [dragging, setDragging] = useState(false);

  if (!me) return null;
  const dm = isDmChannel(channelId);
  const label = channelLabel(channelId, channel, me.userId, directory);
  const title = dm ? label : `#${label}`;
  const allowed = canAccessChannel(channelId, me.userId);
  const notFound = !allowed || (channelsLoaded && !channel && !dm);

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) composer.current?.addFiles(e.dataTransfer.files);
  }

  return (
    <div
      className="relative flex h-full min-h-0 flex-col"
      onDragOver={(e) => {
        if (!channel || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={handleDrop}
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3 sm:px-4">
        <button
          type="button"
          onClick={onOpenSidebar}
          className="rounded-md p-2 text-ink-secondary hover:bg-surface-hover hover:text-ink md:hidden"
          aria-label="Abrir menú"
        >
          <MenuIcon />
        </button>
        {!dm && <HashIcon className="text-ink-secondary" />}
        <h1 className="truncate font-semibold text-ink">{label}</h1>
      </header>

      {notFound ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-ink">Este canal no existe o no tienes acceso.</p>
          <Link to="/app/ch_general" className="btn-primary">
            Ir a #general
          </Link>
        </div>
      ) : (
        <>
          <MessageList channelId={channelId} title={title} />
          <Composer
            key={channelId}
            ref={composer}
            channelId={channelId}
            disabled={!channel}
            placeholder={channel ? `Escribe en ${title}` : "Abriendo conversación…"}
          />
        </>
      )}

      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-primary/10">
          <p className="rounded-lg bg-surface px-4 py-2 text-sm font-semibold text-ink shadow">
            Suelta para adjuntar a {title}
          </p>
        </div>
      )}
    </div>
  );
}

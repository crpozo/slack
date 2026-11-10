import { MAX_EXTERNAL_NAME, type CallMedia } from "@mindfultech/shared";
import { useEffect, useState, type FormEvent } from "react";
import {
  leaveExternalCall,
  parseCallLink,
  startExternalCall,
  stopExternalCall,
  useExternalCall,
} from "../lib/externalCall";
import { useGroupCall } from "../lib/groupCall";
import { supportsCalls } from "../lib/media";
import { ControlButton, Controls, Grid } from "./GroupCall";
import { PhoneOffIcon, VideoIcon, MicIcon } from "./icons";
import { Logo } from "./LoginPage";
import { StreamMedia } from "./StreamMedia";

// ---------------------------------------------------------------------------
// Phase 59: the page a call link opens. Only the call: a name, the lobby, the
// video grid and screen share. No sidebar, no channel, no chat, no history:
// this page never starts the chat, and its socket can't reach any of it.
// ---------------------------------------------------------------------------

function Shell({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <main
      className="flex h-full min-h-0 flex-col bg-[#0E0D12] text-white"
      data-external-call
      aria-label="MindfulTech call"
    >
      {children}
    </main>
  );
}

function Card({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex flex-1 items-center justify-center p-4">
      <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-2xl border border-white/10 bg-white/[0.04] p-6 text-center">
        <Logo />
        {children}
      </div>
    </div>
  );
}

function NameStep({
  wsUrl,
  roomId,
  token,
}: Readonly<{ wsUrl: string; roomId: string; token: string }>) {
  const saved = useExternalCall((s) => s.name);
  const note = useExternalCall((s) => s.note);
  const [name, setName] = useState(saved);
  const join = (media: CallMedia) => startExternalCall({ wsUrl, roomId, token, name, media });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    join("video");
  };
  return (
    <Card>
      <h1 className="text-lg font-semibold">You're invited to a call</h1>
      <p className="text-sm text-white/70">
        Tell them who you are. Someone in the call will let you in.
      </p>
      <form onSubmit={onSubmit} className="flex w-full flex-col gap-3">
        <label className="flex flex-col gap-1 text-left text-xs text-white/70">
          Your name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={MAX_EXTERNAL_NAME}
            autoFocus
            autoComplete="name"
            className="rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-primary"
            placeholder="Ana Pérez"
          />
        </label>
        {note && (
          <p role="alert" className="text-xs text-warning">
            {note}
          </p>
        )}
        <button
          type="submit"
          disabled={!name.trim()}
          className="flex items-center justify-center gap-2 rounded-full bg-success px-4 py-2 text-sm font-semibold text-on-accent hover:brightness-95 disabled:opacity-50"
        >
          <VideoIcon aria-hidden="true" /> Join with camera
        </button>
        <button
          type="button"
          disabled={!name.trim()}
          onClick={() => join("audio")}
          className="flex items-center justify-center gap-2 rounded-full bg-white/10 px-4 py-2 text-sm font-semibold hover:bg-white/15 disabled:opacity-50"
        >
          <MicIcon aria-hidden="true" /> Join with microphone only
        </button>
      </form>
    </Card>
  );
}

function InCall() {
  const call = useGroupCall((s) => s.call);
  const note = useExternalCall((s) => s.note);
  if (!call) {
    return (
      <Card>
        <p className="text-sm text-white/70" aria-live="polite">
          Joining the call…
        </p>
      </Card>
    );
  }
  return (
    <>
      <header className="flex items-center gap-2 px-4 py-2 text-sm">
        <span className="h-2 w-2 shrink-0 rounded-full bg-success" aria-hidden="true" />
        <p className="font-semibold">MindfulTech call</p>
        <p className="text-white/70">
          · {call.phase === "joining" ? "Joining…" : `${call.peers.length + 1} in the call`}
        </p>
      </header>
      {note && (
        <p role="status" className="px-4 text-xs text-warning">
          {note}
        </p>
      )}
      <div className="min-h-0 flex-1">
        <Grid call={call} />
      </div>
      <footer className="flex items-center justify-center gap-3 px-4 py-3">
        <Controls call={call} />
        <ControlButton label="Leave the call" danger onClick={leaveExternalCall}>
          <PhoneOffIcon />
        </ControlButton>
      </footer>
      {call.peers.map((p) => (
        <StreamMedia key={p.userId} kind="audio" stream={p.stream} />
      ))}
    </>
  );
}

const ENDINGS: Record<
  "denied" | "ended" | "left",
  { title: string; text: string; again: boolean }
> = {
  denied: {
    title: "You weren't let in",
    text: "Someone in the call said no. You can ask again.",
    again: true,
  },
  ended: {
    title: "This call has ended",
    text: "The link only works while the call goes on.",
    again: false,
  },
  left: { title: "You left the call", text: "You can join again while it goes on.", again: true },
};

/** `/call/<roomId>?token=…`: a call link, outside the app (no session needed or used). */
export function ExternalCallPage({ wsUrl }: Readonly<{ wsUrl: string }>) {
  const [link] = useState(() => parseCallLink(location));
  const status = useExternalCall((s) => s.status);
  const note = useExternalCall((s) => s.note);
  useEffect(() => () => stopExternalCall(), []);

  if (!link || !supportsCalls()) {
    return (
      <Shell>
        <Card>
          <h1 className="text-lg font-semibold">
            {link ? "Calls don't work here" : "This link isn't valid"}
          </h1>
          <p className="text-sm text-white/70">
            {link
              ? "Open the link in a recent Chrome, Edge, Firefox or Safari."
              : "Ask whoever sent it for the call's link again."}
          </p>
        </Card>
      </Shell>
    );
  }
  if (status === "name") {
    return (
      <Shell>
        <NameStep wsUrl={wsUrl} roomId={link.roomId} token={link.token} />
      </Shell>
    );
  }
  if (status === "connecting" || status === "waiting") {
    return (
      <Shell>
        <Card>
          <span
            className="h-6 w-6 animate-spin rounded-full border-2 border-white/30 border-t-white motion-reduce:animate-none"
            aria-hidden="true"
          />
          <p className="text-sm" aria-live="polite" data-lobby={status}>
            {status === "connecting"
              ? "Connecting…"
              : "Waiting for someone in the call to let you in…"}
          </p>
          <button
            type="button"
            onClick={leaveExternalCall}
            className="rounded-full bg-white/10 px-4 py-1.5 text-sm hover:bg-white/15"
          >
            Cancel
          </button>
        </Card>
      </Shell>
    );
  }
  if (status === "in-call") {
    return (
      <Shell>
        <InCall />
      </Shell>
    );
  }
  const ending = ENDINGS[status];
  return (
    <Shell>
      <Card>
        <h1 className="text-lg font-semibold">{ending.title}</h1>
        <p className="text-sm text-white/70">{note ?? ending.text}</p>
        {ending.again && (
          <button
            type="button"
            onClick={() => useExternalCall.setState({ status: "name", note: null })}
            className="rounded-full bg-success px-4 py-1.5 text-sm font-semibold text-on-accent hover:brightness-95"
          >
            Ask to join again
          </button>
        )}
      </Card>
    </Shell>
  );
}

import { transcribableAudio, type Message } from "@mindfultech/shared";
import { useEffect, useRef, useState } from "react";
import { messagesApi } from "../lib/messagesApi";
import { TasksApiError } from "../lib/tasksApi";
import { useChat } from "../store";
import { CaptionsIcon } from "./icons";

/** While someone else's request is transcribing the same note (409), ask again this often. */
export const TRANSCRIBE_RETRY_MS = 2_500;
/** …this many times (about the Lambda's 30 s) before giving up. */
const TRANSCRIBE_RETRIES = 12;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Phase 58: under a voice message, "Transcribir" until someone has asked for
 * its transcript; then the text, in a quiet left-bordered block. The server
 * makes it once (Whisper) and keeps it on the message, so it shows at once
 * for everyone after, in this session and in the history.
 */
export function VoiceTranscript({ message }: Readonly<{ message: Message }>) {
  const setTranscript = useChat((s) => s.setTranscript);
  const showToast = useChat((s) => s.showToast);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  if (!transcribableAudio(message)) return null;

  if (typeof message.transcript === "string") {
    return (
      <blockquote
        className="mt-1.5 max-w-[520px] rounded-r-lg border-l-2 border-primary/50 bg-white/[0.03] py-1.5 pl-3 pr-2.5 text-[13px] leading-relaxed text-ink/90 backdrop-blur-sm"
        aria-label="Transcripción del audio"
        data-transcript
      >
        <span className="mb-0.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-ink-secondary">
          <CaptionsIcon aria-hidden="true" /> Transcripción
        </span>
        {message.transcript ? (
          <p className="whitespace-pre-wrap break-words">{message.transcript}</p>
        ) : (
          <p className="italic text-ink-secondary">No se escuchó voz en este audio.</p>
        )}
      </blockquote>
    );
  }

  async function transcribe() {
    setBusy(true);
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const { transcript } = await messagesApi.transcribe(message.channelId, message.sk);
          setTranscript(message.channelId, message.sk, transcript);
          return;
        } catch (err) {
          // Someone else clicked first: theirs is coming, ask again shortly.
          if (err instanceof TasksApiError && err.status === 409 && attempt < TRANSCRIBE_RETRIES) {
            await wait(TRANSCRIBE_RETRY_MS);
            if (!alive.current) return;
            continue;
          }
          throw err;
        }
      }
    } catch (err) {
      showToast(
        err instanceof TasksApiError && err.message
          ? err.message
          : "No se pudo transcribir. Inténtalo de nuevo.",
        "error",
      );
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void transcribe()}
      disabled={busy}
      className="mt-1 inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs text-ink-secondary transition hover:bg-white/[0.06] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-wait disabled:opacity-80"
      aria-label={busy ? "Transcribiendo el audio" : "Transcribir el audio"}
      data-transcribe={busy ? "busy" : "idle"}
    >
      {busy ? (
        <span
          className="h-3 w-3 animate-spin rounded-full border-2 border-ink-secondary/40 border-t-ink-secondary motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : (
        <CaptionsIcon aria-hidden="true" />
      )}
      {busy ? "Transcribiendo…" : "Transcribir"}
    </button>
  );
}

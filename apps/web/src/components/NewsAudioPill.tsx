import { useNavigate } from "react-router-dom";
import { clock, rateLabel, useNewsPlayer } from "../lib/newsPlayer";
import { CloseIcon, HeadphonesIcon, PauseIcon, PlayIcon } from "./icons";

/**
 * Phase 56: the AI News audio keeps playing when you leave AI News; this
 * pill (anywhere else in the app) shows it, pauses it, or stops it. Tapping
 * its label goes back to AI News.
 */
export function NewsAudioPill({ hidden = false }: Readonly<{ hidden?: boolean }>) {
  const navigate = useNavigate();
  const { track, playing, position, duration, stop, rate, cycleRate } = useNewsPlayer();
  if (!track || hidden) return null;
  return (
    <div
      className="glass-strong fixed bottom-24 right-3 z-30 flex items-center gap-1 rounded-full border border-white/10 py-1 pl-1 pr-1 shadow-lg md:bottom-4 md:right-4"
      role="region"
      aria-label="Resumen de AI News en audio"
      data-news-audio-pill
    >
      <button
        type="button"
        onClick={() => {
          // The loaded track's own URL is in the player: toggling needs only its key.
          const player = useNewsPlayer.getState();
          player.toggle(player.track ?? "");
        }}
        className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-on-primary"
        aria-label={playing ? "Pausar" : "Reproducir"}
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </button>
      <button
        type="button"
        onClick={() => void navigate("/app/news")}
        className="flex items-center gap-1.5 px-2 text-xs font-semibold text-ink"
        title="Ir a AI News"
      >
        <HeadphonesIcon className="text-primary" aria-hidden="true" />
        AI News
        <span className="font-mono font-normal tabular-nums text-ink-secondary">
          {clock(position)}
          {duration > 0 && ` / ${clock(duration)}`}
        </span>
      </button>
      <button
        type="button"
        onClick={cycleRate}
        className={`rounded-full px-2 py-1 font-mono text-[11px] font-semibold tabular-nums hover:bg-white/10 ${
          rate === 1 ? "text-ink-secondary" : "text-primary"
        }`}
        aria-label={`Velocidad ${rateLabel(rate)}. Cambiar velocidad`}
        title="Cambiar velocidad"
      >
        {rateLabel(rate)}
      </button>
      <button
        type="button"
        onClick={stop}
        className="flex h-8 w-8 items-center justify-center rounded-full text-ink-secondary hover:bg-white/10 hover:text-ink"
        aria-label="Detener el audio"
        title="Detener"
      >
        <CloseIcon />
      </button>
    </div>
  );
}

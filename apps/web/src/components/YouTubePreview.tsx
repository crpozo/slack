import { useState } from "react";
import { embedUrl, thumbnailUrl, watchUrl, type YouTubeVideo } from "../lib/youtube";

/**
 * A YouTube link's player, click to play (Phase 33): until someone plays it,
 * only its thumbnail (from i.ytimg.com) loads, so a channel full of links
 * doesn't start dozens of players as it scrolls. A click swaps in the
 * privacy-enhanced player, autoplaying, fading in over the thumbnail.
 */
export function YouTubePreview({ video }: Readonly<{ video: YouTubeVideo }>) {
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [noThumbnail, setNoThumbnail] = useState(false);

  return (
    <div
      className="relative mt-1.5 aspect-video w-full max-w-md overflow-hidden rounded-md border border-line bg-black"
      data-youtube={video.id}
    >
      {!ready && (
        <button
          type="button"
          onClick={() => setPlaying(true)}
          disabled={playing}
          aria-label="Play YouTube video"
          title="Play here"
          className="group/yt absolute inset-0 flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
        >
          {!noThumbnail && (
            <img
              src={thumbnailUrl(video.id)}
              alt=""
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              onError={() => setNoThumbnail(true)}
              className={`absolute inset-0 h-full w-full object-cover transition duration-300 ${
                playing ? "scale-[1.02] brightness-50" : "group-hover/yt:brightness-90"
              }`}
            />
          )}
          {playing ? (
            <span
              className="relative h-10 w-10 animate-spin rounded-full border-4 border-white/80 border-t-transparent"
              aria-label="Loading the video"
            />
          ) : (
            <span
              className="relative flex h-12 w-[4.25rem] items-center justify-center rounded-2xl bg-[#ff0033] shadow-lg transition-transform group-hover/yt:scale-110"
              aria-hidden="true"
            >
              <svg viewBox="0 0 24 24" width="24" height="24" fill="white">
                <path d="M8 5.5v13l11-6.5z" />
              </svg>
            </span>
          )}
        </button>
      )}
      {playing && (
        <iframe
          src={embedUrl(video)}
          title="YouTube video player"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          onLoad={() => setReady(true)}
          className={`absolute inset-0 h-full w-full border-0 transition-opacity duration-300 ${
            ready ? "opacity-100" : "opacity-0"
          }`}
        />
      )}
      <a
        href={watchUrl(video)}
        target="_blank"
        rel="noopener noreferrer"
        className={`absolute right-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white/90 hover:bg-black/80 ${
          ready ? "hidden" : ""
        }`}
      >
        YouTube ↗
      </a>
    </div>
  );
}

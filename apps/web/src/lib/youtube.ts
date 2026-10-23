// ---------------------------------------------------------------------------
// YouTube previews in messages (Phase 33). Links are found the way the
// message renderer finds them, then each one is parsed with `URL` (not one
// big regex): any parameter order, mobile and Music hosts, Shorts and live
// links. Nothing reaches the player unless the video id is exactly YouTube's
// 11 characters.
// ---------------------------------------------------------------------------

import { URL_PATTERN } from "./markdown";

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const WATCH_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);
/** Paths that name the video: `/shorts/<id>`, `/embed/<id>`, `/live/<id>`, `/v/<id>`. */
const PATH_ID = /^\/(?:shorts|embed|live|v)\/([^/?#]+)/;

/** At most this many players under one message. */
export const MAX_VIDEOS_PER_MESSAGE = 2;

export interface YouTubeVideo {
  id: string;
  /** Where to start, in seconds (`t=`, `start=`; 0 when absent). */
  start: number;
}

/** `90`, `90s`, `1m30s`, `1h2m3s` → seconds; anything else is 0. */
export function parseStart(value: string | null | undefined): number {
  if (!value) return 0;
  if (/^\d+s?$/.test(value)) return Number.parseInt(value, 10);
  const parts = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  if (!parts) return 0;
  const [, h = "0", m = "0", s = "0"] = parts;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

/** The video a link points at, or `null` for anything that isn't a YouTube video. */
export function youTubeVideoOf(link: string): YouTubeVideo | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  let id: string | null = null;
  if (host === "youtu.be" || host === "www.youtu.be") {
    id = url.pathname.split("/")[1] ?? null;
  } else if (WATCH_HOSTS.has(host)) {
    id =
      url.pathname === "/watch"
        ? url.searchParams.get("v")
        : (PATH_ID.exec(url.pathname)?.[1] ?? null);
  }
  if (!id || !VIDEO_ID.test(id)) return null;
  const fragment = new URLSearchParams(url.hash.slice(1));
  const start = parseStart(
    url.searchParams.get("t") ?? url.searchParams.get("start") ?? fragment.get("t"),
  );
  return { id, start };
}

/**
 * The videos a message links to, in order, each once, at most
 * `MAX_VIDEOS_PER_MESSAGE`. Links inside code (`inline` or fenced) are
 * someone showing a URL, not sharing a video.
 */
export function youTubeVideosIn(text: string): YouTubeVideo[] {
  const prose = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  const videos: YouTubeVideo[] = [];
  // The same links the message renderer turns into anchors.
  for (const [link] of prose.matchAll(URL_PATTERN)) {
    const video = youTubeVideoOf(link);
    if (!video || videos.some((v) => v.id === video.id)) continue;
    videos.push(video);
    if (videos.length === MAX_VIDEOS_PER_MESSAGE) break;
  }
  return videos;
}

/** The thumbnail shown until someone plays it (exists for every video). */
export const thumbnailUrl = (id: string) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

/** The player, privacy-enhanced (no cookies until played), playing at once since it was clicked. */
export function embedUrl({ id, start }: YouTubeVideo): string {
  const params = new URLSearchParams({ autoplay: "1", rel: "0", playsinline: "1" });
  if (start > 0) params.set("start", String(start));
  return `https://www.youtube-nocookie.com/embed/${id}?${params.toString()}`;
}

/** Where "Watch on YouTube" goes (and the link people already have). */
export const watchUrl = ({ id, start }: YouTubeVideo) =>
  `https://www.youtube.com/watch?v=${id}${start > 0 ? `&t=${start}s` : ""}`;

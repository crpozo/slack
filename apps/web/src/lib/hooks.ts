import { useEffect, useState } from "react";

/** Tailwind's `md` breakpoint: phones are narrower. */
export const DESKTOP_QUERY = "(min-width: 768px)";
export const MOBILE_QUERY = "(max-width: 767px)";

/** Whether `query` matches now, re-rendering when that changes (a rotation, a resize). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/**
 * The current time, refreshed every `intervalMs` and when the tab comes back
 * to the foreground (timers are throttled in background tabs, and a phone
 * that slept through the minute shouldn't show a stale button).
 */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const id = setInterval(tick, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs]);
  return now;
}

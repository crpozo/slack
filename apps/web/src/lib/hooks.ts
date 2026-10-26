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

/** Inputs that bring up an on-screen keyboard (not checkboxes, ranges, files…). */
const TYPING_INPUTS = new Set(["text", "search", "email", "url", "tel", "password", "number"]);

/** Whether focusing `el` brings up the on-screen keyboard. */
export function opensKeyboard(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) return TYPING_INPUTS.has(el.type) && !el.readOnly;
  return el instanceof HTMLElement && el.isContentEditable;
}

/** The visual viewport this much shorter than its tallest means a keyboard (not a toolbar). */
const KEYBOARD_MIN_PX = 150;

/**
 * Phones (Phase 37): whether the on-screen keyboard is (probably) up, so the
 * tab bar can step aside. Browsers don't say so directly: a text field with
 * focus on a touch screen, or the visual viewport shrinking by a keyboard's
 * height, counts.
 */
export function useSoftKeyboard(): boolean {
  const [typing, setTyping] = useState(false);
  const [shrunk, setShrunk] = useState(false);
  useEffect(() => {
    const touch = window.matchMedia("(pointer: coarse)").matches;
    const sync = () => setTyping(touch && opensKeyboard(document.activeElement));
    // `focusout` fires before the next field takes focus: look once it has.
    const onFocusOut = () => setTimeout(sync, 0);
    document.addEventListener("focusin", sync);
    document.addEventListener("focusout", onFocusOut);
    const vv = window.visualViewport;
    let tallest = vv?.height ?? 0;
    const onResize = () => {
      if (!vv) return;
      tallest = Math.max(tallest, vv.height);
      setShrunk(tallest - vv.height > KEYBOARD_MIN_PX);
    };
    // A rotation changes the height for good: measure afresh.
    const onRotate = () => {
      tallest = 0;
      setTimeout(onResize, 300);
    };
    vv?.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onRotate);
    sync();
    return () => {
      document.removeEventListener("focusin", sync);
      document.removeEventListener("focusout", onFocusOut);
      vv?.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onRotate);
    };
  }, []);
  return typing || shrunk;
}

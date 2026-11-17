import { useCallback, useRef } from "react";

// ---------------------------------------------------------------------------
// Focus on mount without the `autoFocus` prop (Phase 69). React implements
// `autoFocus` itself, by calling `focus()` when the element mounts; a ref
// callback does the same, at the same moment, for the fields that open a form
// or a step (a dialog's first field, a confirm button).
// ---------------------------------------------------------------------------

/** A ref callback that focuses its element when it mounts: `autoFocus`. */
export function focusOnMount(element: HTMLElement | null): void {
  element?.focus();
}

/**
 * `autoFocus={enabled}`: a stable ref callback that focuses its element when
 * it mounts if `enabled` is true at that moment. Like the prop, `enabled`
 * turning true later doesn't move the focus.
 */
export function useFocusOnMount(enabled: boolean): (element: HTMLElement | null) => void {
  const latest = useRef(enabled);
  latest.current = enabled;
  return useCallback((element: HTMLElement | null) => {
    if (latest.current) element?.focus();
  }, []);
}

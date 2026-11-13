import { isIos } from "./install";

// ---------------------------------------------------------------------------
// Which PDF viewer a device gets. Native PDF in an <iframe> is broken on iOS
// WebKit: it shows the first page only, freezes, or renders nothing, worst of
// all in the Home Screen app (standalone). Phones and tablets therefore draw
// the pages themselves on <canvas> with pdf.js (`PdfPages`); computers keep
// the browser's own viewer, which is faster and has search, zoom and print.
// ---------------------------------------------------------------------------

export type PdfRenderer = "canvas" | "native";

/** `canvas` on every iPhone/iPad and every touch-first device; `native` on computers. */
export function pdfRenderer(
  env: {
    ios?: boolean;
    coarsePointer?: boolean;
    android?: boolean;
  } = {
    ios: isIos(),
    coarsePointer:
      typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true,
    android: typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent),
  },
): PdfRenderer {
  return env.ios || env.coarsePointer || env.android ? "canvas" : "native";
}

/** Zoom steps of the canvas viewer: the page's width as a share of the viewer's. */
export const PDF_ZOOM_STEPS = [1, 1.5, 2, 3] as const;

/**
 * Pixels per CSS pixel for the page canvases. Capped at 2: iOS refuses
 * canvases past a total memory budget, and three times the pixels of a
 * Retina phone buys little sharpness for a lot of memory.
 */
export const PDF_MAX_PIXEL_RATIO = 2;

/** The page counter's "3 / 12". */
export const pageLabel = (page: number, pages: number) => `${page} / ${pages}`;

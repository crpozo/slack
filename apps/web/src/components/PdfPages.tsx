import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
// The worker, self-hosted (same origin, no CDN): emitted by Vite with the build.
// The legacy build carries polyfills for the iOS versions still around.
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { PDF_MAX_PIXEL_RATIO, PDF_ZOOM_STEPS, pageLabel } from "../lib/pdf";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** pdf.js's data files, served from our origin (see `pdfjsAssets` in vite.config.ts). */
const ASSETS = `/pdfjs-${pdfjs.version}`;
const OPTIONS = {
  cMapUrl: `${ASSETS}/cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${ASSETS}/standard_fonts/`,
  wasmUrl: `${ASSETS}/wasm/`,
  // Fonts are drawn without `eval`/`new Function`.
  isEvalSupported: false,
  // One plain GET of the presigned URL: no Range requests, which S3's CORS
  // rules here don't allow and iOS handles poorly.
  disableRange: true,
  disableStream: true,
};

export const UNREADABLE = "Couldn't show this PDF here. Open it in a new tab or download it.";

/** Pages this far (in viewer heights) above or below the screen are drawn ahead. */
const AHEAD = "150% 0px";

interface PdfPagesProps {
  url: string;
  name: string;
  /** The document couldn't be read: the viewer offers New tab / Download instead. */
  onError: (message: string) => void;
}

/**
 * Phones and tablets (`pdfRenderer`): every page of the PDF drawn on a
 * canvas with pdf.js, one under the other in a native-scrolling column. Only
 * the pages near the screen hold a canvas (the rest keep their height as an
 * empty box), so a 200-page PDF doesn't exhaust iOS's canvas memory.
 */
export default function PdfPages({ url, name, onError }: Readonly<PdfPagesProps>) {
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [pages, setPages] = useState(0);
  /** Height / width of the first page: the empty boxes' shape until a page is drawn. */
  const [ratio, setRatio] = useState(Math.SQRT2);
  const [current, setCurrent] = useState(1);
  const [zoom, setZoom] = useState<(typeof PDF_ZOOM_STEPS)[number]>(1);
  const file = useMemo(() => ({ url }), [url]);

  // The column's width, kept in step with rotations and resizes.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const pageWidth = Math.max(0, Math.floor((width - 16) * zoom));
  const pixelRatio = Math.min(
    typeof window === "undefined" ? 1 : window.devicePixelRatio || 1,
    PDF_MAX_PIXEL_RATIO,
  );

  const goTo = useCallback((page: number) => {
    scroller.current
      ?.querySelector(`[data-page="${page}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={scroller}
        // Native momentum scrolling on iOS; the column never collapses (explicit height).
        className="h-full min-h-0 flex-1 touch-pan-x touch-pan-y overflow-auto overscroll-contain bg-surface-sidebar [-webkit-overflow-scrolling:touch]"
        data-testid="pdf-scroller"
      >
        <Document
          file={file}
          options={OPTIONS}
          onLoadSuccess={async (doc) => {
            setPages(doc.numPages);
            try {
              const first = await doc.getPage(1);
              const { width: w, height: h } = first.getViewport({ scale: 1 });
              if (w > 0) setRatio(h / w);
            } catch {
              // Keep the A4 shape for the empty boxes.
            }
          }}
          onLoadError={(err) => {
            console.warn("[pdf] couldn't read the document", err);
            onError(UNREADABLE);
          }}
          onSourceError={(err) => {
            console.warn("[pdf] couldn't load the document", err);
            onError(UNREADABLE);
          }}
          loading={<p className="p-6 text-center text-sm text-ink-secondary">Loading PDF…</p>}
          error={<span />}
          className="flex flex-col items-center gap-2 py-2"
        >
          {pageWidth > 0 &&
            Array.from({ length: pages }, (_, i) => (
              <PageSlot
                key={i + 1}
                page={i + 1}
                width={pageWidth}
                height={Math.round(pageWidth * ratio)}
                pixelRatio={pixelRatio}
                root={scroller.current}
                onVisible={setCurrent}
                name={name}
              />
            ))}
        </Document>
      </div>
      {pages > 0 && (
        <footer className="flex items-center justify-center gap-1 border-t border-line px-2 py-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] text-sm">
          <button
            type="button"
            className={NAV}
            onClick={() => goTo(Math.max(1, current - 1))}
            disabled={current <= 1}
            aria-label="Previous page"
          >
            ‹
          </button>
          <span
            className="min-w-16 text-center tabular-nums"
            aria-live="polite"
            data-testid="pdf-page"
          >
            {pageLabel(current, pages)}
          </span>
          <button
            type="button"
            className={NAV}
            onClick={() => goTo(Math.min(pages, current + 1))}
            disabled={current >= pages}
            aria-label="Next page"
          >
            ›
          </button>
          <span className="mx-2 h-5 w-px bg-line" aria-hidden="true" />
          <button
            type="button"
            className={NAV}
            onClick={() =>
              setZoom((z) => PDF_ZOOM_STEPS[Math.max(0, PDF_ZOOM_STEPS.indexOf(z) - 1)]!)
            }
            disabled={zoom === PDF_ZOOM_STEPS[0]}
            aria-label="Zoom out"
          >
            −
          </button>
          <span className="w-12 text-center text-xs tabular-nums">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            className={NAV}
            onClick={() =>
              setZoom(
                (z) =>
                  PDF_ZOOM_STEPS[
                    Math.min(PDF_ZOOM_STEPS.length - 1, PDF_ZOOM_STEPS.indexOf(z) + 1)
                  ]!,
              )
            }
            disabled={zoom === PDF_ZOOM_STEPS.at(-1)}
            aria-label="Zoom in"
          >
            +
          </button>
        </footer>
      )}
    </div>
  );
}

const NAV =
  "flex h-9 min-w-9 items-center justify-center rounded-md px-2 text-lg text-ink-secondary hover:bg-surface-hover hover:text-ink disabled:opacity-40";

/** One page: a canvas while near the screen, an empty box of the same size otherwise. */
function PageSlot({
  page,
  width,
  height,
  pixelRatio,
  root,
  onVisible,
  name,
}: Readonly<{
  page: number;
  width: number;
  height: number;
  pixelRatio: number;
  root: HTMLElement | null;
  onVisible: (page: number) => void;
  name: string;
}>) {
  const box = useRef<HTMLDivElement>(null);
  // Without IntersectionObserver (old browsers, tests) every page is drawn.
  const [near, setNear] = useState(typeof IntersectionObserver === "undefined");
  const [drawnHeight, setDrawnHeight] = useState<number | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const ahead = new IntersectionObserver(([entry]) => setNear(!!entry?.isIntersecting), {
      root,
      rootMargin: AHEAD,
    });
    // The page that holds the middle of the screen is the "current" one.
    const middle = new IntersectionObserver(([entry]) => entry?.isIntersecting && onVisible(page), {
      root,
      rootMargin: "-50% 0px -50% 0px",
    });
    ahead.observe(el);
    middle.observe(el);
    return () => {
      ahead.disconnect();
      middle.disconnect();
    };
  }, [root, page, onVisible]);

  return (
    <div
      ref={box}
      data-page={page}
      className="shrink-0 bg-white shadow-sm"
      style={{ width, minHeight: drawnHeight ?? height }}
      aria-label={`${name}, page ${page}`}
    >
      {near && (
        <Page
          pageNumber={page}
          width={width}
          devicePixelRatio={pixelRatio}
          renderTextLayer={false}
          renderAnnotationLayer={false}
          loading={<span />}
          onRenderSuccess={() => setDrawnHeight(box.current?.offsetHeight ?? null)}
        />
      )}
    </div>
  );
}

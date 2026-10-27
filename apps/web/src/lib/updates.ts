// ---------------------------------------------------------------------------
// "A new version is available" (Phase 39b). Every deploy uploads a fresh
// `index.html` (never cached) whose module script points at the new, hashed
// app bundle. A tab that was open before the deploy keeps running the old
// one, so now and then the app downloads `index.html` again and compares the
// bundle it names with the one it is running: a different name means a new
// version is up, and a banner offers a reload. Nothing is stored, no service
// worker caching is involved.
// ---------------------------------------------------------------------------

/** How often an open tab checks while visible. */
export const UPDATE_CHECK_INTERVAL_MS = 15 * 60_000;
/** Two checks closer than this (a tab shown twice in a row) are one. */
export const UPDATE_CHECK_MIN_GAP_MS = 30_000;

const SCRIPT_TAG = /<script\b[^>]*>/gi;
const MODULE_TYPE = /\btype\s*=\s*["']module["']/i;
const SRC = /\bsrc\s*=\s*["']([^"']+)["']/i;

/** The module script `html` loads (the app bundle), or `null` when there is none. */
export function entryScriptOf(html: string): string | null {
  for (const [tag] of html.matchAll(SCRIPT_TAG)) {
    if (!MODULE_TYPE.test(tag)) continue;
    const src = SRC.exec(tag)?.[1];
    if (src) return src;
  }
  return null;
}

/** The bundle this tab is running: the module script in the live document. */
export function runningEntryScript(doc: Document = document): string | null {
  const script = doc.querySelector<HTMLScriptElement>('script[type="module"][src]');
  return script?.getAttribute("src") ?? null;
}

/**
 * Whether the server's `index.html` names a different bundle than this tab
 * runs. `false` when either can't be read (a flaky network must never nag).
 */
export async function newVersionAvailable(
  fetchImpl: typeof fetch = fetch,
  running: string | null = runningEntryScript(),
): Promise<boolean> {
  if (!running) return false;
  try {
    const response = await fetchImpl("/index.html", {
      cache: "no-store",
      headers: { accept: "text/html" },
    });
    if (!response.ok) return false;
    const latest = entryScriptOf(await response.text());
    return latest !== null && latest !== running;
  } catch {
    return false;
  }
}

/** What the watcher needs from the page: visibility and its two events (fakes in tests). */
export interface UpdateWatchPage {
  readonly visibilityState: "visible" | "hidden";
  addEventListener(type: "visibilitychange" | "online", listener: () => void): void;
  removeEventListener(type: "visibilitychange" | "online", listener: () => void): void;
}

/** The browser's page: `visibilitychange` lives on `document`, `online` on `window`. */
function browserPage(): UpdateWatchPage {
  return {
    get visibilityState() {
      return document.visibilityState;
    },
    addEventListener: (type, listener) =>
      (type === "online" ? window : document).addEventListener(type, listener),
    removeEventListener: (type, listener) =>
      (type === "online" ? window : document).removeEventListener(type, listener),
  };
}

/**
 * Checks when the tab is shown, when the browser comes back online and every
 * `UPDATE_CHECK_INTERVAL_MS` while visible; calls `onUpdate` once, the first
 * time a new version is found, then stops. Returns the function that stops it.
 */
export function watchForUpdates(
  onUpdate: () => void,
  options: {
    check?: () => Promise<boolean>;
    intervalMs?: number;
    minGapMs?: number;
    now?: () => number;
    page?: UpdateWatchPage;
  } = {},
): () => void {
  const check = options.check ?? (() => newVersionAvailable());
  const intervalMs = options.intervalMs ?? UPDATE_CHECK_INTERVAL_MS;
  const minGapMs = options.minGapMs ?? UPDATE_CHECK_MIN_GAP_MS;
  const now = options.now ?? Date.now;
  const page = options.page ?? browserPage();
  let lastCheck = now();
  let stopped = false;
  let checking = false;

  const run = async () => {
    if (stopped || checking || page.visibilityState === "hidden") return;
    if (now() - lastCheck < minGapMs) return;
    lastCheck = now();
    checking = true;
    try {
      if (await check()) {
        stop();
        onUpdate();
      }
    } finally {
      checking = false;
    }
  };
  const onVisible = () => {
    if (page.visibilityState === "visible") void run();
  };
  const onOnline = () => void run();
  const timer = setInterval(() => void run(), intervalMs);
  page.addEventListener("visibilitychange", onVisible);
  page.addEventListener("online", onOnline);

  function stop() {
    stopped = true;
    clearInterval(timer);
    page.removeEventListener("visibilitychange", onVisible);
    page.removeEventListener("online", onOnline);
  }
  return stop;
}

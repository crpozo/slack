import { NEWS_INSIGHTS_LOCAL_TIME } from "@mindfultech/shared";
import { useEffect, useMemo, useState } from "react";
import { useNow } from "../lib/hooks";
import { analysisProgress, dashboardDateLabel, dashboardStories } from "../lib/newsDashboard";
import { tasksApiConfigured } from "../lib/tasksApi";
import { useNews } from "../store/news";
import { INSIGHTS_EXPECTED_MS, useNewsInsights } from "../store/newsInsights";
import { MenuIcon, RefreshIcon } from "./icons";
import { NewsChat, NewsChatLauncher } from "./NewsChat";
import { SparklesIcon } from "./icons";
import { NewsDashboard } from "./NewsDashboard";
import { UnreadAlertsDot } from "./NotificationBell";

/**
 * The AI News app view (`/app/news`; the dashboard since Phase 41): the live
 * stories from every source (`GET /news`, cached 30 minutes) and the
 * morning's analysis (`GET /news/insights`) as one dashboard. "Refresh news"
 * reads the feeds again and starts a new analysis right away
 * (`POST /news/refresh`), shown when it's written, about half a minute later.
 * Until there is an analysis, "Lo esencial" shows the newest stories as they
 * are and the callout says when the first one comes.
 */
export function NewsView({ onOpenSidebar }: Readonly<{ onOpenSidebar?: () => void }>) {
  const { status, data, error, load } = useNews();
  const insightsState = useNewsInsights();
  const loadInsights = insightsState.load;
  const now = useNow();
  const configured = tasksApiConfigured();
  // Phase 50b: the chat beside the news (wide screens) opens on demand; remembered here.
  const [chatOpen, setChatOpen] = useState(readChatOpen);
  const toggleChat = (open: boolean) => {
    setChatOpen(open);
    try {
      localStorage.setItem(CHAT_OPEN_KEY, open ? "1" : "0");
    } catch {
      // Not remembered: it still opens and closes now.
    }
  };

  useEffect(() => {
    document.title = "AI News · MindfulTech";
    if (configured) {
      void load();
      void loadInsights();
      // An analysis asked for before a reload is still being written: wait for it again.
      void useNewsInsights.getState().resume();
    }
  }, [configured, load, loadInsights]);

  const articles = useMemo(() => data?.articles ?? [], [data]);
  const { insights } = insightsState;
  const { top, more } = useMemo(() => dashboardStories(insights, articles), [insights, articles]);
  const loading = status === "loading" || status === "idle";

  const menu = onOpenSidebar && (
    <button
      type="button"
      onClick={onOpenSidebar}
      className="relative -ml-1 rounded-md p-2 text-ink-secondary hover:bg-surface-hover hover:text-ink md:hidden"
      aria-label="Open menu"
    >
      <MenuIcon />
      <UnreadAlertsDot />
    </button>
  );

  return (
    <div
      className="news-paper relative flex h-full min-h-0 flex-1 flex-col bg-surface"
      data-news-view
    >
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {/* Phase 50: the news and, beside them on wide screens, "Pregunta a la IA". */}
        <div
          className={`mx-auto w-full max-w-[1680px] px-4 pb-24 pt-6 sm:px-8 sm:pt-10 xl:pb-16 ${
            chatOpen ? "xl:grid xl:grid-cols-[minmax(0,1fr)_400px] xl:gap-8" : ""
          }`}
        >
          <div className="min-w-0">
            {!configured ? (
              <Notice>AI News isn&apos;t set up on this deployment.</Notice>
            ) : status === "error" && !data ? (
              <ErrorState message={error} onRetry={() => void load(true)} leading={menu} />
            ) : loading && !data ? (
              <Skeletons />
            ) : articles.length === 0 && !insights ? (
              <Notice>No stories right now. Check back in a little while.</Notice>
            ) : (
              <NewsDashboard
                leading={menu}
                dateLabel={dashboardDateLabel(insights?.day ?? null, now)}
                storyCount={insights?.storyCount ?? articles.length}
                stories={top}
                deepDive={insights?.deepDive}
                trends={insights?.trends ?? []}
                takeaways={insights?.takeaways ?? []}
                watchlist={insights?.watchlist ?? []}
                moreStories={more}
                now={now}
                refreshing={status === "loading" || insightsState.generating}
                headerActions={
                  <button
                    type="button"
                    onClick={() => toggleChat(!chatOpen)}
                    aria-pressed={chatOpen}
                    className={`hidden h-10 items-center gap-2 whitespace-nowrap rounded-full border px-5 text-[13px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary xl:inline-flex ${
                      chatOpen
                        ? "border-primary bg-primary/15 text-ink"
                        : "border-ink/70 text-ink hover:bg-ink/[0.06]"
                    }`}
                    title={chatOpen ? "Cerrar el chat" : "Abrir el chat con la IA"}
                    data-news-chat-toggle
                  >
                    <SparklesIcon aria-hidden="true" />
                    Pregunta a la IA
                  </button>
                }
                onRefresh={() => {
                  void load(true);
                  void insightsState.generate();
                }}
                banner={
                  <>
                    {(data?.stale || error) && (
                      <p
                        role="status"
                        className="border-l-2 border-warning bg-warning/10 px-4 py-2.5 text-sm text-ink"
                      >
                        {data?.stale
                          ? "The news sources couldn't be reached just now: these are the latest stories we had."
                          : `Couldn't refresh: ${error}`}
                      </p>
                    )}
                    <RefreshStatus />
                  </>
                }
                insightsNotice={<InsightsNotice />}
              />
            )}
          </div>
          {chatOpen && configured && (articles.length > 0 || insights) && (
            <aside className="hidden xl:block" aria-label="Pregunta a la IA">
              {/* The chat stays dark on the paper, like the MindfulTech band. */}
              <div className="news-dark sticky top-6 h-[calc(100dvh-6rem)] min-h-[420px] rounded-[18px] bg-surface">
                <NewsChat
                  storyCount={insights?.storyCount ?? articles.length}
                  onClose={() => toggleChat(false)}
                />
              </div>
            </aside>
          )}
        </div>
      </div>
      {configured && (articles.length > 0 || insights) && (
        <div className="news-dark">
          <NewsChatLauncher storyCount={insights?.storyCount ?? articles.length} />
        </div>
      )}
    </div>
  );
}

/** Where the chat's open/closed choice is kept for this browser (Phase 50b). */
const CHAT_OPEN_KEY = "news.chat.open";

/** Closed unless it was left open: some visits are only for reading the news. */
function readChatOpen(): boolean {
  try {
    return localStorage.getItem(CHAT_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

/** What "Refresh news" is doing with the analysis: writing it (with progress), not needed yet, or failed. */
function RefreshStatus() {
  const { generating, generatingSince, generateNotice, generateError } = useNewsInsights();
  if (generating) return <AnalysisProgress since={generatingSince ?? Date.now()} />;
  const text = generateError ?? generateNotice;
  if (!text) return null;
  return (
    <p
      role={generateError ? "alert" : "status"}
      className={`flex items-center gap-2 border-l-2 px-4 py-2.5 text-sm ${
        generateError
          ? "border-warning bg-warning/10 text-ink"
          : "border-primary bg-primary/10 text-ink/85"
      }`}
      data-news-refresh-status
    >
      {text}
    </p>
  );
}

/** Which step the analysis is probably on, by how far along it is. */
const STEPS: Array<[number, string]> = [
  [0, "Leyendo las historias de hoy en cada medio…"],
  [30, "Comparando las historias y buscando las tendencias…"],
  [60, "Escribiendo el análisis con IA…"],
  [85, "Casi listo: revisando el análisis…"],
];

/**
 * The analysis being written (Phase 49): a bar that fills over the usual
 * time, the step it's probably on and how long it has run. It keeps going on
 * the server if you leave: coming back (even after a reload) picks it up.
 */
function AnalysisProgress({ since }: Readonly<{ since: number }>) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // Once a second, with a 1 s linear transition: smooth, and no repaint storm.
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, now - since);
  const pct = analysisProgress(elapsed, INSIGHTS_EXPECTED_MS);
  const step = [...STEPS].reverse().find(([from]) => pct >= from)?.[1] ?? STEPS[0]![1];
  return (
    <div
      role="status"
      className="flex flex-col gap-2.5 border-l-2 border-primary bg-primary/10 px-4 py-3 text-sm text-ink/85"
      data-news-refresh-status
      data-news-progress
    >
      <div className="flex items-center gap-2">
        <RefreshIcon className="shrink-0 animate-spin text-primary" aria-hidden="true" />
        <span className="min-w-0 flex-1">{step}</span>
        <span className="shrink-0 font-mono text-xs tabular-nums text-ink-secondary">
          {Math.floor(elapsed / 1000)} s
        </span>
      </div>
      <div
        className="h-1 w-full overflow-hidden bg-ink/10"
        role="progressbar"
        aria-label="Progreso del análisis"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
      >
        <div
          className="h-full bg-primary transition-[width] duration-1000 ease-linear"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-xs text-ink-secondary">
        Sigue analizando aunque cambies de página: el análisis aparece aquí al terminar.
      </p>
    </div>
  );
}

/** The callout before the first analysis, while one is written, or when it failed. */
function InsightsNotice() {
  const { status, insights, error, generating, load } = useNewsInsights();
  const text = generating
    ? "Leyendo las historias de hoy y escribiendo el análisis: cerca de medio minuto."
    : status === "error" && !insights
      ? `No se pudo cargar el análisis${error ? `: ${error}` : "."}`
      : status === "loading" || status === "idle"
        ? "Cargando el análisis…"
        : `Aún no hay análisis. Llega cada mañana a las ${NEWS_INSIGHTS_LOCAL_TIME}, o pulsa Refresh news para pedirlo ahora.`;
  return (
    <div className="flex flex-col gap-2 text-sm text-ink-secondary" data-news-insights-notice>
      <p role="status">{text}</p>
      {status === "error" && !insights && (
        <button
          type="button"
          onClick={() => void load(true)}
          className="self-start underline hover:text-ink"
        >
          Reintentar
        </button>
      )}
    </div>
  );
}

function Skeletons() {
  const block = "animate-pulse bg-ink/[0.07]";
  return (
    <div
      aria-busy="true"
      aria-label="Loading the news"
      className="mx-auto flex w-full max-w-[1120px] flex-col gap-7"
    >
      <div className="space-y-3">
        <div className={`${block} h-9 w-48`} />
        <div className={`${block} h-4 w-72`} />
      </div>
      <div className="grid gap-3.5 sm:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex gap-4 border-t border-line pt-4">
            <div className={`${block} h-[84px] w-[84px] shrink-0`} />
            <div className="flex-1 space-y-2.5">
              <div className={`${block} h-4 w-11/12`} />
              <div className={`${block} h-3.5 w-4/5`} />
              <div className={`${block} h-3.5 w-24`} />
            </div>
          </div>
        ))}
      </div>
      <div className={`${block} h-40`} />
      <div className={`${block} h-36`} />
    </div>
  );
}

function ErrorState({
  message,
  onRetry,
  leading,
}: Readonly<{ message: string | null; onRetry: () => void; leading?: React.ReactNode }>) {
  return (
    <>
      {leading}
      <div className="mx-auto mt-10 max-w-md border-t-[3px] border-ink p-6 text-center">
        <p className="text-3xl" aria-hidden="true">
          📡
        </p>
        <h2 className="mt-2 font-semibold text-ink">Couldn&apos;t load the news</h2>
        <p role="alert" className="mt-1 text-sm text-ink-secondary">
          {message ?? "Something went wrong."}
        </p>
        <button type="button" onClick={onRetry} className="btn-primary mt-4">
          Try again
        </button>
      </div>
    </>
  );
}

function Notice({ children }: Readonly<{ children: React.ReactNode }>) {
  return <p className="mt-10 text-center text-sm text-ink-secondary">{children}</p>;
}

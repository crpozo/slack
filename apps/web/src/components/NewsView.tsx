import { NEWS_INSIGHTS_LOCAL_TIME } from "@mindfultech/shared";
import { useEffect, useMemo } from "react";
import { useNow } from "../lib/hooks";
import { dashboardDateLabel, dashboardStories } from "../lib/newsDashboard";
import { tasksApiConfigured } from "../lib/tasksApi";
import { useNews } from "../store/news";
import { useNewsInsights } from "../store/newsInsights";
import { MenuIcon, RefreshIcon } from "./icons";
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

  useEffect(() => {
    document.title = "AI News · MindfulTech";
    if (configured) {
      void load();
      void loadInsights();
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
      className="relative flex h-full min-h-0 flex-1 flex-col bg-surface bg-[radial-gradient(900px_420px_at_15%_-10%,rgb(64_179_117/0.16),transparent_60%),radial-gradient(700px_400px_at_100%_10%,rgb(64_179_117/0.07),transparent_60%)]"
      data-news-view
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-4 pb-16 pt-6 sm:px-6 sm:pt-10">
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
              onRefresh={() => {
                void load(true);
                void insightsState.generate();
              }}
              banner={
                <>
                  {(data?.stale || error) && (
                    <p
                      role="status"
                      className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-2.5 text-sm text-ink"
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
      </div>
    </div>
  );
}

/** What "Refresh news" is doing with the analysis: writing it, not needed yet, or failed. */
function RefreshStatus() {
  const { generating, generateNotice, generateError } = useNewsInsights();
  const text = generating
    ? "Leyendo las historias de hoy y escribiendo el análisis con IA: cerca de medio minuto…"
    : (generateError ?? generateNotice);
  if (!text) return null;
  return (
    <p
      role={generateError && !generating ? "alert" : "status"}
      className={`flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm ${
        generateError && !generating
          ? "border-warning/40 bg-warning/10 text-ink"
          : "border-primary/30 bg-primary/[0.08] text-ink/85"
      }`}
      data-news-refresh-status
    >
      {generating && (
        <RefreshIcon className="shrink-0 animate-spin text-primary" aria-hidden="true" />
      )}
      {text}
    </p>
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
  const block = "animate-pulse rounded-lg bg-white/[0.06]";
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
          <div
            key={i}
            className="flex gap-4 rounded-2xl border border-white/[0.08] bg-white/[0.035] p-4"
          >
            <div className={`${block} h-[84px] w-[84px] shrink-0 rounded-xl`} />
            <div className="flex-1 space-y-2.5">
              <div className={`${block} h-4 w-11/12`} />
              <div className={`${block} h-3.5 w-4/5`} />
              <div className={`${block} h-3.5 w-24`} />
            </div>
          </div>
        ))}
      </div>
      <div className={`${block} h-40 rounded-[18px]`} />
      <div className={`${block} h-36 rounded-[20px]`} />
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
      <div className="mx-auto mt-10 max-w-md rounded-2xl border border-white/10 bg-white/[0.04] p-6 text-center shadow-sm backdrop-blur-lg">
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

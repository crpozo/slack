import {
  NEWS_INSIGHTS_LOCAL_TIME,
  NEWS_INSIGHTS_TIME_ZONE,
  type NewsArticle,
  type NewsInsights,
} from "@mindfultech/shared";
import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { isDesktopApp } from "../lib/desktop";
import { openExternal } from "../lib/external";
import { useNow } from "../lib/hooks";
import { renderNotesMarkdown } from "../lib/markdown";
import { fullDate, relativeTime } from "../lib/news";
import { tasksApiConfigured } from "../lib/tasksApi";
import { useChat } from "../store";
import { useNews } from "../store/news";
import { useNewsInsights } from "../store/newsInsights";
import { ExternalLinkIcon, MenuIcon, RefreshIcon, SparklesIcon } from "./icons";
import { UnreadAlertsDot } from "./NotificationBell";

/**
 * The AI News app view (`/app/news`, Phase 35b): the latest TechCrunch AI
 * stories as cards, newest first, the first one featured. Read live through
 * `GET /news` (a stateless proxy; nothing is stored), cached 30 minutes by
 * the server and the browser. Every card opens the article in a new tab (the
 * system browser in the desktop app).
 */
export function NewsView({ onOpenSidebar }: Readonly<{ onOpenSidebar?: () => void }>) {
  const { status, data, error, load } = useNews();
  const loadInsights = useNewsInsights((s) => s.load);
  const now = useNow();
  const configured = tasksApiConfigured();

  useEffect(() => {
    document.title = "AI News · MindfulTech";
    if (configured) {
      void load();
      void loadInsights();
    }
  }, [configured, load, loadInsights]);

  const articles = data?.articles ?? [];
  const [featured, ...rest] = articles;
  const loading = status === "loading" || status === "idle";

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col bg-surface" data-news-view>
      {/* Desktop (Phase 37b): glass, floating over the content that scrolls under it. */}
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3 sm:px-4 md:glass md:absolute md:inset-x-0 md:top-0 md:z-20 md:border-white/10">
        {onOpenSidebar && (
          <button
            type="button"
            onClick={onOpenSidebar}
            className="relative rounded-md p-2 text-ink-secondary hover:bg-surface-hover hover:text-ink md:hidden"
            aria-label="Open menu"
          >
            <MenuIcon />
            <UnreadAlertsDot />
          </button>
        )}
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-lg"
          aria-hidden="true"
        >
          📰
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-bold leading-tight text-ink">AI News</h1>
          <p className="truncate text-xs text-ink-secondary">
            Latest from {data?.source ?? "TechCrunch"}
            {data &&
              ` · Updated ${relativeTime(new Date(data.fetchedAt).toISOString(), now).toLowerCase()}`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={status === "loading" || !configured}
          className="rounded-lg p-2 text-ink-secondary hover:bg-surface-hover hover:text-ink disabled:opacity-50"
          aria-label="Refresh the news"
          title="Refresh"
        >
          <RefreshIcon className={status === "loading" && data ? "animate-spin" : ""} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto md:pt-14">
        <div className="mx-auto w-full max-w-6xl px-3 py-5 sm:px-6 sm:py-6">
          {!configured ? (
            <Notice>AI News isn&apos;t set up on this deployment.</Notice>
          ) : status === "error" && !data ? (
            <ErrorState message={error} onRetry={() => void load(true)} />
          ) : loading && !data ? (
            <Skeletons />
          ) : articles.length === 0 ? (
            <Notice>No stories right now. Check back in a little while.</Notice>
          ) : (
            <>
              {(data?.stale || error) && (
                <p
                  role="status"
                  className="mb-4 rounded-xl border border-warning/40 bg-warning/10 px-4 py-2.5 text-sm text-ink"
                >
                  {data?.stale
                    ? "TechCrunch couldn't be reached just now: these are the latest stories we had."
                    : `Couldn't refresh: ${error}`}
                </p>
              )}
              <InsightsSection now={now} />
              {featured && <FeaturedCard article={featured} now={now} />}
              {rest.length > 0 && (
                <ul
                  className="mt-5 grid gap-5 sm:grid-cols-2 xl:grid-cols-3"
                  aria-label="More stories"
                >
                  {rest.map((article) => (
                    <li key={article.link} className="flex">
                      <NewsCard article={article} now={now} />
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-8 text-center text-xs text-ink-secondary">
                Stories and images belong to {data?.source ?? "TechCrunch"}. Each opens on their
                site.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** `2026-10-27` as "Tuesday, 27 October" in the team's time zone. */
const dayFmt = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: NEWS_INSIGHTS_TIME_ZONE,
});
export function insightsDayLabel(insights: Pick<NewsInsights, "day">): string {
  const at = Date.parse(`${insights.day}T12:00:00Z`); // noon UTC: the same calendar day in Ecuador
  return Number.isFinite(at) ? dayFmt.format(at) : insights.day;
}

/**
 * AI Insights (Phase 39): the morning's analysis of the stories, written by
 * Claude from the same feed, above the news. Before the first one (or when a
 * day's run failed) it says when the next comes; admins can ask for one now.
 * The model's markdown goes through `renderNotesMarkdown`, which escapes
 * everything before adding its own tags.
 */
function InsightsSection({ now }: Readonly<{ now: number }>) {
  const { status, insights, error, generating, generateError, generate, load } = useNewsInsights();
  const admin = useChat((s) => s.me?.role === "admin");
  const html = useMemo(() => (insights ? renderNotesMarkdown(insights.analysis) : ""), [insights]);
  if (status === "idle" || (status === "loading" && !insights)) {
    return (
      <section
        aria-busy="true"
        aria-label="Loading the AI insights"
        className="mb-5 space-y-3 rounded-2xl border border-line bg-surface-raised p-5"
      >
        <div className="h-4 w-40 animate-pulse rounded bg-surface-hover" />
        <div className="h-4 w-11/12 animate-pulse rounded bg-surface-hover" />
        <div className="h-4 w-3/4 animate-pulse rounded bg-surface-hover" />
      </section>
    );
  }
  const generatedAgo = insights
    ? relativeTime(new Date(insights.generatedAt).toISOString(), now).toLowerCase()
    : "";
  return (
    <section
      aria-labelledby="ai-insights-title"
      data-news-insights={insights ? insights.day : "none"}
      className="mb-5 overflow-hidden rounded-2xl border border-primary/40 bg-gradient-to-br from-primary/10 via-surface-raised to-surface-raised shadow-sm"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line/70 px-5 py-3">
        <SparklesIcon className="text-primary" aria-hidden="true" />
        <h2 id="ai-insights-title" className="text-base font-bold text-ink">
          AI Insights
        </h2>
        <p className="min-w-0 flex-1 truncate text-xs text-ink-secondary">
          {insights
            ? `${insightsDayLabel(insights)} · from ${insights.articles.length} stories · written ${generatedAgo}`
            : `Every morning at ${NEWS_INSIGHTS_LOCAL_TIME}, an analysis of the day's stories`}
        </p>
        {admin && (
          <button
            type="button"
            onClick={() => void generate()}
            disabled={generating}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-xs font-semibold text-ink hover:bg-surface-hover disabled:opacity-60"
            title="Ask for a fresh analysis of the current stories"
          >
            <RefreshIcon className={generating ? "animate-spin" : ""} aria-hidden="true" />
            {generating ? "Writing…" : insights ? "Generate again" : "Generate now"}
          </button>
        )}
      </div>
      <div className="px-5 py-4">
        {generating && (
          <p role="status" className="mb-3 text-sm text-ink-secondary">
            Reading today&apos;s stories and writing the analysis: about half a minute.
          </p>
        )}
        {generateError && (
          <p role="alert" className="mb-3 text-sm text-warning">
            {generateError}
          </p>
        )}
        {insights ? (
          <>
            <div
              className="md md-notes break-words text-sm leading-relaxed text-ink sm:text-[15px]"
              // Safe: renderNotesMarkdown escapes all text before adding its own tags.
              dangerouslySetInnerHTML={{ __html: html }}
            />
            <p className="mt-3 border-t border-line/70 pt-2 text-[11px] text-ink-secondary">
              Written by AI from the stories below: check the facts in the articles themselves.
            </p>
          </>
        ) : status === "error" ? (
          <p className="text-sm text-ink-secondary">
            Couldn&apos;t load the insights{error ? `: ${error}` : "."}{" "}
            <button type="button" onClick={() => void load(true)} className="underline">
              Try again
            </button>
          </p>
        ) : (
          <p className="text-sm text-ink-secondary">
            No analysis yet. The first one arrives tomorrow at {NEWS_INSIGHTS_LOCAL_TIME}
            {admin ? ", or ask for one now." : "."}
          </p>
        )}
      </div>
    </section>
  );
}

/** Desktop app: the system browser (an `<a target="_blank">` would stay inside the app). */
function openInBrowser(e: MouseEvent<HTMLAnchorElement>, link: string) {
  if (!isDesktopApp()) return; // the link opens in a new tab by itself
  e.preventDefault();
  void openExternal(link);
}

/** The article's image, or a calm placeholder when it has none (or it fails to load). */
function Cover({ src, className }: Readonly<{ src: string | null; className: string }>) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div
        className={`flex items-center justify-center bg-gradient-to-br from-primary/30 via-sky/20 to-surface-sidebar ${className}`}
        aria-hidden="true"
      >
        <span className="text-4xl opacity-70">📰</span>
      </div>
    );
  }
  return (
    <div className={`overflow-hidden bg-surface-sidebar ${className}`}>
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className="h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.04]"
      />
    </div>
  );
}

function Meta({ article, now }: Readonly<{ article: NewsArticle; now: number }>) {
  const when = relativeTime(article.pubDate, now);
  return (
    <p className="flex items-center gap-2 text-xs text-ink-secondary">
      <span className="rounded-full bg-primary/15 px-2 py-0.5 font-semibold text-ink">
        TechCrunch
      </span>
      {when && (
        <time dateTime={article.pubDate ?? undefined} title={fullDate(article.pubDate)}>
          {when}
        </time>
      )}
    </p>
  );
}

function ReadMore() {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink underline decoration-primary decoration-2 underline-offset-4 transition-colors group-hover:decoration-ink">
      Read article <ExternalLinkIcon aria-hidden="true" />
    </span>
  );
}

const CARD =
  "group flex w-full flex-col overflow-hidden rounded-2xl border border-line bg-surface-raised shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

/** The newest story, large: image beside the text from tablet width up. */
function FeaturedCard({ article, now }: Readonly<{ article: NewsArticle; now: number }>) {
  return (
    <a
      href={article.link}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => openInBrowser(e, article.link)}
      className={`${CARD} md:flex-row`}
      data-news-card="featured"
    >
      <Cover
        src={article.imageUrl}
        className="aspect-[16/9] md:aspect-auto md:min-h-[300px] md:w-[56%]"
      />
      <div className="flex flex-1 flex-col gap-3 p-5 sm:p-6">
        <Meta article={article} now={now} />
        <h2 className="text-xl font-bold leading-snug text-ink sm:text-2xl">{article.title}</h2>
        {article.snippet && (
          <p className="line-clamp-4 text-sm leading-relaxed text-ink-secondary sm:text-base">
            {article.snippet}
          </p>
        )}
        <div className="mt-auto pt-2">
          <ReadMore />
        </div>
      </div>
    </a>
  );
}

function NewsCard({ article, now }: Readonly<{ article: NewsArticle; now: number }>) {
  return (
    <a
      href={article.link}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => openInBrowser(e, article.link)}
      className={CARD}
      data-news-card
    >
      <Cover src={article.imageUrl} className="aspect-[16/9] w-full" />
      <div className="flex flex-1 flex-col gap-2.5 p-4">
        <Meta article={article} now={now} />
        <h3 className="line-clamp-3 font-semibold leading-snug text-ink">{article.title}</h3>
        {article.snippet && (
          <p className="line-clamp-3 text-sm leading-relaxed text-ink-secondary">
            {article.snippet}
          </p>
        )}
        <div className="mt-auto pt-1">
          <ReadMore />
        </div>
      </div>
    </a>
  );
}

function Skeletons() {
  const block = "animate-pulse rounded bg-surface-hover";
  return (
    <div aria-busy="true" aria-label="Loading the news">
      <div className="flex flex-col overflow-hidden rounded-2xl border border-line md:flex-row">
        <div
          className={`${block} aspect-[16/9] rounded-none md:aspect-auto md:min-h-[300px] md:w-[56%]`}
        />
        <div className="flex-1 space-y-3 p-6">
          <div className={`${block} h-4 w-32`} />
          <div className={`${block} h-7 w-11/12`} />
          <div className={`${block} h-7 w-3/4`} />
          <div className={`${block} h-4 w-full`} />
          <div className={`${block} h-4 w-5/6`} />
        </div>
      </div>
      <div className="mt-5 grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="overflow-hidden rounded-2xl border border-line">
            <div className={`${block} aspect-[16/9] rounded-none`} />
            <div className="space-y-2.5 p-4">
              <div className={`${block} h-3.5 w-24`} />
              <div className={`${block} h-5 w-11/12`} />
              <div className={`${block} h-4 w-4/5`} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ErrorState({
  message,
  onRetry,
}: Readonly<{ message: string | null; onRetry: () => void }>) {
  return (
    <div className="mx-auto mt-10 max-w-md rounded-2xl border border-line bg-surface-raised p-6 text-center shadow-sm">
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
  );
}

function Notice({ children }: Readonly<{ children: React.ReactNode }>) {
  return <p className="mt-10 text-center text-sm text-ink-secondary">{children}</p>;
}

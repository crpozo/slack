import type { NewsStory, NewsTakeaway, NewsTrend } from "@mindfultech/shared";
import { useState, type MouseEvent, type ReactNode } from "react";
import { isDesktopApp } from "../lib/desktop";
import { openExternal } from "../lib/external";
import { fullDate } from "../lib/news";
import { highlightParts, timeAgo } from "../lib/newsDashboard";
import { RefreshIcon } from "./icons";

export interface NewsDashboardProps {
  /** "Mié 28 oct 2026" */
  dateLabel: string;
  /** How many stories the summary was made from. */
  storyCount: number;
  /** "Lo esencial": the day's top stories. */
  stories: NewsStory[];
  /** "Tendencias"; the section is left out while there are none. */
  trends: NewsTrend[];
  /** "Qué significa para MindfulTech". */
  takeaways: NewsTakeaway[];
  /** Every other live story, below the callout. */
  moreStories?: NewsStory[];
  now: number;
  refreshing: boolean;
  onRefresh: () => void;
  /** In the callout instead of the takeaways when there's no analysis (yet). */
  insightsNotice?: ReactNode;
  /** Beside the callout's title (an admin's "Generar análisis"). */
  insightsAction?: ReactNode;
  /** Above everything (the feeds couldn't be read, a refresh failed). */
  banner?: ReactNode;
  /** Before the title (the phone's menu button). */
  leading?: ReactNode;
  /** The callout: a green glow on glass, or a green tint. */
  calloutStyle?: "glow" | "tinted";
}

/**
 * The AI News dashboard (Phase 41, from the "AI News Dashboard" design): the
 * date and story count, "Lo esencial" (the day's top stories as glass
 * cards), "Tendencias" and the "Qué significa para MindfulTech" callout,
 * then the rest of the stories. Presentational: `NewsView` feeds it.
 */
export function NewsDashboard({
  dateLabel,
  storyCount,
  stories,
  trends,
  takeaways,
  moreStories = [],
  now,
  refreshing,
  onRefresh,
  insightsNotice,
  insightsAction,
  banner,
  leading,
  calloutStyle = "glow",
}: Readonly<NewsDashboardProps>) {
  return (
    <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-7" data-news-dashboard>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center gap-3">
            {leading}
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full bg-primary shadow-[0_0_0_4px_rgb(64_179_117/0.18),0_0_18px_rgb(64_179_117/0.6)]"
              aria-hidden="true"
            />
            <h1 className="text-[32px] font-extrabold leading-tight tracking-tight text-ink">
              AI News
            </h1>
          </div>
          <p className="flex flex-wrap items-center gap-2.5 text-sm text-ink-secondary">
            <span className="font-mono text-xs tracking-wide text-ink/70" data-news-date>
              {dateLabel}
            </span>
            <span
              className="hidden h-[3px] w-[3px] rounded-full bg-white/20 sm:block"
              aria-hidden="true"
            />
            <span>
              Resumido por IA a partir de{" "}
              <strong className="font-semibold text-ink/85" data-news-story-count>
                {storyCount} {storyCount === 1 ? "historia" : "historias"}
              </strong>
            </span>
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-[10px] border border-primary/50 bg-primary/[0.06] px-4 text-[13px] font-semibold text-[#6fcf97] backdrop-blur-md transition hover:border-primary hover:bg-primary/[0.14] hover:text-[#8fe0b0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-70"
          aria-label="Refresh news"
          title="Read the latest stories from every source now"
          data-refresh-news
        >
          <RefreshIcon className={refreshing ? "animate-spin" : ""} aria-hidden="true" />
          <span>{refreshing ? "Actualizando…" : "Refresh news"}</span>
        </button>
      </header>

      {banner}

      <section aria-labelledby="news-top-title" className="flex flex-col gap-3.5">
        <div className="flex items-baseline gap-2.5">
          <h2 id="news-top-title" className={SECTION_TITLE}>
            Lo esencial
          </h2>
          <span className="text-xs text-ink-secondary/80">Top {stories.length} del día</span>
        </div>
        {/* Four stories: two by two, never three and one left over. */}
        <ul className="grid gap-3.5 md:grid-cols-2">
          {stories.map((story) => (
            <li key={story.link} className="flex">
              <StoryCard story={story} now={now} />
            </li>
          ))}
        </ul>
      </section>

      {trends.length > 0 && (
        <section
          aria-labelledby="news-trends-title"
          className="flex flex-col gap-[18px] rounded-[18px] border border-white/10 bg-gradient-to-b from-white/[0.07] to-white/[0.04] p-6 shadow-[0_14px_40px_rgb(0_0_0/0.3),inset_0_1px_0_rgb(255_255_255/0.06)] backdrop-blur-xl"
          data-news-trends
        >
          <div className="flex items-center gap-2.5">
            <TrendIcon />
            <h2 id="news-trends-title" className={SECTION_TITLE}>
              Tendencias
            </h2>
          </div>
          <ol className="grid gap-5 md:grid-cols-[repeat(auto-fit,minmax(280px,1fr))]">
            {trends.map((trend, i) => (
              <li key={`${i}-${trend.topic}`} className="flex flex-col gap-2">
                <div className="font-mono text-[11px] text-ink-secondary/80">
                  {String(i + 1).padStart(2, "0")} · {trend.topic}
                </div>
                <p className="text-sm leading-[1.65] text-ink/75 [text-wrap:pretty]">
                  {highlightParts(trend.text).map((part, j) =>
                    part.mark ? (
                      <em
                        key={j}
                        className="rounded-[5px] bg-primary/[0.12] px-[5px] py-px font-bold not-italic text-[#6fcf97]"
                      >
                        {part.text}
                      </em>
                    ) : (
                      <span key={j}>{part.text}</span>
                    ),
                  )}
                </p>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section
        aria-labelledby="news-impact-title"
        className={`relative flex flex-col gap-5 rounded-[20px] border p-6 backdrop-blur-xl sm:p-7 ${CALLOUT[calloutStyle]}`}
        data-news-impact
      >
        <div className="flex flex-wrap items-center gap-3.5">
          <span
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-primary/40 bg-primary/15 text-primary shadow-[0_0_24px_rgb(64_179_117/0.25)]"
            aria-hidden="true"
          >
            <BulbIcon />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 id="news-impact-title" className="text-xl font-extrabold tracking-tight text-ink">
              Qué significa para MindfulTech
            </h2>
            <span className="text-[13px] text-ink-secondary">
              Impacto de negocio · acciones sugeridas para esta semana
            </span>
          </div>
          {insightsAction}
        </div>
        {takeaways.length > 0 ? (
          <ul className="grid gap-x-6 gap-y-3 md:grid-cols-2">
            {takeaways.map((t, i) => (
              <li key={`${i}-${t.lead}`} className="flex items-start gap-3">
                <CheckCircleIcon />
                <p className="text-sm leading-[1.55] text-ink/85 [text-wrap:pretty]">
                  <strong className="font-bold text-ink">{t.lead}</strong> {t.body}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          insightsNotice
        )}
      </section>

      {moreStories.length > 0 && (
        <section aria-labelledby="news-more-title" className="flex flex-col gap-3.5">
          <div className="flex items-baseline gap-2.5">
            <h2 id="news-more-title" className={SECTION_TITLE}>
              Más historias
            </h2>
            <span className="text-xs text-ink-secondary/80">{moreStories.length} más</span>
          </div>
          <ul className="grid gap-3.5 sm:grid-cols-[repeat(auto-fit,minmax(300px,1fr))]">
            {moreStories.map((story) => (
              <li key={story.link} className="flex">
                <StoryCard story={story} now={now} compact />
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="text-center text-xs text-ink-secondary/80">
        Los titulares y resúmenes de “Lo esencial” los escribe la IA: confirma los datos en cada
        artículo. Historias e imágenes de sus medios; cada una abre en su sitio.
      </p>
    </div>
  );
}

const SECTION_TITLE = "text-[13px] font-bold uppercase tracking-[0.12em] text-primary";

const CALLOUT: Record<"glow" | "tinted", string> = {
  glow: "border-primary/55 bg-white/[0.035] shadow-[0_0_0_1px_rgb(64_179_117/0.15),0_0_40px_rgb(64_179_117/0.22),inset_0_1px_0_rgb(255_255_255/0.05)]",
  tinted:
    "border-primary/30 bg-gradient-to-br from-primary/[0.16] to-primary/[0.06] shadow-[0_14px_40px_rgb(0_0_0/0.3),inset_0_1px_0_rgb(255_255_255/0.06)]",
};

/** Desktop app: the system browser (an `<a target="_blank">` would stay inside the app). */
function openInBrowser(e: MouseEvent<HTMLAnchorElement>, link: string) {
  if (!isDesktopApp()) return; // the link opens in a new tab by itself
  e.preventDefault();
  void openExternal(link);
}

/** One story: thumbnail, headline, two lines of summary, the source and how long ago. */
function StoryCard({
  story,
  now,
  compact = false,
}: Readonly<{ story: NewsStory; now: number; compact?: boolean }>) {
  const when = timeAgo(story.pubDate, now);
  return (
    <a
      href={story.link}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => openInBrowser(e, story.link)}
      className="group flex w-full gap-4 rounded-2xl border border-white/[0.08] bg-white/[0.035] p-4 shadow-[0_10px_30px_rgb(0_0_0/0.25),inset_0_1px_0_rgb(255_255_255/0.04)] backdrop-blur-lg transition duration-200 hover:-translate-y-0.5 hover:border-primary/35 hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      data-news-card={compact ? "more" : "top"}
    >
      <Thumbnail src={story.thumbnailUrl} label={story.sourceName} />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <h3 className="text-[15px] font-bold leading-[1.3] text-ink [text-wrap:pretty]">
          {story.headline}
        </h3>
        {story.summary && (
          <p className="line-clamp-2 text-[13px] leading-normal text-ink-secondary">
            {story.summary}
          </p>
        )}
        <div className="mt-auto flex flex-wrap items-center gap-2">
          <span className="inline-flex h-5 items-center whitespace-nowrap rounded-full border border-white/10 bg-white/[0.06] px-2 text-[11px] font-semibold text-ink/80">
            {story.sourceName}
          </span>
          {when && (
            <time
              dateTime={story.pubDate ?? undefined}
              title={fullDate(story.pubDate)}
              className="font-mono text-[11px] text-ink-secondary/70"
            >
              {when}
            </time>
          )}
        </div>
      </div>
    </a>
  );
}

/** The story's image, or the design's striped tile with the source's name when it has none. */
function Thumbnail({ src, label }: Readonly<{ src: string | null; label: string }>) {
  const [failed, setFailed] = useState(false);
  const box = "h-[84px] w-[84px] shrink-0 overflow-hidden rounded-xl border border-white/[0.08]";
  if (!src || failed) {
    return (
      <div
        className={`${box} flex items-center justify-center bg-[repeating-linear-gradient(135deg,rgb(255_255_255/0.07)_0_6px,rgb(255_255_255/0.02)_6px_12px)] p-1.5 text-center font-mono text-[10px] leading-tight text-ink-secondary/80`}
        aria-hidden="true"
        data-news-thumb="placeholder"
      >
        {label}
      </div>
    );
  }
  return (
    <div className={`${box} bg-white/[0.04]`}>
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className="h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.06]"
        data-news-thumb="image"
      />
    </div>
  );
}

const svg = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  viewBox: "0 0 24 24",
  "aria-hidden": true,
} as const;

function TrendIcon() {
  return (
    <svg {...svg} width="16" height="16" className="text-primary">
      <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
      <polyline points="16 7 22 7 22 13" />
    </svg>
  );
}

function BulbIcon() {
  return (
    <svg {...svg} width="22" height="22">
      <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
      <path d="M9 18h6" />
      <path d="M10 22h4" />
    </svg>
  );
}

function CheckCircleIcon() {
  return (
    <svg {...svg} strokeWidth={2.2} width="18" height="18" className="mt-0.5 shrink-0 text-primary">
      <circle cx="12" cy="12" r="10" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

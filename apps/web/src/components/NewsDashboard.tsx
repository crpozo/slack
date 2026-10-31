import {
  type NewsDeepDive,
  type NewsHorizon,
  type NewsStory,
  type NewsTakeaway,
  type NewsTrend,
  type NewsWatchItem,
} from "@mindfultech/shared";
import { useCallback, useState, type MouseEvent, type ReactNode } from "react";
import { isDesktopApp } from "../lib/desktop";
import { openExternal } from "../lib/external";
import { fullDate } from "../lib/news";
import { fallbackIconFor, highlightParts, MIN_THUMBNAIL_PX, timeAgo } from "../lib/newsDashboard";
import { CpuIcon, NewspaperIcon, RefreshIcon } from "./icons";

export interface NewsDashboardProps {
  /** "Mié 28 oct 2026" */
  dateLabel: string;
  /** How many stories the summary was made from. */
  storyCount: number;
  /** "Lo esencial": the day's top stories. */
  stories: NewsStory[];
  /** "A fondo" (Phase 44); the section is left out without one. */
  deepDive?: NewsDeepDive;
  /** "Tendencias"; the section is left out while there are none. */
  trends: NewsTrend[];
  /** "Qué significa para MindfulTech". */
  takeaways: NewsTakeaway[];
  /** "Para seguir de cerca" (Phase 44); left out while empty. */
  watchlist?: NewsWatchItem[];
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
  deepDive,
  trends,
  takeaways,
  watchlist = [],
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

      {deepDive && (
        <section
          aria-labelledby="news-deep-title"
          className="flex flex-col gap-4 rounded-[18px] border border-white/10 bg-gradient-to-b from-white/[0.07] to-white/[0.04] p-6 shadow-[0_14px_40px_rgb(0_0_0/0.3),inset_0_1px_0_rgb(255_255_255/0.06)] backdrop-blur-xl"
          data-news-deep-dive
        >
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <h2 id="news-deep-title" className={SECTION_TITLE}>
              A fondo
            </h2>
            <span className="text-xs text-ink-secondary/80">La historia del día, explicada</span>
          </div>
          <a
            href={deepDive.link}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => openInBrowser(e, deepDive.link)}
            className="group inline-flex flex-wrap items-baseline gap-x-2.5 gap-y-1 self-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <h3 className="text-lg font-extrabold leading-snug tracking-tight text-ink group-hover:underline [text-wrap:pretty]">
              {deepDive.headline}
            </h3>
            <span className="inline-flex h-5 items-center rounded-full border border-white/10 bg-white/[0.06] px-2 text-[11px] font-semibold text-ink/80">
              {deepDive.sourceName}
            </span>
          </a>
          <p className="max-w-3xl text-sm leading-[1.7] text-ink/80 [text-wrap:pretty]">
            {deepDive.context}
          </p>
          <div className="grid gap-5 md:grid-cols-2">
            {deepDive.implications.length > 0 && (
              <div className="flex flex-col gap-2">
                <h4 className="font-mono text-[11px] uppercase tracking-wider text-ink-secondary/80">
                  Qué cambia para nosotros
                </h4>
                <ul className="flex flex-col gap-2">
                  {deepDive.implications.map((text, i) => (
                    <li
                      key={i}
                      className="flex items-start gap-2.5 text-sm leading-[1.55] text-ink/85"
                    >
                      <CheckCircleIcon />
                      <span className="[text-wrap:pretty]">{text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {deepDive.questions.length > 0 && (
              <div className="flex flex-col gap-2">
                <h4 className="font-mono text-[11px] uppercase tracking-wider text-ink-secondary/80">
                  Preguntas abiertas
                </h4>
                <ul className="flex flex-col gap-2">
                  {deepDive.questions.map((text, i) => (
                    <li
                      key={i}
                      className="flex items-start gap-2.5 text-sm leading-[1.55] text-ink/75"
                    >
                      <span
                        className="mt-0.5 inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border border-white/15 font-mono text-[10px] text-ink-secondary"
                        aria-hidden="true"
                      >
                        ?
                      </span>
                      <span className="[text-wrap:pretty]">{text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>
      )}

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
                {trend.evidence && trend.evidence.length > 0 && (
                  <ul
                    className="flex flex-wrap gap-1.5"
                    aria-label="Historias detrás de la tendencia"
                  >
                    {trend.evidence.map((e) => (
                      <li key={e.link}>
                        <a
                          href={e.link}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(ev) => openInBrowser(ev, e.link)}
                          title={e.title}
                          className="inline-flex max-w-[260px] items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-0.5 text-[11px] text-ink/75 transition hover:border-primary/40 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                        >
                          <span className="font-semibold text-ink/60">{e.sourceName}</span>
                          <span className="truncate">{e.title}</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
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
                  {t.horizon && <HorizonChip horizon={t.horizon} />}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          insightsNotice
        )}
      </section>

      {watchlist.length > 0 && (
        <section
          aria-labelledby="news-watch-title"
          className="flex flex-col gap-3.5"
          data-news-watchlist
        >
          <div className="flex items-baseline gap-2.5">
            <h2 id="news-watch-title" className={SECTION_TITLE}>
              Para seguir de cerca
            </h2>
            <span className="text-xs text-ink-secondary/80">Los próximos días</span>
          </div>
          <ul className="grid gap-3 sm:grid-cols-2">
            {watchlist.map((w, i) => (
              <li
                key={`${i}-${w.topic}`}
                className="flex gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.035] p-4 backdrop-blur-lg"
              >
                <EyeIcon />
                <div className="flex min-w-0 flex-col gap-1">
                  <h3 className="text-[13px] font-bold text-ink">{w.topic}</h3>
                  <p className="text-[13px] leading-normal text-ink-secondary [text-wrap:pretty]">
                    {w.text}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

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
      {/* A new address starts over (loading, then the image or the fallback). */}
      <Thumbnail key={story.thumbnailUrl ?? "none"} story={story} />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <h3 className="text-[15px] font-bold leading-[1.3] text-ink [text-wrap:pretty]">
          {story.headline}
        </h3>
        {story.summary && (
          <p className="line-clamp-2 text-[13px] leading-normal text-ink-secondary">
            {story.summary}
          </p>
        )}
        {!compact && story.whyItMatters && (
          <p className="text-[13px] leading-normal text-ink/80 [text-wrap:pretty]">
            <span className="font-semibold text-[#6fcf97]">Por qué importa: </span>
            {story.whyItMatters}
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

type ThumbState = "loading" | "image" | "fallback";

/**
 * The story's image in a fixed square, or a deliberate fallback: a faint
 * brand-green gradient into dark slate with a muted icon (a chip for
 * hardware stories, a newspaper otherwise). The fallback is the box's own
 * background, so while an image loads it shows there, and an image fades in
 * over it only once it has loaded. No image, one that fails, or a tracking
 * pixel (under `MIN_THUMBNAIL_PX`) all leave the fallback. The box is the
 * same in every case: 84 × 84, square, rounded.
 */
function Thumbnail({ story }: Readonly<{ story: NewsStory }>) {
  const src = story.thumbnailUrl;
  const [state, setState] = useState<ThumbState>(src ? "loading" : "fallback");
  const Fallback = fallbackIconFor(story) === "cpu" ? CpuIcon : NewspaperIcon;

  const settle = (img: HTMLImageElement) =>
    setState(
      img.naturalWidth >= MIN_THUMBNAIL_PX && img.naturalHeight >= MIN_THUMBNAIL_PX
        ? "image"
        : "fallback",
    );
  // An image already in the browser's cache can finish before React listens
  // for `load`. (The card keys this by its address, so it runs once per image.)
  const imgRef = useCallback((img: HTMLImageElement | null) => {
    if (!img?.complete) return;
    if (img.naturalWidth > 0) settle(img);
    else if (img.currentSrc) setState("fallback");
  }, []);

  return (
    <div
      className="relative aspect-square h-[84px] w-[84px] shrink-0 self-start overflow-hidden rounded-xl border border-white/[0.08] bg-[linear-gradient(135deg,rgb(64_179_117/0.10)_0%,rgb(30_41_59/0.55)_55%,rgb(15_23_42/0.85)_100%)] shadow-[inset_0_1px_0_rgb(255_255_255/0.06)]"
      data-news-thumb={state === "image" ? "image" : "fallback"}
    >
      <span
        className={`absolute inset-0 flex items-center justify-center transition-opacity duration-300 ${
          state === "image" ? "opacity-0" : "opacity-100"
        }`}
        aria-hidden="true"
      >
        <Fallback className="h-7 w-7 text-white/30" strokeWidth={1.5} />
      </span>
      {src && state !== "fallback" && (
        <img
          ref={imgRef}
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={(e) => settle(e.currentTarget)}
          onError={() => setState("fallback")}
          className={`absolute inset-0 h-full w-full object-cover transition duration-500 ease-out group-hover:scale-[1.06] ${
            state === "image" ? "opacity-100" : "opacity-0"
          }`}
        />
      )}
    </div>
  );
}

const HORIZON_LABEL: Record<NewsHorizon, string> = {
  ahora: "esta semana",
  trimestre: "este trimestre",
  vigilar: "vigilar",
};

/** When a takeaway applies, as a small chip after the sentence. */
function HorizonChip({ horizon }: Readonly<{ horizon: NewsHorizon }>) {
  return (
    <span
      className={`ml-2 inline-flex h-[18px] items-center whitespace-nowrap rounded-full border px-2 align-middle font-mono text-[10px] uppercase tracking-wider ${
        horizon === "ahora"
          ? "border-primary/50 bg-primary/15 text-[#8fe0b0]"
          : "border-white/10 bg-white/[0.05] text-ink-secondary"
      }`}
      data-horizon={horizon}
    >
      {HORIZON_LABEL[horizon]}
    </span>
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

function EyeIcon() {
  return (
    <svg {...svg} width="18" height="18" className="mt-0.5 shrink-0 text-primary">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
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

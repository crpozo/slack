import {
  type NewsAudio,
  type NewsDeepDive,
  type NewsHorizon,
  type NewsStory,
  type NewsTakeaway,
  type NewsTrend,
  type NewsWatchItem,
} from "@mindfultech/shared";
import { useCallback, useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { isDesktopApp } from "../lib/desktop";
import { openExternal } from "../lib/external";
import { fullDate } from "../lib/news";
import { actionsTitle, highlightParts, MIN_THUMBNAIL_PX, timeAgo } from "../lib/newsDashboard";
import { HeadphonesIcon, RefreshIcon } from "./icons";

export interface NewsDashboardProps {
  /** "Mié 28 oct 2026" */
  dateLabel: string;
  /** How many stories the summary was made from. */
  storyCount: number;
  /** "Lo esencial": the day's top stories (the first is the lead). */
  stories: NewsStory[];
  /** "A fondo" (Phase 44); the section is left out without one. */
  deepDive?: NewsDeepDive;
  /** "Tendencias"; the section is left out while there are none. */
  trends: NewsTrend[];
  /** "Para MindfulTech": the suggested actions. */
  takeaways: NewsTakeaway[];
  /** "Para seguir de cerca" (Phase 44); left out while empty. */
  watchlist?: NewsWatchItem[];
  /** Every other live story, at the end. */
  moreStories?: NewsStory[];
  now: number;
  refreshing: boolean;
  onRefresh: () => void;
  /** Beside "Refresh" (Phase 50b: the "Pregunta a la IA" toggle). */
  headerActions?: ReactNode;
  /** In the MindfulTech band instead of the actions when there's no analysis (yet). */
  insightsNotice?: ReactNode;
  /** Under the band's title (an admin's "Generar análisis"). */
  insightsAction?: ReactNode;
  /** Under the tabs (the feeds couldn't be read, a refresh failed, the progress bar). */
  banner?: ReactNode;
  /** Before the title (the phone's menu button). */
  leading?: ReactNode;
  /** Phase 54: the summary read aloud in Spanish, when it's made. */
  audio?: NewsAudio;
}

/**
 * The AI News dashboard as a newspaper (Phase 51, from the editorial
 * design): a masthead, the sections as tabs, the lead story beside the
 * numbered rest of "Lo esencial", the MindfulTech actions on a dark band,
 * the trends in columns, then "A fondo", what to watch and every other
 * story. Rendered inside `.news-paper` (the paper tokens). Presentational:
 * `NewsView` feeds it.
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
  headerActions,
  insightsNotice,
  insightsAction,
  banner,
  leading,
  audio,
}: Readonly<NewsDashboardProps>) {
  const [lead, ...rest] = stories;
  return (
    <div
      className="flex w-full min-w-0 flex-col gap-12 [container-type:inline-size] sm:gap-14 [&>section]:scroll-mt-16"
      data-news-dashboard
    >
      <div className="flex flex-col gap-0">
        <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 border-b-[3px] border-ink pb-5">
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex items-center gap-2">
              {leading}
              <h1 className="font-serif text-[44px] font-semibold leading-[0.95] tracking-[-0.02em] text-ink sm:text-[60px]">
                AI News
              </h1>
            </div>
            <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-secondary">
              <span data-news-date>{dateLabel}</span>
              <span aria-hidden="true">·</span>
              <span>
                Resumido por IA a partir de{" "}
                <span className="text-ink" data-news-story-count>
                  {storyCount} {storyCount === 1 ? "historia" : "historias"}
                </span>
              </span>
            </p>
            {audio && <AudioSummary audio={audio} />}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {headerActions}
            <button
              type="button"
              onClick={onRefresh}
              disabled={refreshing}
              className="inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-full bg-ink px-5 text-[13px] font-semibold text-surface transition hover:bg-ink/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-70"
              aria-label="Refresh news"
              title="Read the latest stories from every source now"
              data-refresh-news
            >
              <RefreshIcon className={refreshing ? "animate-spin" : ""} aria-hidden="true" />
              <span>{refreshing ? "Actualizando…" : "Refresh"}</span>
            </button>
          </div>
        </header>

        <SectionTabs
          sections={[
            { id: "news-top", label: "Lo esencial", show: stories.length > 0 },
            { id: "news-impact", label: "Para MindfulTech", show: true },
            { id: "news-trends", label: "Tendencias", show: trends.length > 0 },
            { id: "news-deep", label: "A fondo", show: !!deepDive },
            { id: "news-watch", label: "Seguir de cerca", show: watchlist.length > 0 },
            { id: "news-more", label: "Más historias", show: moreStories.length > 0 },
          ]}
        />

        {banner && <div className="mt-5 flex flex-col gap-3 empty:hidden">{banner}</div>}
      </div>

      {lead && (
        <section
          id="news-top"
          aria-label="Lo esencial"
          className="grid grid-cols-[minmax(0,1fr)] gap-10 cq-lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)] cq-lg:gap-12"
        >
          <LeadStory story={lead} now={now} />
          {rest.length > 0 && (
            <ol className="flex flex-col cq-lg:border-l cq-lg:border-line cq-lg:pl-10">
              {rest.map((story, i) => (
                <li
                  key={story.link}
                  className="border-t border-line py-5 [container-type:inline-size] first:border-t-0 first:pt-0 last:pb-0"
                >
                  <ListedStory story={story} number={i + 2} now={now} />
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

      <section
        id="news-impact"
        aria-labelledby="news-impact-title"
        className="news-dark -mx-4 grid grid-cols-[minmax(0,1fr)] gap-10 bg-surface px-6 py-10 sm:mx-0 sm:px-10 sm:py-12 cq-xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] cq-xl:gap-14"
        data-news-impact
      >
        <div className="flex flex-col gap-4">
          <span className={KICKER}>Para MindfulTech</span>
          <h2
            id="news-impact-title"
            className="font-serif text-[30px] font-medium leading-[1.1] tracking-[-0.01em] text-ink sm:text-[36px] [text-wrap:balance]"
          >
            {actionsTitle(takeaways.length)}
          </h2>
          <p className="text-sm leading-relaxed text-ink-secondary">
            Impacto de negocio derivado de las historias de hoy.
          </p>
          {insightsAction && <div className="mt-1">{insightsAction}</div>}
        </div>
        {takeaways.length > 0 ? (
          <ol className="grid grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-8 cq-sm:grid-cols-2 cq-lg:grid-cols-3 cq-xl:grid-cols-2">
            {takeaways.map((t, i) => (
              <li
                key={`${i}-${t.lead}`}
                className="flex flex-col gap-2 border-t border-white/15 pt-4"
                data-horizon={t.horizon}
              >
                <span className={KICKER}>
                  {t.horizon ? HORIZON_LABEL[t.horizon] : `Acción ${pad(i + 1)}`}
                </span>
                <p className="text-[15px] font-semibold leading-snug text-ink [text-wrap:pretty]">
                  {t.lead}
                </p>
                <p className="text-sm leading-[1.6] text-ink/70 [text-wrap:pretty]">{t.body}</p>
              </li>
            ))}
          </ol>
        ) : (
          <div className="self-center">{insightsNotice}</div>
        )}
      </section>

      {trends.length > 0 && (
        <section
          id="news-trends"
          aria-labelledby="news-trends-title"
          className="flex flex-col gap-7"
          data-news-trends
        >
          <SectionHeader id="news-trends-title" kicker="Lo que se repite" title="Tendencias" />
          <ol className="grid grid-cols-[minmax(0,1fr)] gap-x-8 gap-y-10 cq-sm:grid-cols-2 cq-xl:grid-cols-4">
            {trends.map((trend, i) => (
              <li
                key={`${i}-${trend.topic}`}
                className="flex flex-col gap-3 border-t-[3px] border-ink pt-4"
              >
                <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-secondary">
                  Tendencia {pad(i + 1)}
                </span>
                <h3 className="font-serif text-[22px] font-medium leading-[1.2] text-ink [text-wrap:balance]">
                  {trend.topic}
                </h3>
                <p className="text-sm leading-[1.65] text-ink/75 [text-wrap:pretty]">
                  {highlightParts(trend.text).map((part, j) =>
                    part.mark ? (
                      <strong key={j} className="font-semibold text-ink">
                        {part.text}
                      </strong>
                    ) : (
                      <span key={j}>{part.text}</span>
                    ),
                  )}
                </p>
                {trend.evidence && trend.evidence.length > 0 && (
                  <ul
                    className="mt-1 flex flex-col gap-1.5 border-t border-line pt-3"
                    aria-label="Historias detrás de la tendencia"
                  >
                    {trend.evidence.map((e) => (
                      <li key={e.link} className="min-w-0">
                        <a
                          href={e.link}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(ev) => openInBrowser(ev, e.link)}
                          title={e.title}
                          className="group flex min-w-0 items-baseline gap-1.5 text-xs text-ink-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                        >
                          <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-primary">
                            {e.sourceName}
                          </span>
                          <span className="truncate group-hover:text-ink group-hover:underline">
                            {e.title}
                          </span>
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

      {deepDive && (
        <section
          id="news-deep"
          aria-labelledby="news-deep-title"
          className="flex flex-col gap-7"
          data-news-deep-dive
        >
          <SectionHeader
            id="news-deep-title"
            kicker="A fondo"
            title="La historia del día, explicada"
          />
          <div className="grid grid-cols-[minmax(0,1fr)] gap-10 cq-lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)] cq-lg:gap-12">
            <div className="flex flex-col gap-4">
              <a
                href={deepDive.link}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => openInBrowser(e, deepDive.link)}
                className="group self-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <h3 className="font-serif text-[28px] font-medium leading-[1.15] tracking-[-0.01em] text-ink decoration-1 underline-offset-4 group-hover:underline sm:text-[32px] [text-wrap:balance]">
                  {deepDive.headline}
                </h3>
              </a>
              <span className={META}>{deepDive.sourceName}</span>
              <p className="max-w-[68ch] font-serif text-[18px] leading-[1.65] text-ink/85 first-letter:float-left first-letter:mr-2 first-letter:mt-1 first-letter:font-serif first-letter:text-[58px] first-letter:font-semibold first-letter:leading-[0.8] first-letter:text-ink [text-wrap:pretty]">
                {deepDive.context}
              </p>
            </div>
            <div className="flex flex-col gap-8 cq-lg:border-l cq-lg:border-line cq-lg:pl-10">
              {deepDive.implications.length > 0 && (
                <div className="flex flex-col gap-3">
                  <h4 className={KICKER}>Qué cambia para nosotros</h4>
                  <ol className="flex flex-col">
                    {deepDive.implications.map((text, i) => (
                      <li
                        key={i}
                        className="flex gap-3 border-t border-line py-3 text-sm leading-[1.6] text-ink/85 first:border-t-0 first:pt-0"
                      >
                        <span className="shrink-0 font-mono text-[11px] leading-[1.6] text-primary">
                          {pad(i + 1)}
                        </span>
                        <span className="[text-wrap:pretty]">{text}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
              {deepDive.questions.length > 0 && (
                <div className="flex flex-col gap-3">
                  <h4 className={KICKER}>Preguntas abiertas</h4>
                  <ul className="flex flex-col gap-3">
                    {deepDive.questions.map((text, i) => (
                      <li
                        key={i}
                        className="font-serif text-[17px] italic leading-[1.45] text-ink/80 [text-wrap:pretty]"
                      >
                        {text}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {watchlist.length > 0 && (
        <section
          id="news-watch"
          aria-labelledby="news-watch-title"
          className="flex flex-col gap-7"
          data-news-watchlist
        >
          <SectionHeader
            id="news-watch-title"
            kicker="Los próximos días"
            title="Para seguir de cerca"
          />
          <ul className="grid grid-cols-[minmax(0,1fr)] gap-x-8 gap-y-8 cq-sm:grid-cols-2 cq-lg:grid-cols-3">
            {watchlist.map((w, i) => (
              <li key={`${i}-${w.topic}`} className="flex flex-col gap-2 border-t border-ink pt-4">
                <span className={KICKER}>{pad(i + 1)}</span>
                <h3 className="font-serif text-[19px] font-medium leading-snug text-ink">
                  {w.topic}
                </h3>
                <p className="text-sm leading-[1.6] text-ink-secondary [text-wrap:pretty]">
                  {w.text}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {moreStories.length > 0 && (
        <section id="news-more" aria-labelledby="news-more-title" className="flex flex-col gap-7">
          <SectionHeader
            id="news-more-title"
            kicker={`${moreStories.length} más`}
            title="Más historias"
          />
          <ul className="grid grid-cols-[minmax(0,1fr)] gap-x-8 gap-y-10 cq-sm:grid-cols-2 cq-md:grid-cols-3 cq-xl:grid-cols-4">
            {moreStories.map((story) => (
              <li key={story.link} className="flex">
                <MoreStory story={story} now={now} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="border-t border-line pt-5 text-center font-mono text-[11px] leading-relaxed tracking-wide text-ink-secondary">
        Los titulares y resúmenes de “Lo esencial” los escribe la IA: confirma los datos en cada
        artículo. Historias e imágenes de sus medios; cada una abre en su sitio.
      </p>
    </div>
  );
}

/**
 * "Escucha el resumen" (Phase 54): the day's top stories, trends and actions
 * read aloud in Spanish. The browser's own player (it works with the lock
 * screen and headphones on phones), loaded only when you press play.
 */
function AudioSummary({ audio }: Readonly<{ audio: NewsAudio }>) {
  const minutes = Math.max(1, Math.round(audio.seconds / 60));
  return (
    <div
      className="mt-1 flex w-full max-w-xl flex-wrap items-center gap-x-3 gap-y-2"
      data-news-audio
    >
      <span className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-primary">
        <HeadphonesIcon aria-hidden="true" />
        Escucha el resumen · {minutes} min
      </span>
      <audio
        controls
        preload="none"
        src={audio.url}
        className="h-9 w-full min-w-0 [color-scheme:dark] sm:w-80"
        aria-label="Resumen de las noticias en audio"
      />
    </div>
  );
}

const KICKER = "font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-primary";
const META = "font-mono text-[11px] uppercase tracking-[0.12em] text-ink-secondary";

const pad = (n: number) => String(n).padStart(2, "0");

function SectionHeader({
  id,
  kicker,
  title,
}: Readonly<{ id: string; kicker: string; title: string }>) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-1 border-b border-ink pb-3">
      <h2
        id={id}
        className="font-serif text-[30px] font-medium leading-none tracking-[-0.01em] text-ink sm:text-[34px]"
      >
        {title}
      </h2>
      <span className={KICKER}>{kicker}</span>
    </div>
  );
}

/**
 * The sections as text tabs (Phase 51), sticky at the top of the view: one
 * tap to jump, and the one being read is underlined in green. Solid, no
 * backdrop blur (a blurred sticky bar over the page made Chrome flicker).
 */
function SectionTabs({
  sections,
}: Readonly<{ sections: Array<{ id: string; label: string; show: boolean }> }>) {
  const shown = sections.filter((s) => s.show);
  const ids = shown.map((s) => s.id).join(" ");
  const [active, setActive] = useState(shown[0]?.id ?? "");

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const visible = new Map<string, boolean>();
    const order = ids.split(" ");
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) visible.set(entry.target.id, entry.isIntersecting);
        const first = order.find((id) => visible.get(id));
        if (first) setActive(first);
      },
      // The band just under the tabs: a section is "being read" while it crosses it.
      { rootMargin: "-80px 0px -55% 0px" },
    );
    for (const id of order) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [ids]);

  if (shown.length < 2) return null;
  return (
    <nav
      aria-label="Secciones"
      className="sticky top-0 z-20 -mx-4 flex gap-6 overflow-x-auto overflow-y-hidden border-b border-line bg-surface px-4 [scrollbar-width:none] sm:-mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden"
      data-news-sections
    >
      {shown.map((section) => {
        const current = section.id === active;
        return (
          <button
            key={section.id}
            type="button"
            onClick={() => {
              setActive(section.id);
              document
                .getElementById(section.id)
                ?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
            aria-current={current ? "true" : undefined}
            className={`-mb-px shrink-0 whitespace-nowrap border-b-2 py-3 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary ${
              current
                ? "border-primary text-ink"
                : "border-transparent text-ink-secondary hover:text-ink"
            }`}
          >
            {section.label}
          </button>
        );
      })}
    </nav>
  );
}

/** Desktop app: the system browser (an `<a target="_blank">` would stay inside the app). */
function openInBrowser(e: MouseEvent<HTMLAnchorElement>, link: string) {
  if (!isDesktopApp()) return; // the link opens in a new tab by itself
  e.preventDefault();
  void openExternal(link);
}

/** "TECHCRUNCH · HACE 3 H" */
function StoryMeta({ story, now }: Readonly<{ story: NewsStory; now: number }>) {
  const when = timeAgo(story.pubDate, now);
  return (
    <p className={META}>
      <span>{story.sourceName}</span>
      {when && (
        <>
          <span aria-hidden="true"> · </span>
          <time dateTime={story.pubDate ?? undefined} title={fullDate(story.pubDate)}>
            {when}
          </time>
        </>
      )}
    </p>
  );
}

/** "Lo esencial · 01": the big picture, the headline, the summary and why it matters. */
function LeadStory({ story, now }: Readonly<{ story: NewsStory; now: number }>) {
  return (
    <a
      href={story.link}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => openInBrowser(e, story.link)}
      className="group flex min-w-0 flex-col gap-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-4 focus-visible:ring-offset-surface"
      data-news-card="top"
    >
      <Cover key={story.thumbnailUrl ?? "none"} story={story} className="aspect-[16/9]" />
      <div className="flex flex-col gap-4">
        <span className={KICKER}>Lo esencial · 01</span>
        <h2 className="font-serif text-[30px] font-medium leading-[1.08] tracking-[-0.015em] text-ink decoration-1 underline-offset-[6px] group-hover:underline sm:text-[40px] [text-wrap:balance]">
          {story.headline}
        </h2>
        {story.summary && (
          <p className="max-w-[62ch] text-base leading-[1.65] text-ink/80 [text-wrap:pretty]">
            {story.summary}
          </p>
        )}
        {story.whyItMatters && (
          <p className="max-w-[62ch] border-l-2 border-primary pl-4 text-[15px] leading-[1.6] text-ink/85 [text-wrap:pretty]">
            <span className="font-serif font-semibold italic text-primary">Por qué importa — </span>
            {story.whyItMatters}
          </p>
        )}
        <StoryMeta story={story} now={now} />
      </div>
    </a>
  );
}

/** One of 02–06: the number, the headline, one line on why it matters, the source. */
function ListedStory({
  story,
  number,
  now,
}: Readonly<{ story: NewsStory; number: number; now: number }>) {
  return (
    <a
      href={story.link}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => openInBrowser(e, story.link)}
      className="group grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-3 cq-2xs:grid-cols-[2.5rem_minmax(0,1fr)_5.5rem] cq-xs:grid-cols-[2.5rem_minmax(0,1fr)_8rem] cq-xs:gap-x-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      data-news-card="top"
    >
      <span
        className="font-serif text-[28px] font-medium leading-none tabular-nums text-ink/30"
        aria-hidden="true"
      >
        {pad(number)}
      </span>
      <div className="flex min-w-0 flex-col gap-2">
        <h3 className="font-serif text-[19px] font-medium leading-[1.25] text-ink decoration-1 underline-offset-4 group-hover:underline [text-wrap:pretty]">
          {story.headline}
        </h3>
        {(story.whyItMatters || story.summary) && (
          <p className="line-clamp-2 text-[13px] leading-normal text-ink-secondary">
            {story.whyItMatters ?? story.summary}
          </p>
        )}
        <StoryMeta story={story} now={now} />
      </div>
      {/* The story's picture beside it (Phase 51c); the lined placeholder without one. */}
      <Cover
        key={story.thumbnailUrl ?? "none"}
        story={story}
        className="hidden aspect-[4/3] self-start cq-2xs:block"
        caption={false}
      />
    </a>
  );
}

/** "Más historias": a small picture, the source, the headline and two lines. */
function MoreStory({ story, now }: Readonly<{ story: NewsStory; now: number }>) {
  return (
    <a
      href={story.link}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => openInBrowser(e, story.link)}
      className="group flex w-full min-w-0 flex-col gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      data-news-card="more"
    >
      <Cover key={story.thumbnailUrl ?? "none"} story={story} className="aspect-[3/2]" />
      <StoryMeta story={story} now={now} />
      <h3 className="font-serif text-[18px] font-medium leading-[1.3] text-ink decoration-1 underline-offset-4 group-hover:underline [text-wrap:pretty]">
        {story.headline}
      </h3>
      {story.summary && (
        <p className="line-clamp-2 text-[13px] leading-normal text-ink-secondary">
          {story.summary}
        </p>
      )}
    </a>
  );
}

type CoverState = "loading" | "image" | "fallback";

/**
 * The story's picture at the given aspect, or a deliberate placeholder: fine
 * diagonal lines with "imagen · {medio}". The placeholder is the box's own
 * background, so it shows while an image loads, and an image fades in over
 * it once it has loaded. No image, one that fails, or a tracking pixel
 * (under `MIN_THUMBNAIL_PX`) leave the placeholder.
 */
function Cover({
  story,
  className,
  caption = true,
}: Readonly<{ story: NewsStory; className: string; caption?: boolean }>) {
  const src = story.thumbnailUrl;
  const [state, setState] = useState<CoverState>(src ? "loading" : "fallback");

  const settle = (img: HTMLImageElement) =>
    setState(
      img.naturalWidth >= MIN_THUMBNAIL_PX && img.naturalHeight >= MIN_THUMBNAIL_PX
        ? "image"
        : "fallback",
    );
  // An image already in the browser's cache can finish before React listens
  // for `load`. (The story keys this by its address, so it runs once per image.)
  const imgRef = useCallback((img: HTMLImageElement | null) => {
    if (!img?.complete) return;
    if (img.naturalWidth > 0) settle(img);
    else if (img.currentSrc) setState("fallback");
  }, []);

  return (
    <div
      className={`relative w-full overflow-hidden bg-surface-sidebar bg-[repeating-linear-gradient(135deg,rgb(var(--c-line))_0_1px,transparent_1px_11px)] ${className}`}
      data-news-thumb={state === "image" ? "image" : "fallback"}
    >
      <span
        className={`absolute inset-0 flex items-center justify-center transition-opacity duration-300 ${
          state === "image" ? "opacity-0" : "opacity-100"
        }`}
        aria-hidden="true"
      >
        {caption && (
          <span className="bg-surface-sidebar px-2 py-0.5 font-mono text-[11px] lowercase tracking-wider text-ink-secondary">
            imagen · {story.sourceName}
          </span>
        )}
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
          className={`absolute inset-0 h-full w-full object-cover transition duration-700 ease-out group-hover:scale-[1.03] ${
            state === "image" ? "opacity-100" : "opacity-0"
          }`}
        />
      )}
    </div>
  );
}

const HORIZON_LABEL: Record<NewsHorizon, string> = {
  ahora: "Esta semana",
  trimestre: "Este trimestre",
  vigilar: "Vigilar",
};

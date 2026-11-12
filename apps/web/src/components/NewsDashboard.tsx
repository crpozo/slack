import {
  type ClaudeModelAlert,
  type NewsAudio,
  type NewsDeepDive,
  type NewsHorizon,
  type NewsSourceStatus,
  type NewsStory,
  type NewsTakeaway,
  type NewsTrend,
  type NewsWatchItem,
} from "@mindfultech/shared";
import { useCallback, useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { isDesktopApp } from "../lib/desktop";
import { openExternal } from "../lib/external";
import { fullDate } from "../lib/news";
import { highlightParts, MIN_THUMBNAIL_PX, timeAgo } from "../lib/newsDashboard";
import { clock, rateLabel, trackOf, useNewsPlayer } from "../lib/newsPlayer";
import {
  CloseIcon,
  ExternalLinkIcon,
  HeadphonesIcon,
  PauseIcon,
  PlayIcon,
  RefreshIcon,
  SparklesIcon,
} from "./icons";

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
  /** Phase 62: every source and whether it answered. */
  sources?: NewsSourceStatus[];
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
  /** Phase 56: Anthropic released a new Claude model, or is about to. */
  claudeAlert?: ClaudeModelAlert | null;
  /** Hides this alert (on this device) until another one comes. */
  onDismissClaudeAlert?: () => void;
  /** Before the title (the phone's menu button). */
  leading?: ReactNode;
  /** Phase 54: the summary read aloud in Spanish, when it's made. */
  audio?: NewsAudio;
  /** Phase 55: the audio is being made (a minute at most); it appears by itself. */
  audioPending?: boolean;
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
  sources = [],
  now,
  refreshing,
  onRefresh,
  headerActions,
  insightsNotice,
  insightsAction,
  banner,
  leading,
  audio,
  audioPending = false,
  claudeAlert,
  onDismissClaudeAlert,
}: Readonly<NewsDashboardProps>) {
  const [lead, ...rest] = stories;
  // The sections are pages (Phase 62): a tab swaps the content, nothing scrolls.
  const sections = [
    { id: "news-top", label: "Lo esencial", show: stories.length > 0 },
    { id: "news-impact", label: "Para MindfulTech", show: true },
    { id: "news-trends", label: "Tendencias", show: trends.length > 0 },
    { id: "news-deep", label: "A fondo", show: !!deepDive },
    { id: "news-watch", label: "Seguir de cerca", show: watchlist.length > 0 },
    { id: "news-more", label: "Más historias", show: moreStories.length > 0 },
    { id: "news-sources", label: "Fuentes", show: sources.length > 0 },
  ].filter((section) => section.show);
  const [picked, setPicked] = useState("");
  const active = sections.some((section) => section.id === picked)
    ? picked
    : (sections[0]?.id ?? "");
  // Picked while far down another page: the new one starts at its top, just
  // under the tabs (never on the first paint, and never scrolling down).
  useEffect(() => {
    if (!picked) return;
    const panel = document.getElementById(picked);
    if (panel && panel.getBoundingClientRect().top < 0) panel.scrollIntoView({ block: "start" });
  }, [picked]);
  return (
    <div
      className="flex w-full min-w-0 flex-col gap-12 [container-type:inline-size] sm:gap-14 [&>section]:scroll-mt-16"
      data-news-dashboard
    >
      <div className="flex flex-col gap-0">
        <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 pb-6">
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
            {audio ? (
              <AudioSummary audio={audio} />
            ) : (
              audioPending && (
                <p
                  className="mt-1 inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-secondary"
                  role="status"
                  data-news-audio-pending
                >
                  <HeadphonesIcon className="animate-pulse text-primary" aria-hidden="true" />
                  Preparando el resumen en audio…
                </p>
              )
            )}
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

        {claudeAlert && <ClaudeAlertBanner alert={claudeAlert} onDismiss={onDismissClaudeAlert} />}

        <SectionTabs sections={sections} active={active} onSelect={setPicked} />

        {banner && <div className="mt-5 flex flex-col gap-3 empty:hidden">{banner}</div>}
      </div>

      {lead && active === "news-top" && (
        <section
          id="news-top"
          role="tabpanel"
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

      {active === "news-impact" && (
        <section
          id="news-impact"
          role="tabpanel"
          aria-label="Para MindfulTech"
          className="news-dark -mx-4 flex flex-col gap-6 bg-surface px-6 py-8 sm:mx-0 sm:rounded-3xl sm:px-10 sm:py-10"
          data-news-impact
        >
          {insightsAction && <div>{insightsAction}</div>}
          {takeaways.length > 0 ? (
            <ol className="grid grid-cols-[minmax(0,1fr)] gap-4 cq-sm:grid-cols-2 cq-lg:grid-cols-3">
              {takeaways.map((t, i) => (
                <li
                  key={`${i}-${t.lead}`}
                  className={`flex flex-col gap-2 ${CARD}`}
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
      )}

      {trends.length > 0 && active === "news-trends" && (
        <section
          id="news-trends"
          role="tabpanel"
          aria-labelledby="news-trends-title"
          className="flex flex-col gap-7"
          data-news-trends
        >
          <SectionHeader id="news-trends-title" kicker="Lo que se repite" title="Tendencias" />
          <ol className="grid grid-cols-[minmax(0,1fr)] gap-4 cq-sm:grid-cols-2 cq-xl:grid-cols-4">
            {trends.map((trend, i) => (
              <li key={`${i}-${trend.topic}`} className={`flex flex-col gap-3 ${CARD}`}>
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
                    className="mt-2 flex flex-col gap-1.5"
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

      {deepDive && active === "news-deep" && (
        <section
          id="news-deep"
          role="tabpanel"
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

      {watchlist.length > 0 && active === "news-watch" && (
        <section
          id="news-watch"
          role="tabpanel"
          aria-labelledby="news-watch-title"
          className="flex flex-col gap-7"
          data-news-watchlist
        >
          <SectionHeader
            id="news-watch-title"
            kicker="Los próximos días"
            title="Para seguir de cerca"
          />
          <ul className="grid grid-cols-[minmax(0,1fr)] gap-4 cq-sm:grid-cols-2 cq-lg:grid-cols-3">
            {watchlist.map((w, i) => (
              <li key={`${i}-${w.topic}`} className={`flex flex-col gap-2 ${CARD}`}>
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

      {moreStories.length > 0 && active === "news-more" && (
        <section
          id="news-more"
          role="tabpanel"
          aria-labelledby="news-more-title"
          className="flex flex-col gap-7"
        >
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

      {sources.length > 0 && active === "news-sources" && <SourcesPanel sources={sources} />}

      <p className="border-t border-line pt-5 text-center font-mono text-[11px] leading-relaxed tracking-wide text-ink-secondary">
        Los titulares y resúmenes de “Lo esencial” los escribe la IA: confirma los datos en cada
        artículo. Historias e imágenes de sus medios; cada una abre en su sitio.
      </p>
    </div>
  );
}

/**
 * Phase 56: a new Claude model, out now (green) or on its way (amber), above
 * everything else: what it is, a line on it, and the stories that say so.
 */
function ClaudeAlertBanner({
  alert,
  onDismiss,
}: Readonly<{ alert: ClaudeModelAlert; onDismiss?: () => void }>) {
  const launched = alert.status === "launched";
  const tone = launched
    ? "border-primary/40 bg-primary/10 text-primary"
    : "border-warning/40 bg-warning/10 text-warning";
  return (
    <aside
      className={`mb-6 flex items-start gap-3 rounded-2xl border px-4 py-4 sm:gap-4 sm:px-5 ${tone}`}
      role="status"
      aria-label={launched ? "Nuevo modelo de Claude" : "Nuevo modelo de Claude en camino"}
      data-claude-alert={alert.status}
    >
      <SparklesIcon className="mt-0.5 shrink-0 text-xl" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="font-mono text-[11px] font-medium uppercase tracking-[0.14em]">
          {launched ? "Claude · nuevo modelo disponible" : "Claude · nuevo modelo en camino"}
          {alert.model && <span className="text-ink"> · {alert.model}</span>}
        </p>
        <p className="font-serif text-[20px] font-medium leading-snug text-ink [text-wrap:balance] sm:text-[22px]">
          {alert.headline}
        </p>
        {alert.summary && (
          <p className="text-sm leading-relaxed text-ink/75 [text-wrap:pretty]">{alert.summary}</p>
        )}
        {alert.evidence.length > 0 && (
          <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1" aria-label="Fuentes">
            {alert.evidence.map((e) => (
              <li key={e.link} className="min-w-0">
                <a
                  href={e.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(ev) => openInBrowser(ev, e.link)}
                  title={e.title}
                  className="inline-flex max-w-full items-center gap-1 text-xs font-semibold underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <span className="truncate">Leer en {e.sourceName}</span>
                  <ExternalLinkIcon className="shrink-0" aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="-mr-1 -mt-1 shrink-0 rounded-md p-1.5 text-ink-secondary hover:bg-white/10 hover:text-ink"
          aria-label="Ocultar el aviso"
          title="Ocultar (vuelve con el próximo aviso)"
        >
          <CloseIcon />
        </button>
      )}
    </aside>
  );
}

/**
 * "Escucha el resumen" (Phase 54): the day's top stories, trends and actions
 * read aloud in Spanish. The browser's own player (it works with the lock
 * screen and headphones on phones), loaded only when you press play.
 */
function AudioSummary({ audio }: Readonly<{ audio: NewsAudio }>) {
  // One player for the whole app: it keeps playing when you leave AI News.
  const player = useNewsPlayer();
  const mine = player.track === trackOf(audio.url);
  const playing = mine && player.playing;
  const position = mine ? player.position : 0;
  const duration = mine && player.duration > 0 ? player.duration : audio.seconds;
  const total = Math.max(1, Math.round(duration));
  const at = Math.min(Math.round(position), total);
  const progress = (at / total) * 100;
  return (
    <div className="mt-1 w-full max-w-md" data-news-audio>
      {/* One row, as tall as the Refresh button: play, title, progress, time, voice. */}
      <div className="flex h-11 items-center gap-3 rounded-full border border-white/10 bg-white/[0.05] py-1 pl-1 pr-4">
        <button
          type="button"
          onClick={() => player.toggle(audio.url)}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface active:scale-95"
          aria-label={playing ? "Pausar el resumen" : "Reproducir el resumen"}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <span className="shrink-0 text-[13px] font-semibold text-ink">Resumen</span>
        <div className="relative h-4 min-w-0 flex-1">
          {/* The bar that's seen; the range over it is what's dragged. */}
          <div className="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-200 ease-linear"
              style={{ width: `${progress}%` }}
            />
          </div>
          <input
            type="range"
            min={0}
            max={total}
            value={at}
            onChange={(e) => player.seek(Number(e.target.value))}
            disabled={!mine}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default"
            aria-label="Posición del audio"
          />
        </div>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-secondary">
          {mine ? `${clock(position)} / ${clock(duration)}` : clock(duration)}
        </span>
        <button
          type="button"
          onClick={player.cycleRate}
          className={`-my-1 shrink-0 rounded-full px-2 py-1 font-mono text-[11px] font-semibold tabular-nums transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
            player.rate === 1 ? "text-ink-secondary" : "text-primary"
          }`}
          aria-label={`Velocidad ${rateLabel(player.rate)}. Cambiar velocidad`}
          title="Cambiar velocidad"
          data-news-audio-rate
        >
          {rateLabel(player.rate)}
        </button>
      </div>
      {mine && player.error && (
        <p className="mt-2 text-xs text-error" role="alert">
          {player.error}
        </p>
      )}
      {audio.voice === "polly" && audio.note && (
        <p className="mt-2 break-words text-xs text-ink-secondary" data-news-audio-note>
          Lo leyó Polly porque ElevenLabs no respondió: {audio.note}
        </p>
      )}
    </div>
  );
}

const KICKER = "font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-primary";
/** Phase 55: a soft panel instead of rules above every item (fewer lines on the page). */
const CARD = "rounded-2xl bg-white/[0.04] p-5";
const META = "font-mono text-[11px] uppercase tracking-[0.12em] text-ink-secondary";

const pad = (n: number) => String(n).padStart(2, "0");

function SectionHeader({
  id,
  kicker,
  title,
}: Readonly<{ id: string; kicker: string; title: string }>) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-1">
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
 * The sections as text tabs, sticky at the top of the view. Each is a page
 * (Phase 62): picking one swaps what's below, and the view goes back to the
 * top of it instead of scrolling down the page. Solid, no backdrop blur (a
 * blurred sticky bar over the page made Chrome flicker).
 */
function SectionTabs({
  sections,
  active,
  onSelect,
}: Readonly<{
  sections: Array<{ id: string; label: string }>;
  active: string;
  onSelect: (id: string) => void;
}>) {
  if (sections.length < 2) return null;
  return (
    <nav
      role="tablist"
      aria-label="Secciones"
      className="sticky top-0 z-20 -mx-4 flex gap-6 overflow-x-auto overflow-y-hidden border-b border-line bg-surface px-4 [scrollbar-width:none] sm:-mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden"
      data-news-sections
    >
      {sections.map((section) => {
        const current = section.id === active;
        return (
          <button
            key={section.id}
            type="button"
            role="tab"
            aria-selected={current}
            aria-controls={section.id}
            onClick={() => {
              if (current) return;
              onSelect(section.id);
            }}
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

/**
 * Phase 62: every publisher AI News reads, whether its feed answered on the
 * last read, and how many of its stories are in today's list.
 */
function SourcesPanel({ sources }: Readonly<{ sources: NewsSourceStatus[] }>) {
  const connected = sources.filter((s) => s.connected).length;
  const ordered = [...sources].sort(
    (a, b) => Number(b.connected) - Number(a.connected) || b.stories - a.stories,
  );
  return (
    <section
      id="news-sources"
      role="tabpanel"
      aria-labelledby="news-sources-title"
      className="flex flex-col gap-7"
      data-news-sources
    >
      <SectionHeader
        id="news-sources-title"
        kicker={`${connected} de ${sources.length} conectadas`}
        title="Fuentes"
      />
      <ul className="grid grid-cols-[minmax(0,1fr)] gap-3 cq-sm:grid-cols-2 cq-lg:grid-cols-3">
        {ordered.map((source) => (
          <li
            key={source.name}
            className={`flex items-center gap-3 ${CARD}`}
            data-source={source.name}
            data-connected={source.connected}
          >
            <span
              className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                source.connected ? "bg-success" : "bg-error"
              }`}
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-semibold text-ink">
                {source.name}
              </span>
              <span className="block text-xs text-ink-secondary">
                {source.connected
                  ? source.stories === 0
                    ? "Conectada · sin historias de IA en las últimas 48 h"
                    : `Conectada · ${source.stories} ${source.stories === 1 ? "historia" : "historias"}`
                  : "Sin conexión: su feed no respondió"}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <p className="text-xs leading-relaxed text-ink-secondary">
        Se leen todas cada 30 minutos. De los medios generales solo entran sus historias de IA, y
        cada fuente aporta como máximo 8 de las 40 del día.
      </p>
    </section>
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
      className={`relative w-full overflow-hidden bg-surface-sidebar bg-[radial-gradient(120%_120%_at_0%_0%,rgb(var(--c-primary)/0.16),transparent_60%)] ${className}`}
      data-news-thumb={state === "image" ? "image" : "fallback"}
    >
      <span
        className={`absolute inset-0 flex items-center justify-center transition-opacity duration-300 ${
          state === "image" ? "opacity-0" : "opacity-100"
        }`}
        aria-hidden="true"
      >
        {/* No picture (the publisher doesn't let it be read): its name, as a masthead. */}
        {caption && (
          <span className="px-4 text-center font-serif text-[clamp(1.25rem,4vw,3.25rem)] font-semibold leading-none tracking-[-0.02em] text-ink/25">
            {story.sourceName}
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

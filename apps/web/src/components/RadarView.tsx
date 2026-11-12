import {
  movementOf,
  RADAR_AI_AUTHOR,
  RADAR_QUADRANTS,
  RADAR_RINGS,
  RING_MEANING,
  type RadarBlip,
  type RadarProposal,
  type RadarQuadrant,
  type RadarRing,
} from "@mindfultech/shared";
import {
  ArrowDownRight,
  ArrowUpRight,
  ExternalLink,
  List as ListIcon,
  Pencil,
  Plus,
  Radar as RadarIcon,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { openExternal } from "../lib/external";
import {
  groupBlips,
  layoutBlips,
  QUADRANT_COLORS,
  quadrantLabelPosition,
  RING_EDGES,
  ringAt,
  wedgePath,
  type BlipPoint,
} from "../lib/radar";
import { tasksApiConfigured } from "../lib/tasksApi";
import { useChat, useNameOf } from "../store";
import { useRadar } from "../store/radar";
import { BlipModal } from "./RadarModals";
import { MenuIcon } from "./icons";
import { UnreadAlertsDot } from "./NotificationBell";

const CHART_MAX = 720;
const CHART_MIN = 300;

const errorText = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback;

const when = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/** The dark glass surface the radar lives on, whatever the app's theme. */
const GLASS = "border border-white/10 bg-white/[0.06] shadow-lg shadow-black/30 backdrop-blur-md";

/** Ring badge colours, Adopt the warmest. */
const RING_TONE: Record<RadarRing, string> = {
  Adopt: "bg-emerald-400/20 text-emerald-200 ring-emerald-300/30",
  Trial: "bg-sky-400/20 text-sky-200 ring-sky-300/30",
  Assess: "bg-amber-400/20 text-amber-200 ring-amber-300/30",
  Hold: "bg-rose-400/20 text-rose-200 ring-rose-300/30",
};

function RingBadge({ ring, small = false }: Readonly<{ ring: RadarRing; small?: boolean }>) {
  return (
    <span
      className={`inline-flex items-center rounded-full font-semibold ring-1 ${RING_TONE[ring]} ${
        small ? "px-1.5 py-px text-[10px]" : "px-2 py-0.5 text-xs"
      }`}
    >
      {ring}
    </span>
  );
}

function QuadrantDot({ quadrant }: Readonly<{ quadrant: RadarQuadrant }>) {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-2.5 w-2.5 rounded-full"
      style={{ background: QUADRANT_COLORS[quadrant] }}
    />
  );
}

function Movement({ blip }: Readonly<{ blip: RadarBlip }>) {
  const movement = movementOf(blip);
  if (!movement) return null;
  const Icon = movement === "in" ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-[11px] ${
        movement === "in" ? "text-emerald-300" : "text-rose-300"
      }`}
      title={`Moved ${movement === "in" ? "inward" : "outward"} from ${blip.previousRing}`}
    >
      <Icon size={12} aria-hidden="true" />
      {blip.previousRing} → {blip.ring}
    </span>
  );
}

// --- The chart -----------------------------------------------------------------------

interface ChartProps {
  points: BlipPoint[];
  size: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Admins drag a blip to another ring. */
  onDrop?: (blip: RadarBlip, ring: RadarRing) => void;
}

/** One blip: a dot, or a triangle pointing the way it moved recently. */
function BlipMark({
  point,
  centre,
  selected,
  dragging,
  draggable,
  onPointerDown,
  onClick,
  onHover,
}: Readonly<{
  point: BlipPoint;
  /** The chart's centre (its radius): the triangles point along the line to it. */
  centre: number;
  selected: boolean;
  dragging: boolean;
  draggable: boolean;
  onPointerDown: (e: ReactPointerEvent<SVGGElement>) => void;
  onClick: () => void;
  onHover: (hovering: boolean) => void;
}>) {
  const { blip, n, x, y } = point;
  const color = QUADRANT_COLORS[blip.quadrant];
  const movement = movementOf(blip);
  // The triangle's tip points along the radius: toward the centre when the
  // blip moved inward, away from it when it moved outward.
  const outward = (Math.atan2(y - centre, x - centre) * 180) / Math.PI;
  const rotate = movement === "in" ? outward + 180 : outward;
  const r = selected ? 12 : 10;
  return (
    <g
      transform={`translate(${x} ${y})`}
      className={`${draggable ? "cursor-grab" : "cursor-pointer"} ${dragging ? "opacity-70" : ""} focus:outline-none`}
      role="button"
      tabIndex={0}
      aria-label={`${n}. ${blip.name}, ${blip.quadrant}, ${blip.ring}${
        movement ? `, moved ${movement === "in" ? "inward" : "outward"}` : ""
      }`}
      onPointerDown={onPointerDown}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
      onFocus={() => onHover(true)}
      onBlur={() => onHover(false)}
    >
      {selected && <circle r={r + 6} fill={color} opacity={0.25} />}
      {movement ? (
        <polygon
          points={`${r + 2},0 ${-r * 0.7},${-r * 0.85} ${-r * 0.7},${r * 0.85}`}
          transform={`rotate(${rotate})`}
          fill={color}
          stroke="rgba(255,255,255,0.85)"
          strokeWidth={1.5}
        />
      ) : (
        <circle r={r} fill={color} stroke="rgba(255,255,255,0.85)" strokeWidth={1.5} />
      )}
      <text
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={10}
        fontWeight={700}
        fill="#0b1020"
        className="pointer-events-none select-none"
      >
        {n}
      </text>
    </g>
  );
}

function RadarChart({ points, size, selectedId, onSelect, onDrop }: Readonly<ChartProps>) {
  const radius = size / 2;
  const svgRef = useRef<SVGSVGElement>(null);
  const [hovered, setHovered] = useState<BlipPoint | null>(null);
  const [drag, setDrag] = useState<{
    point: BlipPoint;
    x: number;
    y: number;
    ring: RadarRing | null;
    moved: boolean;
  } | null>(null);

  /** Pointer → chart coordinates, whatever the rendered size. */
  const toChart = (e: { clientX: number; clientY: number }) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: ((e.clientX - rect.left) / rect.width) * size,
      y: ((e.clientY - rect.top) / rect.height) * size,
    };
  };

  const startDrag = (point: BlipPoint) => (e: ReactPointerEvent<SVGGElement>) => {
    if (!onDrop || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ point, x: point.x, y: point.y, ring: point.blip.ring, moved: false });
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag) return;
    const { x, y } = toChart(e);
    const ring = ringAt(x - radius, y - radius, radius);
    setDrag({
      ...drag,
      x,
      y,
      ring,
      moved: drag.moved || Math.hypot(x - drag.point.x, y - drag.point.y) > 4,
    });
  };
  const endDrag = () => {
    if (!drag) return;
    const { point, ring, moved } = drag;
    setDrag(null);
    if (moved && ring && ring !== point.blip.ring) onDrop?.(point.blip, ring);
  };

  const labelFor = (ring: RadarRing, i: number) => {
    const inner = i === 0 ? 0 : RING_EDGES[i - 1]! * radius;
    const outer = RING_EDGES[i]! * radius;
    return { x: radius + (inner + outer) / 2, ring };
  };

  return (
    <div className="relative mx-auto" style={{ width: size, maxWidth: "100%" }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${size} ${size}`}
        width="100%"
        role="img"
        aria-label="Technology radar: four quadrants and four rings"
        className="block touch-none select-none"
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={() => setDrag(null)}
        onClick={(e) => {
          if (e.target === e.currentTarget) onSelect(null);
        }}
      >
        <defs>
          <radialGradient id="radar-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#6ee7b7" stopOpacity={0.14} />
            <stop offset="60%" stopColor="#1e293b" stopOpacity={0.05} />
            <stop offset="100%" stopColor="#0b1020" stopOpacity={0} />
          </radialGradient>
        </defs>
        <circle cx={radius} cy={radius} r={radius} fill="url(#radar-glow)" />
        {/* Wedges: each quadrant's colour, fading outward; the ring being dragged over lights up. */}
        {RADAR_QUADRANTS.map((q) =>
          RADAR_RINGS.map((ring, i) => (
            <path
              key={`${q}-${ring}`}
              d={wedgePath(q, ring, radius)}
              fill={QUADRANT_COLORS[q]}
              opacity={drag && drag.ring === ring ? 0.3 : 0.16 - i * 0.03}
              className="transition-opacity"
            />
          )),
        )}
        {/* Ring edges and the axes. */}
        {RING_EDGES.map((edge) => (
          <circle
            key={edge}
            cx={radius}
            cy={radius}
            r={edge * radius}
            fill="none"
            stroke="rgba(255,255,255,0.18)"
            strokeWidth={1}
          />
        ))}
        <line x1={0} y1={radius} x2={size} y2={radius} stroke="rgba(255,255,255,0.22)" />
        <line x1={radius} y1={0} x2={radius} y2={size} stroke="rgba(255,255,255,0.22)" />
        {/* Ring names along the right half of the horizontal axis. */}
        {RADAR_RINGS.map((ring, i) => {
          const { x } = labelFor(ring, i);
          return (
            <text
              key={ring}
              x={x}
              y={radius - 5}
              textAnchor="middle"
              fontSize={11}
              fontWeight={600}
              fill="rgba(255,255,255,0.55)"
              className="pointer-events-none uppercase tracking-wider"
            >
              {ring}
            </text>
          );
        })}
        {RADAR_QUADRANTS.map((q) => {
          const p = quadrantLabelPosition(q, radius);
          return (
            <text
              key={q}
              x={p.x}
              y={p.y}
              textAnchor={p.anchor}
              fontSize={13}
              fontWeight={700}
              fill={QUADRANT_COLORS[q]}
              className="pointer-events-none"
            >
              {q}
            </text>
          );
        })}
        {points.map((point) =>
          drag?.moved && drag.point.blip.id === point.blip.id ? null : (
            <BlipMark
              key={point.blip.id}
              point={point}
              centre={radius}
              selected={point.blip.id === selectedId}
              dragging={false}
              draggable={!!onDrop}
              onPointerDown={startDrag(point)}
              onClick={() => onSelect(point.blip.id)}
              onHover={(h) => setHovered(h ? point : null)}
            />
          ),
        )}
        {drag?.moved && (
          <BlipMark
            point={{ ...drag.point, x: drag.x, y: drag.y }}
            centre={radius}
            selected
            dragging
            draggable
            onPointerDown={() => {}}
            onClick={() => {}}
            onHover={() => {}}
          />
        )}
      </svg>
      {hovered && !drag && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-10 w-64 rounded-xl border border-white/15 bg-[#1e2126] p-3 text-xs text-white shadow-xl shadow-black/50"
          style={{
            left: `${Math.min(92, Math.max(0, (hovered.x / size) * 100))}%`,
            top: `${(hovered.y / size) * 100}%`,
            transform: `translate(${hovered.x > size / 2 ? "-110%" : "12px"}, -50%)`,
          }}
        >
          <p className="flex items-center gap-1.5 font-semibold">
            <QuadrantDot quadrant={hovered.blip.quadrant} />
            {hovered.n}. {hovered.blip.name}
          </p>
          <p className="mt-1 flex items-center gap-2">
            <RingBadge ring={hovered.blip.ring} small />
            <Movement blip={hovered.blip} />
          </p>
          {hovered.blip.description && (
            <p className="mt-1.5 line-clamp-3 text-white/70">{hovered.blip.description}</p>
          )}
        </div>
      )}
      {drag && (
        <p className="pointer-events-none absolute inset-x-0 bottom-2 text-center text-xs text-white/70">
          Drop on a ring to move <b className="text-white">{drag.point.blip.name}</b>
          {drag.ring ? ` → ${drag.ring}` : ""}
        </p>
      )}
    </div>
  );
}

// --- The side panel -----------------------------------------------------------------

function BlipPanel({
  blip,
  admin,
  onClose,
  onMove,
  onEdit,
  onRemove,
}: Readonly<{
  blip: RadarBlip;
  admin: boolean;
  onClose: () => void;
  onMove: (ring: RadarRing) => void;
  onEdit: () => void;
  onRemove: () => void;
}>) {
  const nameOf = useNameOf();
  const by =
    blip.updatedBy === RADAR_AI_AUTHOR
      ? "the AI scan"
      : blip.updatedBy === "seed"
        ? "MindfulTech"
        : nameOf(blip.updatedBy);
  // The use case has its own section; the other facts stay in the list.
  const useCase = blip.meta?.useCase;
  const meta = Object.entries(blip.meta ?? {}).filter(([k]) => k !== "useCase");
  return (
    <aside
      className={`flex flex-col gap-4 rounded-2xl p-5 text-white ${GLASS}`}
      aria-label={`${blip.name} details`}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-xs uppercase tracking-wider text-white/60">
            <QuadrantDot quadrant={blip.quadrant} /> {blip.quadrant}
          </p>
          <h2 className="mt-1 truncate text-xl font-bold">{blip.name}</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-white/60 hover:bg-white/10 hover:text-white"
          aria-label="Close details"
        >
          <X size={18} />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <RingBadge ring={blip.ring} />
        <Movement blip={blip} />
      </div>
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-white/60">
          Why {blip.ring}
        </h3>
        <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-white/90">
          {blip.description || RING_MEANING[blip.ring]}
        </p>
        {blip.description && (
          <p className="mt-2 text-xs text-white/50">{RING_MEANING[blip.ring]}</p>
        )}
      </section>
      {useCase && (
        <section className="rounded-xl border border-white/10 bg-white/[0.05] px-3 py-2.5">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-emerald-300">
            Use case at MindfulTech
          </h3>
          <p className="mt-1 text-sm leading-relaxed text-white/90">{useCase}</p>
        </section>
      )}
      {blip.previousRing && blip.movedAt && (
        <p className="text-xs text-white/60">
          Moved from {blip.previousRing} to {blip.ring} on {when(blip.movedAt)}.
        </p>
      )}
      {(blip.link || meta.length > 0) && (
        <section className="space-y-1.5 text-sm">
          {blip.link && (
            <button
              type="button"
              onClick={() => openExternal(blip.link!)}
              className="inline-flex items-center gap-1 text-sky-300 hover:underline"
            >
              <ExternalLink size={14} aria-hidden="true" /> {new URL(blip.link).hostname}
            </button>
          )}
          {meta.length > 0 && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              {meta.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-white/50">{k}</dt>
                  <dd className="truncate font-mono text-white/85">{v}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      )}
      {blip.quadrant === "Models" && (
        // Phase 2 hook: LLM-Stats keys live statistics off `meta.modelId`.
        <p className={`rounded-xl px-3 py-2 text-xs text-white/60 ${GLASS}`}>
          <Sparkles size={12} className="mr-1 inline" aria-hidden="true" />
          LLM-Stats for this model arrive in the next phase
          {blip.meta?.modelId ? ` (keyed by ${blip.meta.modelId}).` : "."}
        </p>
      )}
      <p className="text-[11px] text-white/45">
        Updated {when(blip.updatedAt)} by {by}.
      </p>
      {admin && (
        <div className="space-y-2 border-t border-white/10 pt-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-white/60">Move to</p>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Move to ring">
            {RADAR_RINGS.map((ring) => (
              <button
                key={ring}
                type="button"
                disabled={ring === blip.ring}
                onClick={() => onMove(ring)}
                className={`rounded-full px-2.5 py-1 text-xs font-semibold ring-1 transition-colors disabled:opacity-40 ${RING_TONE[ring]} hover:brightness-125`}
              >
                {ring}
              </button>
            ))}
          </div>
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={onEdit}
              className="inline-flex items-center gap-1 rounded-lg border border-white/15 px-2.5 py-1.5 text-xs font-medium hover:bg-white/10"
            >
              <Pencil size={13} aria-hidden="true" /> Edit
            </button>
            <button
              type="button"
              onClick={onRemove}
              className="inline-flex items-center gap-1 rounded-lg border border-rose-300/30 px-2.5 py-1.5 text-xs font-medium text-rose-200 hover:bg-rose-400/10"
            >
              <Trash2 size={13} aria-hidden="true" /> Remove
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}

// --- The list view ------------------------------------------------------------------

function RadarList({
  blips,
  numbers,
  selectedId,
  admin,
  onSelect,
  onMove,
}: Readonly<{
  blips: RadarBlip[];
  numbers: Map<string, number>;
  selectedId: string | null;
  admin: boolean;
  onSelect: (id: string) => void;
  onMove: (blip: RadarBlip, ring: RadarRing) => void;
}>) {
  const groups = groupBlips(blips);
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {groups.map(({ quadrant, rings }) => (
        <section key={quadrant} className={`rounded-2xl p-4 text-white ${GLASS}`}>
          <h3
            className="flex items-center gap-2 text-sm font-bold"
            style={{ color: QUADRANT_COLORS[quadrant] }}
          >
            <QuadrantDot quadrant={quadrant} /> {quadrant}
          </h3>
          {rings.length === 0 && <p className="mt-2 text-xs text-white/50">Nothing here yet.</p>}
          {rings.map(({ ring, blips: list }) => (
            <div key={ring} className="mt-3">
              <p className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wider text-white/55">
                <RingBadge ring={ring} small /> {RING_MEANING[ring]}
              </p>
              <ul className="divide-y divide-white/5">
                {list.map((blip) => (
                  <li key={blip.id} className="flex items-center gap-2 py-1.5">
                    <button
                      type="button"
                      onClick={() => onSelect(blip.id)}
                      className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-0.5 text-left text-sm hover:bg-white/10 ${
                        selectedId === blip.id ? "bg-white/10" : ""
                      }`}
                      aria-current={selectedId === blip.id ? "true" : undefined}
                    >
                      <span className="w-6 shrink-0 text-right font-mono text-xs text-white/50">
                        {numbers.get(blip.id)}
                      </span>
                      <span className="truncate font-medium">{blip.name}</span>
                      <Movement blip={blip} />
                      {blip.description && (
                        <span className="hidden min-w-0 flex-1 truncate text-xs text-white/55 lg:inline">
                          — {blip.description}
                        </span>
                      )}
                    </button>
                    {admin && (
                      <select
                        aria-label={`Ring of ${blip.name}`}
                        value={blip.ring}
                        onChange={(e) => onMove(blip, e.target.value as RadarRing)}
                        className="rounded-md border border-white/15 bg-transparent px-1.5 py-0.5 text-xs text-white/80 [&>option]:text-black"
                      >
                        {RADAR_RINGS.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

// --- Proposals ------------------------------------------------------------------------

function ProposalsPanel({
  proposals,
  admin,
  onDecide,
  onClose,
}: Readonly<{
  proposals: RadarProposal[];
  admin: boolean;
  onDecide: (id: string, decision: "apply" | "dismiss") => void;
  onClose: () => void;
}>) {
  return (
    <aside
      className={`flex flex-col gap-3 rounded-2xl p-5 text-white ${GLASS}`}
      aria-label="Proposed updates"
    >
      <div className="flex items-center gap-2">
        <Sparkles size={16} className="text-amber-300" aria-hidden="true" />
        <h2 className="flex-1 text-base font-bold">Proposed by the AI scan</h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-white/60 hover:bg-white/10 hover:text-white"
          aria-label="Close proposals"
        >
          <X size={18} />
        </button>
      </div>
      {proposals.length === 0 && (
        <p className="text-sm text-white/60">
          Nothing pending. Every day the Discovery Engine reads the AI news and Hacker News, and the
          news scan reads the radar against the day&apos;s stories: what they find waits here for an
          admin.
        </p>
      )}
      <ul className="space-y-3">
        {proposals.map((p) => (
          <li key={p.id} className="rounded-xl border border-white/10 bg-black/20 p-3 text-sm">
            <p className="flex flex-wrap items-center gap-2 font-semibold">
              <QuadrantDot quadrant={p.quadrant} />
              {p.name}
              {p.kind === "move" && p.fromRing ? (
                <span className="flex items-center gap-1 text-xs font-normal text-white/70">
                  <RingBadge ring={p.fromRing} small /> → <RingBadge ring={p.ring} small />
                </span>
              ) : (
                <span className="flex items-center gap-1 text-xs font-normal text-white/70">
                  add to <RingBadge ring={p.ring} small />
                </span>
              )}
            </p>
            {p.kind === "add" && p.description && (
              <p className="mt-1 text-white/90">{p.description}</p>
            )}
            <p className="mt-1 text-white/70">
              {p.origin && (
                <span className="mr-1.5 rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white/70">
                  {p.origin === "discovery" ? "Discovery" : "News scan"}
                </span>
              )}
              {p.rationale}
            </p>
            {p.sourceLink && (
              <button
                type="button"
                onClick={() => openExternal(p.sourceLink!)}
                className="mt-1 inline-flex items-center gap-1 text-xs text-sky-300 hover:underline"
              >
                <ExternalLink size={12} aria-hidden="true" /> {p.sourceTitle ?? p.sourceLink}
              </button>
            )}
            {admin && (
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => onDecide(p.id, "apply")}
                  className="rounded-lg bg-emerald-400/20 px-2.5 py-1 text-xs font-semibold text-emerald-100 ring-1 ring-emerald-300/30 hover:bg-emerald-400/30"
                  aria-label={`Accept ${p.name}${p.kind === "add" ? ` into ${p.ring}` : ` → ${p.ring}`}`}
                >
                  Accept
                </button>
                <button
                  type="button"
                  onClick={() => onDecide(p.id, "dismiss")}
                  className="rounded-lg px-2.5 py-1 text-xs font-semibold text-white/70 ring-1 ring-white/15 hover:bg-white/10"
                  aria-label={`Reject ${p.name}`}
                >
                  Reject
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}

// --- The view -------------------------------------------------------------------------

export function RadarView({ onOpenSidebar }: Readonly<{ onOpenSidebar?: () => void }>) {
  const me = useChat((s) => s.me);
  const showToast = useChat((s) => s.showToast);
  const admin = me?.role === "admin";
  const configured = tasksApiConfigured();
  const {
    status,
    blips,
    proposals,
    lastScanAt,
    lastDiscoveryAt,
    error,
    selectedId,
    view,
    load,
    select,
    setView,
  } = useRadar();
  const move = useRadar((s) => s.move);
  const remove = useRadar((s) => s.remove);
  const decide = useRadar((s) => s.decide);
  const scan = useRadar((s) => s.scan);
  const [modal, setModal] = useState<"add" | { edit: RadarBlip } | null>(null);
  const [showProposals, setShowProposals] = useState(false);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    document.title = "AI Radar · MindfulTech";
    if (configured) void load();
  }, [configured, load]);

  // The chart takes the width it's given, up to CHART_MAX.
  const frame = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(CHART_MIN);
  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    const fit = () => setSize(Math.max(CHART_MIN, Math.min(CHART_MAX, el.clientWidth)));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [view]);

  // The frame's padding (p-3 / sm:p-5) comes off the width the chart is drawn at.
  const chartSize = size - 40;
  const points = useMemo(() => layoutBlips(blips, chartSize), [blips, chartSize]);
  const numbers = useMemo(() => new Map(points.map((p) => [p.blip.id, p.n])), [points]);
  const selected = blips.find((b) => b.id === selectedId) ?? null;

  const moveBlip = useCallback(
    (blip: RadarBlip, ring: RadarRing) => {
      move(blip.id, ring).then(
        () => showToast(`${blip.name} → ${ring}`, "success"),
        (err: unknown) => showToast(errorText(err, "Couldn't move it."), "error"),
      );
    },
    [move, showToast],
  );

  async function removeSelected(blip: RadarBlip) {
    if (!window.confirm(`Remove “${blip.name}” from the radar?`)) return;
    try {
      await remove(blip.id);
    } catch (err) {
      showToast(errorText(err, "Couldn't remove it."), "error");
    }
  }

  async function decideProposal(id: string, decision: "apply" | "dismiss") {
    try {
      await decide(id, decision);
    } catch (err) {
      showToast(errorText(err, "Couldn't do that."), "error");
    }
  }

  async function scanNow() {
    setScanning(true);
    try {
      await scan();
      showToast(
        "Scanning the AI news and Hacker News… new proposals show up in a minute or two.",
        "success",
      );
    } catch (err) {
      showToast(errorText(err, "Couldn't start the scan."), "error");
    } finally {
      setScanning(false);
    }
  }

  const menu = onOpenSidebar && (
    <button
      type="button"
      onClick={onOpenSidebar}
      className="relative rounded-md p-2 text-white/70 hover:bg-white/10 hover:text-white md:hidden"
      aria-label="Open menu"
    >
      <MenuIcon />
      <UnreadAlertsDot />
    </button>
  );

  const panel = selected ? (
    <BlipPanel
      blip={selected}
      admin={!!admin}
      onClose={() => select(null)}
      onMove={(ring) => moveBlip(selected, ring)}
      onEdit={() => setModal({ edit: selected })}
      onRemove={() => void removeSelected(selected)}
    />
  ) : showProposals ? (
    <ProposalsPanel
      proposals={proposals}
      admin={!!admin}
      onDecide={(id, d) => void decideProposal(id, d)}
      onClose={() => setShowProposals(false)}
    />
  ) : null;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[radial-gradient(ellipse_at_top,#1e1b4b_0%,#0b1020_45%,#05070f_100%)] text-white">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-white/10 px-3 sm:px-4">
        {menu}
        <RadarIcon size={20} className="text-emerald-300" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-semibold leading-tight">AI Radar</h1>
          <p className="truncate text-[11px] leading-tight text-white/50">
            {lastScanAt || lastDiscoveryAt
              ? `Last AI scan ${when(Math.max(lastScanAt ?? 0, lastDiscoveryAt ?? 0))}`
              : "Our stance on the AI & engineering stack"}
          </p>
        </div>
        <div
          className="flex items-center rounded-lg border border-white/15 p-0.5"
          role="group"
          aria-label="View"
        >
          <button
            type="button"
            onClick={() => setView("radar")}
            aria-pressed={view === "radar"}
            className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium ${
              view === "radar" ? "bg-white/15" : "text-white/60 hover:text-white"
            }`}
          >
            <RadarIcon size={14} aria-hidden="true" />{" "}
            <span className="hidden sm:inline">Radar</span>
          </button>
          <button
            type="button"
            onClick={() => setView("list")}
            aria-pressed={view === "list"}
            className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium ${
              view === "list" ? "bg-white/15" : "text-white/60 hover:text-white"
            }`}
          >
            <ListIcon size={14} aria-hidden="true" /> <span className="hidden sm:inline">List</span>
          </button>
        </div>
        <button
          type="button"
          onClick={() => {
            select(null);
            setShowProposals((v) => !v);
          }}
          className="relative inline-flex items-center gap-1 rounded-lg border border-white/15 px-2 py-1 text-xs font-medium hover:bg-white/10"
          aria-label={`Proposed updates (${proposals.length} pending)`}
        >
          <Sparkles size={14} className="text-amber-300" aria-hidden="true" />
          <span className="hidden sm:inline">Proposals</span>
          {proposals.length > 0 && (
            <span className="rounded-full bg-amber-400 px-1.5 text-[10px] font-bold text-black">
              {proposals.length}
            </span>
          )}
        </button>
        {admin && (
          <>
            <button
              type="button"
              onClick={() => void scanNow()}
              disabled={scanning}
              className="inline-flex items-center gap-1 rounded-lg border border-white/15 px-2 py-1 text-xs font-medium hover:bg-white/10 disabled:opacity-50"
              title="Ask the AI to scan today's news for updates"
            >
              <RefreshCw size={14} className={scanning ? "animate-spin" : ""} aria-hidden="true" />
              <span className="hidden sm:inline">Scan now</span>
            </button>
            <button
              type="button"
              onClick={() => setModal("add")}
              className="inline-flex items-center gap-1 rounded-lg bg-emerald-400 px-2.5 py-1 text-xs font-semibold text-black hover:bg-emerald-300"
            >
              <Plus size={14} aria-hidden="true" /> Add
            </button>
          </>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-5">
        {!configured ? (
          <p className="text-sm text-white/70">
            The radar needs the HTTP API, which this deployment doesn't have.
          </p>
        ) : status === "error" ? (
          <p role="alert" className="text-sm text-rose-200">
            {error}
          </p>
        ) : (
          <div className="mx-auto grid max-w-6xl gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
            <div ref={frame} className="min-w-0">
              {status === "loading" && blips.length === 0 ? (
                <div
                  className={`mx-auto aspect-square w-full max-w-[720px] animate-pulse rounded-full ${GLASS}`}
                  aria-busy="true"
                />
              ) : view === "radar" ? (
                <div className={`rounded-3xl p-3 sm:p-5 ${GLASS}`}>
                  <RadarChart
                    points={points}
                    size={chartSize}
                    selectedId={selectedId}
                    onSelect={select}
                    onDrop={admin ? moveBlip : undefined}
                  />
                  <p className="mt-3 text-center text-[11px] text-white/45">
                    A triangle moved recently: pointing to the centre = inward, away = outward ·
                    hover or tap a blip for our stance
                    {admin ? " · drag a blip to another ring to move it" : ""}
                  </p>
                  {blips.length === 0 && status === "ready" && (
                    <p className="mt-4 text-center text-sm text-white/70">
                      The radar is empty.{" "}
                      {admin ? "Add a technology or run a scan." : "An admin will populate it."}
                    </p>
                  )}
                </div>
              ) : (
                <RadarList
                  blips={blips}
                  numbers={numbers}
                  selectedId={selectedId}
                  admin={!!admin}
                  onSelect={select}
                  onMove={moveBlip}
                />
              )}
            </div>
            <div className="lg:sticky lg:top-0 lg:self-start">
              {panel ?? (
                <div className={`hidden rounded-2xl p-5 text-sm text-white/60 lg:block ${GLASS}`}>
                  <p className="font-semibold text-white/80">Reading the radar</p>
                  <ul className="mt-2 space-y-1.5">
                    {RADAR_RINGS.map((ring) => (
                      <li key={ring} className="flex gap-2">
                        <RingBadge ring={ring} small />
                        <span>{RING_MEANING[ring]}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-3 text-xs text-white/50">
                    Every day the Discovery Engine (the AI news and Hacker News) and the news scan
                    propose new technologies for Assess and moves between rings; an admin accepts or
                    rejects them under Proposals.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {modal && (
        <BlipModal
          blip={modal === "add" ? undefined : modal.edit}
          onClose={() => setModal(null)}
          onSaved={(blip) => {
            setModal(null);
            select(blip.id);
          }}
        />
      )}
    </div>
  );
}

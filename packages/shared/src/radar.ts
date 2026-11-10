import { z } from "zod";

// ---------------------------------------------------------------------------
// AI Tech Radar (Phase 56). A ThoughtWorks-style radar for the AI and software
// engineering stack: four quadrants, four rings, one "blip" per technology
// with the team's stance. Blips move between rings over time (`previousRing`
// / `movedAt` keep the last move so the chart can show it), and a daily scan
// of the AI news asks Claude Haiku 5.5 to propose updates: brand-new
// technologies enter `Assess` on their own; ring moves wait for a person.
//
// Phase 2 (LLM-Stats) will key live model statistics off `meta.modelId` of the
// blips in the `Models` quadrant, which is why `meta` is a free string map.
// ---------------------------------------------------------------------------

export const RADAR_QUADRANTS = ["Models", "Frameworks", "Infrastructure", "DevTools"] as const;
export type RadarQuadrant = (typeof RADAR_QUADRANTS)[number];

/** Innermost first: the order is the distance from the centre. */
export const RADAR_RINGS = ["Adopt", "Trial", "Assess", "Hold"] as const;
export type RadarRing = (typeof RADAR_RINGS)[number];

export const RING_MEANING: Record<RadarRing, string> = {
  Adopt: "Proven on our projects: the default choice for new work.",
  Trial: "Worth pursuing: used on at least one real project, with care.",
  Assess: "Worth exploring to understand how it would affect us.",
  Hold: "Proceed with caution; don't start anything new with it.",
};

export const MAX_BLIP_NAME = 60;
export const MAX_BLIP_DESCRIPTION = 600;
export const MAX_BLIP_LINK = 500;
export const MAX_BLIP_META_ENTRIES = 12;
export const MAX_BLIPS = 200;

/** A move within this window is still drawn as "recent" (the triangle). */
export const RADAR_RECENT_MOVE_MS = 45 * 24 * 60 * 60 * 1000;

/** Who changed a blip last: a person's user id, or the scanner. */
export const RADAR_AI_AUTHOR = "ai";

export interface RadarBlip {
  id: string;
  name: string;
  quadrant: RadarQuadrant;
  ring: RadarRing;
  /** The team's stance: why it sits in this ring (shown on hover/click). */
  description: string;
  /** Where it was before the last move; `null` until it moves. */
  previousRing: RadarRing | null;
  /** Epoch ms of the last ring change; absent until it moves. */
  movedAt?: number;
  /** Homepage or docs (https). */
  link?: string;
  /** Free key→value facts (Phase 2 reads `modelId`, `provider`… on Models). */
  meta?: Record<string, string>;
  /** Epoch ms. */
  createdAt: number;
  updatedAt: number;
  /** User id, or `RADAR_AI_AUTHOR`. */
  updatedBy: string;
}

/** Moved inward (toward Adopt), outward, or not recently: what the chart draws. */
export type RadarMovement = "in" | "out" | null;

export function ringIndex(ring: RadarRing): number {
  return RADAR_RINGS.indexOf(ring);
}

/** `in` when the last move went toward the centre and is recent enough to show. */
export function movementOf(
  blip: Pick<RadarBlip, "ring" | "previousRing" | "movedAt">,
  now = Date.now(),
): RadarMovement {
  if (!blip.previousRing || blip.previousRing === blip.ring) return null;
  if (blip.movedAt !== undefined && now - blip.movedAt > RADAR_RECENT_MOVE_MS) return null;
  return ringIndex(blip.ring) < ringIndex(blip.previousRing) ? "in" : "out";
}

// --- Proposals (the scanner's suggestions, applied by a person) -------------------

export type ProposalKind = "add" | "move";
/**
 * `pending`: waiting for an admin (the Proposals panel lists only these);
 * `applied`: accepted; `dismissed`: rejected. Resolved rows are kept a month
 * so the scans don't propose a rejected technology again the next morning.
 */
export type ProposalStatus = "pending" | "applied" | "dismissed";

/**
 * Who proposed it: the morning scan of the AI news (`news-scan`, Phase 56)
 * or the Discovery Engine (`discovery`, Phase 60: the stored AI news plus
 * Hacker News' top stories). Absent on proposals from before Phase 60.
 */
export const RADAR_PROPOSAL_ORIGINS = ["news-scan", "discovery"] as const;
export type ProposalOrigin = (typeof RADAR_PROPOSAL_ORIGINS)[number];

export interface RadarProposal {
  id: string;
  kind: ProposalKind;
  /** The blip a `move` is about. */
  blipId?: string;
  name: string;
  quadrant: RadarQuadrant;
  ring: RadarRing;
  /** For a move: the ring it is in now. */
  fromRing?: RadarRing;
  /** Why, in a sentence or two, and the story it came from. */
  rationale: string;
  sourceTitle?: string;
  sourceLink?: string;
  /** A suggested description for a new blip. */
  description?: string;
  /** For an add: facts the new blip starts with (`modelId` for a model). */
  meta?: Record<string, string>;
  origin?: ProposalOrigin;
  status: ProposalStatus;
  createdAt: number;
  /** Who applied or dismissed it, and when. */
  resolvedBy?: string;
  resolvedAt?: number;
}

// --- Schemas ------------------------------------------------------------------

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((v) => !/[^\P{Cc}\n]/u.test(v), "no control characters");

const link = z
  .string()
  .trim()
  .max(MAX_BLIP_LINK)
  .refine((v) => v === "" || /^https:\/\/[^\s]+$/.test(v), "link must be an https URL");

const meta = z
  .record(z.string().trim().min(1).max(40), z.string().trim().max(200))
  .refine((m) => Object.keys(m).length <= MAX_BLIP_META_ENTRIES, "too many entries");

export const CreateBlipSchema = z.object({
  name: text(MAX_BLIP_NAME).pipe(z.string().min(1)),
  quadrant: z.enum(RADAR_QUADRANTS),
  ring: z.enum(RADAR_RINGS),
  description: text(MAX_BLIP_DESCRIPTION).default(""),
  link: link.optional(),
  meta: meta.optional(),
});
export type CreateBlipInput = z.input<typeof CreateBlipSchema>;

/** Partial update; a new `ring` records the move (`previousRing`, `movedAt`). */
export const UpdateBlipSchema = z
  .object({
    name: text(MAX_BLIP_NAME).pipe(z.string().min(1)).optional(),
    quadrant: z.enum(RADAR_QUADRANTS).optional(),
    ring: z.enum(RADAR_RINGS).optional(),
    description: text(MAX_BLIP_DESCRIPTION).optional(),
    link: link.optional(),
    meta: meta.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), "nothing to update");
export type UpdateBlipInput = z.infer<typeof UpdateBlipSchema>;

/** `GET /radar`. */
export interface RadarSnapshot {
  blips: RadarBlip[];
  /** Pending proposals (admins act on them; everyone may read them). */
  proposals: RadarProposal[];
  /** Epoch ms of the last scan that ran, if any. */
  lastScanAt: number | null;
  /** Epoch ms of the Discovery Engine's last run (Phase 60), if any. */
  lastDiscoveryAt: number | null;
}

/** Same technology spelled differently ("LangChain" / "langchain"): one key. */
export function blipKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "");
}

/** Words that tell versions or packagings of one technology apart, not two technologies. */
const VERSION_WORD = /^(v?\d+([.-]\d+)*[a-z]?|\d+[bkm]|latest|preview|beta|alpha|rc\d*|new)$/;
const PACKAGING_SUFFIX = /(js|ts|py|io|ai|sdk|api|app|dev|cli|hq)$/;

/**
 * The name without versions and packaging: "Claude Opus 5.5" and "Claude
 * Opus" → "claudeopus"; "Next.js" and "Nextjs" → "next"; "LangChain v1.0" →
 * "langchain". `""` when nothing is left.
 */
export function techCoreKey(name: string): string {
  const words = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9.]+|(?<=[a-z])\.(?=[a-z])/)
    .map((w) => w.replace(/^\.+|\.+$/g, ""))
    .filter((w) => w && !VERSION_WORD.test(w));
  const core = words.join("").replace(/\./g, "");
  const stripped = core.replace(PACKAGING_SUFFIX, "");
  return stripped.length >= 3 ? stripped : core;
}

/** Edit distance, stopping early once it passes `max` (names are short). */
function withinEdits(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + cost);
      best = Math.min(best, row[j]!);
    }
    if (best > max) return false;
    previous = row;
  }
  return previous[b.length]! <= max;
}

/**
 * The same technology, spelled or versioned differently: equal `blipKey`s,
 * equal `techCoreKey`s ("GPT-6" / "GPT 6 Turbo" stay apart: "gpt" + "turbo"),
 * or one typo apart in names of six letters or more ("Langchan").
 */
export function similarTechNames(a: string, b: string): boolean {
  const [ka, kb] = [blipKey(a), blipKey(b)];
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const [ca, cb] = [techCoreKey(a), techCoreKey(b)];
  if (ca && ca === cb) return true;
  return ca.length >= 6 && cb.length >= 6 && withinEdits(ca, cb, 1);
}

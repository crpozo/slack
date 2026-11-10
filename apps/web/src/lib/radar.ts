import {
  RADAR_QUADRANTS,
  RADAR_RINGS,
  ringIndex,
  type RadarBlip,
  type RadarQuadrant,
  type RadarRing,
} from "@mindfultech/shared";

/**
 * Radar geometry (Phase 56). The chart is a square `size` px wide, centred at
 * (size/2, size/2). Each quadrant owns a 90° wedge, each ring a band of
 * radius; a blip is placed inside its wedge ∩ band at a spot derived from its
 * id (stable between renders) and nudged until it no longer overlaps another
 * blip. Everything here is pure, so it's unit-tested without a DOM.
 */

/** Where each quadrant sits, as the wedge's start angle in degrees (0° = east, clockwise on screen). */
export const QUADRANT_START_DEG: Record<RadarQuadrant, number> = {
  Models: 180, // top-left
  Frameworks: 270, // top-right
  Infrastructure: 90, // bottom-left
  DevTools: 0, // bottom-right
};

/** Accent per quadrant (the dots and the list headings). */
export const QUADRANT_COLORS: Record<RadarQuadrant, string> = {
  Models: "#8B5CF6",
  Frameworks: "#22D3EE",
  Infrastructure: "#F59E0B",
  DevTools: "#34D399",
};

/** Outer edge of each ring as a fraction of the radius, Adopt first. */
export const RING_EDGES = [0.34, 0.58, 0.8, 1] as const;

/** Gap between a blip and the wedge's edges / the ring's edges, in px at the default size. */
const BLIP_RADIUS = 10;
const EDGE_PADDING = 14;

export interface BlipPoint {
  blip: RadarBlip;
  /** 1-based label, in list order (by quadrant, ring, name). */
  n: number;
  x: number;
  y: number;
}

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** The inner and outer radius of `ring` for a chart of `radius`. */
export function ringBand(ring: RadarRing, radius: number): [number, number] {
  const i = ringIndex(ring);
  const inner = i === 0 ? 0 : RING_EDGES[i - 1]! * radius;
  return [inner, RING_EDGES[i]! * radius];
}

/** Deterministic 0…1 numbers from a string (so a blip stays put between renders). */
export function hashUnit(seed: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10_000) / 10_000;
}

/**
 * A point inside `blip`'s wedge ∩ band. Attempt 0 is the blip's own spot (from
 * its id); later attempts walk the sector on a golden-angle spiral, so a
 * crowded sector is searched evenly rather than at random.
 */
function candidate(blip: RadarBlip, radius: number, attempt: number): { x: number; y: number } {
  const [inner, outer] = ringBand(blip.ring, radius);
  const pad = Math.min(EDGE_PADDING, (outer - inner) / 3);
  const rMin = inner + pad;
  const rMax = outer - pad;
  const u = attempt === 0 ? hashUnit(blip.id, 1) : (hashUnit(blip.id, 1) + attempt * 0.381966) % 1;
  const v = attempt === 0 ? hashUnit(blip.id, 2) : (hashUnit(blip.id, 2) + attempt * 0.618034) % 1;
  // Area-uniform in r (sqrt), so the outer, wider part of the band gets its share.
  const r = Math.sqrt(rMin * rMin + (rMax * rMax - rMin * rMin) * u);
  // Keep the blip clear of the quadrant's edges: the angular margin a padded radius allows.
  const margin = Math.min(25, (Math.asin(Math.min(1, pad / Math.max(r, 1))) * 180) / Math.PI + 4);
  const start = QUADRANT_START_DEG[blip.quadrant] + margin;
  const span = 90 - 2 * margin;
  const deg = start + span * v;
  return { x: r * Math.cos(toRad(deg)), y: r * Math.sin(toRad(deg)) };
}

/** Blips sorted the way the list shows them: quadrant, ring, name. */
export function sortBlips(blips: RadarBlip[]): RadarBlip[] {
  return [...blips].sort(
    (a, b) =>
      RADAR_QUADRANTS.indexOf(a.quadrant) - RADAR_QUADRANTS.indexOf(b.quadrant) ||
      ringIndex(a.ring) - ringIndex(b.ring) ||
      a.name.localeCompare(b.name),
  );
}

/** Positions for every blip of a `size`×`size` chart (centre at size/2), overlaps resolved. */
export function layoutBlips(blips: RadarBlip[], size: number): BlipPoint[] {
  const radius = size / 2;
  const placed: BlipPoint[] = [];
  const minGap = BLIP_RADIUS * 2.2;
  sortBlips(blips).forEach((blip, index) => {
    // The first clear spot, else the one farthest from its nearest neighbour.
    let best = candidate(blip, radius, 0);
    let bestGap = -1;
    for (let attempt = 0; attempt < 80; attempt++) {
      const c = candidate(blip, radius, attempt);
      const gap = Math.min(
        Infinity,
        ...placed.map((p) => Math.hypot(p.x - radius - c.x, p.y - radius - c.y)),
      );
      if (gap > bestGap) {
        best = c;
        bestGap = gap;
      }
      if (gap >= minGap) break;
    }
    placed.push({ blip, n: index + 1, x: radius + best.x, y: radius + best.y });
  });
  return placed;
}

/** The ring under a chart point (centre-relative), or `null` outside the radar. */
export function ringAt(dx: number, dy: number, radius: number): RadarRing | null {
  const r = Math.hypot(dx, dy) / radius;
  if (r > 1) return null;
  const i = RING_EDGES.findIndex((edge) => r <= edge);
  return i === -1 ? null : RADAR_RINGS[i]!;
}

/** The quadrant under a chart point (centre-relative). */
export function quadrantAt(dx: number, dy: number): RadarQuadrant {
  const deg = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
  for (const q of RADAR_QUADRANTS) {
    const start = QUADRANT_START_DEG[q];
    if (deg >= start && deg < start + 90) return q;
  }
  return "DevTools";
}

/** SVG path of a ring's band inside one quadrant (for the coloured wedges). */
export function wedgePath(quadrant: RadarQuadrant, ring: RadarRing, radius: number): string {
  const [inner, outer] = ringBand(ring, radius);
  const a0 = toRad(QUADRANT_START_DEG[quadrant]);
  const a1 = toRad(QUADRANT_START_DEG[quadrant] + 90);
  const p = (r: number, a: number) =>
    `${(radius + r * Math.cos(a)).toFixed(2)} ${(radius + r * Math.sin(a)).toFixed(2)}`;
  if (inner === 0) {
    return `M ${radius} ${radius} L ${p(outer, a0)} A ${outer} ${outer} 0 0 1 ${p(outer, a1)} Z`;
  }
  return (
    `M ${p(inner, a0)} L ${p(outer, a0)} A ${outer} ${outer} 0 0 1 ${p(outer, a1)} ` +
    `L ${p(inner, a1)} A ${inner} ${inner} 0 0 0 ${p(inner, a0)} Z`
  );
}

/** Where to write a quadrant's name: just inside its outer corner. */
export function quadrantLabelPosition(
  quadrant: RadarQuadrant,
  radius: number,
): { x: number; y: number; anchor: "start" | "end" } {
  const start = QUADRANT_START_DEG[quadrant];
  const left = start === 180 || start === 90;
  const top = start === 180 || start === 270;
  return {
    x: left ? 8 : 2 * radius - 8,
    y: top ? 18 : 2 * radius - 10,
    anchor: left ? "start" : "end",
  };
}

/** Blips grouped for the list view: quadrant → ring → blips (in name order). */
export function groupBlips(blips: RadarBlip[]): Array<{
  quadrant: RadarQuadrant;
  rings: Array<{ ring: RadarRing; blips: RadarBlip[] }>;
}> {
  const sorted = sortBlips(blips);
  return RADAR_QUADRANTS.map((quadrant) => ({
    quadrant,
    rings: RADAR_RINGS.map((ring) => ({
      ring,
      blips: sorted.filter((b) => b.quadrant === quadrant && b.ring === ring),
    })).filter((g) => g.blips.length > 0),
  }));
}

import { movementOf, RADAR_RINGS, type RadarBlip } from "@mindfultech/shared";
import { describe, expect, it } from "vitest";
import {
  groupBlips,
  layoutBlips,
  QUADRANT_START_DEG,
  quadrantAt,
  ringAt,
  ringBand,
  wedgePath,
} from "./radar";

const blip = (
  id: string,
  quadrant: RadarBlip["quadrant"],
  ring: RadarBlip["ring"],
  extra: Partial<RadarBlip> = {},
): RadarBlip => ({
  id,
  name: id,
  quadrant,
  ring,
  description: "",
  previousRing: null,
  createdAt: 1,
  updatedAt: 1,
  updatedBy: "u",
  ...extra,
});

describe("radar geometry", () => {
  it("places every blip inside its own quadrant and ring, never overlapping another", () => {
    // Six per sector in two quadrants (a real radar has fewer per sector).
    const many: RadarBlip[] = [];
    for (let i = 0; i < 24; i++) {
      many.push(blip(`b${i}`, "Models", RADAR_RINGS[i % 4]!));
      many.push(blip(`c${i}`, "DevTools", RADAR_RINGS[(i + 1) % 4]!));
    }
    const size = 600;
    const points = layoutBlips(many, size);
    expect(points).toHaveLength(many.length);
    for (const p of points) {
      const dx = p.x - size / 2;
      const dy = p.y - size / 2;
      expect(ringAt(dx, dy, size / 2), p.blip.id).toBe(p.blip.ring);
      expect(quadrantAt(dx, dy), p.blip.id).toBe(p.blip.quadrant);
    }
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const a = points[i]!;
        const b = points[j]!;
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(16);
      }
    }
    // Numbered in list order and stable between renders.
    expect(points.map((p) => p.n)).toEqual(points.map((_, i) => i + 1));
    expect(layoutBlips(many, size).map((p) => [p.x, p.y])).toEqual(points.map((p) => [p.x, p.y]));
  });

  it("maps points back to rings and quadrants, and nothing outside the circle", () => {
    const r = 100;
    expect(ringAt(10, 0, r)).toBe("Adopt");
    expect(ringAt(0, -50, r)).toBe("Trial");
    expect(ringAt(70, 0, r)).toBe("Assess");
    expect(ringAt(0, 95, r)).toBe("Hold");
    expect(ringAt(90, 90, r)).toBeNull();
    expect(quadrantAt(-10, -10)).toBe("Models"); // top-left
    expect(quadrantAt(10, -10)).toBe("Frameworks"); // top-right
    expect(quadrantAt(-10, 10)).toBe("Infrastructure"); // bottom-left
    expect(quadrantAt(10, 10)).toBe("DevTools"); // bottom-right
    expect(Object.values(QUADRANT_START_DEG).sort((a, b) => a - b)).toEqual([0, 90, 180, 270]);
  });

  it("rings are contiguous bands from the centre to the edge", () => {
    let last = 0;
    for (const ring of RADAR_RINGS) {
      const [inner, outer] = ringBand(ring, 100);
      expect(inner).toBe(last);
      expect(outer).toBeGreaterThan(inner);
      last = outer;
    }
    expect(last).toBe(100);
    expect(wedgePath("Models", "Adopt", 100)).toMatch(/^M 100 100 L .* Z$/);
    expect(wedgePath("Models", "Hold", 100)).toMatch(/A 100 100 0 0 1 .* A 80 80 0 0 0/);
  });

  it("groups the list by quadrant then ring, and tells recent moves apart", () => {
    const now = Date.now();
    const list = [
      blip("a", "DevTools", "Adopt", { previousRing: "Trial", movedAt: now - 1000 }),
      blip("b", "DevTools", "Hold", { previousRing: "Assess", movedAt: now - 1000 }),
      blip("c", "Models", "Assess", { previousRing: "Trial", movedAt: now - 400 * 86_400_000 }),
    ];
    const groups = groupBlips(list);
    expect(groups.map((g) => g.quadrant)).toEqual([
      "Models",
      "Frameworks",
      "Infrastructure",
      "DevTools",
    ]);
    expect(groups[3]!.rings.map((r) => [r.ring, r.blips.map((b) => b.id)])).toEqual([
      ["Adopt", ["a"]],
      ["Hold", ["b"]],
    ]);
    expect(movementOf(list[0]!, now)).toBe("in");
    expect(movementOf(list[1]!, now)).toBe("out");
    expect(movementOf(list[2]!, now)).toBeNull(); // too long ago
  });
});

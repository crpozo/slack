import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { blipKey, CreateBlipSchema, RADAR_QUADRANTS, similarTechNames } from "@mindfultech/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { listBlips } from "../src/lib/radar";
import { seedRadarOnce, starterBlips } from "../src/lib/radarSeed";
import { ddbMock, resetMocks } from "./helpers";

// Phase 61: an empty radar starts with the team's stack, once.

process.env.TECH_RADAR_TABLE ??= "slack-test-tech-radar";

describe("the radar's starter blips", () => {
  it("are valid, cover every quadrant and every ring, and don't repeat a technology", () => {
    const blips = starterBlips();
    for (const b of blips) expect(CreateBlipSchema.safeParse(b).success, b.name).toBe(true);
    for (const q of RADAR_QUADRANTS) {
      expect(blips.filter((b) => b.quadrant === q).length).toBeGreaterThanOrEqual(8);
    }
    expect(new Set(blips.map((b) => b.ring))).toEqual(
      new Set(["Adopt", "Trial", "Assess", "Hold"]),
    );
    expect(new Set(blips.map((b) => blipKey(b.name))).size).toBe(blips.length);
    // No two the scans would take for the same technology.
    for (let i = 0; i < blips.length; i++) {
      for (let j = i + 1; j < blips.length; j++) {
        expect(
          similarTechNames(blips[i]!.name, blips[j]!.name),
          `${blips[i]!.name} / ${blips[j]!.name}`,
        ).toBe(false);
      }
    }
  });
});

describe("seeding", () => {
  let table: Map<string, Record<string, unknown>>;
  beforeEach(() => {
    resetMocks();
    table = new Map();
    ddbMock.on(PutCommand).callsFake((input) => {
      const item = input.Item as { pk: string; id: string };
      const key = `${item.pk}|${item.id}`;
      if (input.ConditionExpression && table.has(key)) {
        throw new ConditionalCheckFailedException({ message: "exists", $metadata: {} });
      }
      table.set(key, item);
      return {};
    });
    ddbMock.on(GetCommand).callsFake((input) => ({
      Item: table.get(`${input.Key?.pk}|${input.Key?.id}`),
    }));
    ddbMock.on(DeleteCommand).callsFake((input) => {
      table.delete(`${input.Key?.pk}|${input.Key?.id}`);
      return {};
    });
    ddbMock.on(QueryCommand).callsFake((input) => ({
      Items: [...table.values()].filter((r) => r.pk === input.ExpressionAttributeValues?.[":pk"]),
    }));
  });

  it("fills the radar once; never again, even after it's emptied", async () => {
    expect(await seedRadarOnce(1)).toBe(true);
    const blips = await listBlips();
    expect(blips).toHaveLength(starterBlips().length);
    expect(blips.find((b) => b.name === "Claude Haiku 5.5")).toMatchObject({
      quadrant: "Models",
      ring: "Adopt",
      updatedBy: "seed",
      meta: { modelId: "claude-haiku-5-5" },
    });
    for (const key of [...table.keys()]) if (key.startsWith("BLIP|")) table.delete(key);
    expect(await seedRadarOnce(2)).toBe(false);
    expect(await listBlips()).toEqual([]);
  });

  it("a newer list replaces the starters nobody touched, and keeps what people added or edited", async () => {
    const row = (id: string, name: string, updatedBy: string) =>
      table.set(`BLIP|${id}`, {
        pk: "BLIP",
        id,
        name,
        quadrant: "Frameworks",
        ring: "Adopt",
        description: "",
        previousRing: null,
        createdAt: 1,
        updatedAt: 1,
        updatedBy,
      });
    table.set("SCAN|seeded", { pk: "SCAN", id: "seeded", at: 1 }); // the first list was written
    row("vite", "Vite", "seed");
    row("react", "React", "u-ana"); // someone edited this one
    row("our-thing", "Our thing", "u-ana");
    expect(await seedRadarOnce(5)).toBe(true);
    const names = (await listBlips()).map((b) => b.name);
    expect(names).not.toContain("Vite");
    expect(names).toEqual(expect.arrayContaining(["React", "Our thing", "Claude Code"]));
    expect(names).toHaveLength(starterBlips().length + 2);
  });
});

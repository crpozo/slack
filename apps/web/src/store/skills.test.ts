import type { Skill } from "@mindfultech/shared";
import { describe, expect, it, vi } from "vitest";
import type { SkillsApi } from "../lib/skillsApi";
import { createSkillsStore } from "./skills";

const full = (id: string, name: string): Skill => ({
  id,
  slug: name,
  name,
  description: "d",
  sourceType: "team",
  category: "Workflow",
  skillMd: "---\nname: x\n---\n",
  files: [{ path: "a.md", content: "héllo" }],
  authorId: "u1",
  authorName: "Ana",
  createdAt: 1,
  updatedAt: 1,
});

describe("the skills store", () => {
  it("loads the list once (again when forced) and keeps the error beside what it has", async () => {
    const list = vi.fn(async () => [{ ...full("a", "alpha"), files: [] }]);
    const store = createSkillsStore({ list } as unknown as SkillsApi);
    await store.getState().load();
    await store.getState().load();
    expect(list).toHaveBeenCalledTimes(1);
    expect(store.getState()).toMatchObject({ status: "ready", skills: [{ id: "a" }] });
    list.mockRejectedValueOnce(new Error("offline"));
    await store.getState().load(true);
    expect(store.getState()).toMatchObject({
      status: "ready",
      error: "offline",
      skills: [{ id: "a" }],
    });
  });

  it("caches each skill's contents, and keeps the list in step with saves and deletions", async () => {
    const get = vi.fn(async (id: string) => full(id, "beta"));
    const store = createSkillsStore({ get } as unknown as SkillsApi);
    await store.getState().loadDetail("b");
    await store.getState().loadDetail("b");
    expect(get).toHaveBeenCalledTimes(1);

    store.getState().put(full("z", "zeta"));
    store.getState().put(full("a", "alpha"));
    expect(store.getState().skills.map((s) => s.name)).toEqual(["alpha", "zeta"]);
    // The list carries sizes (UTF-8 bytes), not contents.
    expect(store.getState().skills[0]!.files).toEqual([{ path: "a.md", size: 6 }]);
    store.getState().drop("a");
    expect(store.getState().skills.map((s) => s.id)).toEqual(["z"]);
    expect(store.getState().details.a).toBeUndefined();
  });
});

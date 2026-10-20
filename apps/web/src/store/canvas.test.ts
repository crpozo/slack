import type { Canvas } from "@mindfultech/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasConflictError, type CanvasApi } from "../lib/canvasApi";
import { createCanvasStore } from "./canvas";

const canvas = (patch: Partial<Canvas> = {}): Canvas => ({
  channelId: "ch_design",
  content: "<p>plan</p>",
  version: 2,
  updatedAt: 100,
  updatedBy: "ana",
  ...patch,
});

function makeApi(): { [K in keyof CanvasApi]: ReturnType<typeof vi.fn> } {
  return { get: vi.fn(), save: vi.fn() };
}

describe("canvas store", () => {
  let stored: Record<string, string>;
  beforeEach(() => {
    stored = {};
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => stored[k] ?? null,
      setItem: (k: string, v: string) => {
        stored[k] = v;
      },
    });
  });

  it("loads a canvas once, saves it as the next version and remembers the result", async () => {
    const api = makeApi();
    api.get.mockResolvedValue(canvas());
    api.save.mockResolvedValue(canvas({ content: "<p>v3</p>", version: 3, updatedBy: "me" }));
    const store = createCanvasStore(api as unknown as CanvasApi);

    await store.getState().load("ch_design");
    await store.getState().load("ch_design");
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(store.getState().canvases.ch_design?.version).toBe(2);

    expect(await store.getState().save("ch_design", "<p>v3</p>")).toBe("saved");
    expect(api.save).toHaveBeenCalledWith("ch_design", { content: "<p>v3</p>", version: 2 });
    expect(store.getState().canvases.ch_design).toMatchObject({ version: 3, updatedBy: "me" });
    expect(store.getState().status.ch_design).toBe("saved");
  });

  it("takes the server's canvas on a conflict and reports it", async () => {
    const api = makeApi();
    api.get.mockResolvedValue(canvas());
    const theirs = canvas({ content: "<p>theirs</p>", version: 5, updatedBy: "bob" });
    api.save.mockRejectedValue(new CanvasConflictError(theirs));
    const store = createCanvasStore(api as unknown as CanvasApi);
    await store.getState().load("ch_design");

    expect(await store.getState().save("ch_design", "<p>mine</p>")).toBe("conflict");
    expect(store.getState().canvases.ch_design).toEqual(theirs);
    expect(store.getState().status.ch_design).toBe("conflict");
    expect(store.getState().error).toBeNull();
  });

  it("keeps the content locally and reports a failed save", async () => {
    const api = makeApi();
    api.get.mockResolvedValue(canvas());
    api.save.mockRejectedValue(new Error("Couldn't reach the server."));
    const store = createCanvasStore(api as unknown as CanvasApi);
    await store.getState().load("ch_design");
    expect(await store.getState().save("ch_design", "<p>x</p>")).toBe("error");
    expect(store.getState().canvases.ch_design?.version).toBe(2);
    expect(store.getState().error).toBe("Couldn't reach the server.");
  });

  it("refetches on someone else's newer version only, never on its own echo", async () => {
    const api = makeApi();
    api.get.mockResolvedValue(canvas());
    const store = createCanvasStore(api as unknown as CanvasApi);
    await store.getState().load("ch_design");
    const push = { type: "canvas.updated" as const, channelId: "ch_design", updatedAt: 200 };

    store.getState().applyEvent({ ...push, version: 3, updatedBy: "me" }, "me");
    store.getState().applyEvent({ ...push, version: 2, updatedBy: "bob" }, "me");
    store
      .getState()
      .applyEvent({ ...push, channelId: "ch_other", version: 9, updatedBy: "bob" }, "me");
    expect(api.get).toHaveBeenCalledTimes(1);

    api.get.mockResolvedValue(canvas({ version: 3, content: "<p>bob</p>" }));
    store.getState().applyEvent({ ...push, version: 3, updatedBy: "bob" }, "me");
    await vi.waitFor(() => expect(store.getState().canvases.ch_design?.version).toBe(3));
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it("remembers which canvases are open on this device", () => {
    const store = createCanvasStore(makeApi() as unknown as CanvasApi);
    store.getState().setOpen("ch_design", true);
    expect(JSON.parse(stored["slack.canvas.open"] ?? "{}")).toEqual({
      ch_design: true,
    });
    const again = createCanvasStore(makeApi() as unknown as CanvasApi);
    expect(again.getState().open).toEqual({ ch_design: true });
    again.getState().setOpen("ch_design", false);
    expect(again.getState().open).toEqual({});
    again.getState().reset();
    expect(again.getState().open).toEqual({});
  });
});

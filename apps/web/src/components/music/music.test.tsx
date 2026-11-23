// @vitest-environment jsdom
import type { MusicRoom } from "@mindfultech/shared";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { musicApi } from "../../lib/musicApi";
import { configureTasksApi } from "../../lib/tasksApi";
import { useChat } from "../../store";
import { useMusic } from "../../store/music";
import { MusicPlayer } from "./MusicPlayer";
import { MusicView } from "./MusicView";

// Phase 78: music rooms. Join and leave, the DJ's controls, and a player on the room's clock.

const NOW = Date.now();
const room = (patch: Partial<MusicRoom> = {}): MusicRoom => ({
  roomId: "mr_1",
  name: "Viernes",
  djId: "u-dj",
  djName: "Carlos",
  createdAt: NOW,
  queue: [
    { id: "t1", videoId: "X3G2C15azIs", title: "Primera", addedBy: "u-dj", addedByName: "Carlos" },
    { id: "t2", videoId: "dQw4w9WgXcQ", title: "Segunda", addedBy: "u-dj", addedByName: "Carlos" },
  ],
  trackId: "t1",
  playing: true,
  positionMs: 30_000,
  at: NOW - 10_000,
  listeners: [{ userId: "u-dj", name: "Carlos" }],
  ...patch,
});
const answer = (r: MusicRoom) => Promise.resolve({ room: r, serverNow: Date.now() });
const view = () =>
  render(
    <MemoryRouter>
      <MusicView />
      <MusicPlayer />
    </MemoryRouter>,
  );

beforeEach(() => {
  configureTasksApi("https://api.fake.example");
  useMusic.getState().reset();
  useMusic.setState({ offset: 0 });
  useChat.setState({ me: { userId: "u-ana", email: "ana@x.test", role: "member" } });
  vi.spyOn(musicApi, "rooms").mockImplementation(() =>
    Promise.resolve({ rooms: [room()], serverNow: Date.now() }),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("music rooms", () => {
  it("a listener joins, hears the room's moment, and can't control it; then leaves", async () => {
    const join = vi.spyOn(musicApi, "join").mockImplementation(() =>
      answer(
        room({
          listeners: [
            { userId: "u-dj", name: "Carlos" },
            { userId: "u-ana", name: "Ana" },
          ],
        }),
      ),
    );
    const leave = vi.spyOn(musicApi, "leave").mockImplementation(() => answer(room()));
    view();
    expect(await screen.findByText("♪ Primera")).toBeTruthy();
    expect(document.querySelector("[data-music-player]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Unirme" }));
    const player = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-music-player]");
      if (!el) throw new Error("no player yet");
      return el;
    });
    expect(join).toHaveBeenCalledWith("mr_1");
    // The song started 30 s in, 10 s ago: the frame opens at about 40 s.
    const src = player.querySelector("iframe")!.getAttribute("src")!;
    expect(src).toContain("/embed/X3G2C15azIs");
    expect(Number(/start=(\d+)/.exec(src)![1])).toBeGreaterThanOrEqual(39);
    expect(Number(/start=(\d+)/.exec(src)![1])).toBeLessThanOrEqual(41);
    expect(player.textContent).toContain("2 personas escuchando");
    // Not the DJ: no play, skip, add or delete; only their own volume.
    expect(screen.queryByRole("button", { name: /Pausar para todos/ })).toBeNull();
    expect(screen.queryByLabelText("Enlace de YouTube")).toBeNull();
    expect(screen.queryByRole("button", { name: /Eliminar la sala/ })).toBeNull();
    expect(screen.getByLabelText("Tu volumen")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Salir de la sala" }));
    await waitFor(() => expect(leave).toHaveBeenCalledWith("mr_1"));
    expect(document.querySelector("[data-music-player]")).toBeNull();
  });

  it("the DJ queues a link, pauses, skips and deletes; a change from the server moves everyone", async () => {
    useChat.setState({ me: { userId: "u-dj", email: "c@x.test", role: "member" } });
    vi.spyOn(musicApi, "join").mockImplementation(() => answer(room()));
    const control = vi
      .spyOn(musicApi, "control")
      .mockImplementation((_id, input) =>
        answer(room(input.action === "pause" ? { playing: false } : {})),
      );
    const remove = vi.spyOn(musicApi, "remove").mockResolvedValue({ removed: "mr_1" });
    view();
    fireEvent.click(await screen.findByRole("button", { name: "Unirme" }));
    fireEvent.change(await screen.findByLabelText("Enlace de YouTube"), {
      target: { value: "https://youtu.be/dQw4w9WgXcQ" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Agregar" }));
    await waitFor(() =>
      expect(control).toHaveBeenCalledWith("mr_1", {
        action: "add",
        url: "https://youtu.be/dQw4w9WgXcQ",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Pausar para todos" }));
    await waitFor(() => expect(control).toHaveBeenCalledWith("mr_1", { action: "pause" }));
    expect(await screen.findByRole("button", { name: "Reproducir para todos" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Siguiente canción" }));
    await waitFor(() => expect(control).toHaveBeenCalledWith("mr_1", { action: "next" }));

    // The server says the room moved on: the player follows to the new song.
    act(() =>
      useMusic.getState().apply({
        type: "music.updated",
        room: room({ trackId: "t2", positionMs: 0, at: Date.now() }),
        serverNow: Date.now(),
      }),
    );
    await waitFor(() =>
      expect(document.querySelector("[data-music-player] iframe")!.getAttribute("src")).toContain(
        "/embed/dQw4w9WgXcQ",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Eliminar la sala Viernes" }));
    fireEvent.click(screen.getByRole("button", { name: "Sí, eliminar la sala" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("mr_1"));
    expect(document.querySelector("[data-music-player]")).toBeNull();
  });

  it("a room deleted by its DJ takes its listeners out; an external has no music", async () => {
    vi.spyOn(musicApi, "join").mockImplementation(() => answer(room()));
    view();
    fireEvent.click(await screen.findByRole("button", { name: "Unirme" }));
    await waitFor(() => expect(document.querySelector("[data-music-player]")).not.toBeNull());
    act(() =>
      useMusic.getState().apply({ type: "music.updated", removed: "mr_1", serverNow: Date.now() }),
    );
    expect(document.querySelector("[data-music-player]")).toBeNull();
    expect(screen.getByText("Aún no hay salas")).toBeTruthy();
    cleanup();
    useChat.setState({ me: { userId: "u-ext", email: "e@x.test", role: "guest" } });
    view();
    expect(screen.getByText("La música es para el equipo de MindfulTech.")).toBeTruthy();
  });

  it("shows who comes in, lets anyone react, and floats everyone's reactions over the player", async () => {
    vi.spyOn(musicApi, "join").mockImplementation(() => answer(room()));
    const control = vi.spyOn(musicApi, "control").mockImplementation(() => answer(room()));
    view();
    fireEvent.click(await screen.findByRole("button", { name: "Unirme" }));
    await waitFor(() => expect(document.querySelector("[data-music-player]")).not.toBeNull());
    // Bob joins: said once, and listed.
    act(() =>
      useMusic.getState().apply({
        type: "music.updated",
        room: room({
          listeners: [
            { userId: "u-dj", name: "Carlos" },
            { userId: "u-bob", name: "Bob" },
          ],
        }),
        serverNow: Date.now(),
      }),
    );
    await waitFor(() => expect(useChat.getState().toast?.message).toBe("🎵 Bob se unió"));
    expect(document.querySelector("[data-music-listeners]")!.textContent).toContain("Carlos, Bob");
    // A reaction of mine goes to the room; one from the room shows with who sent it.
    fireEvent.click(screen.getByRole("button", { name: "Reaccionar con 🔥" }));
    await waitFor(() =>
      expect(control).toHaveBeenCalledWith("mr_1", { action: "react", emoji: "🔥" }),
    );
    act(() =>
      useMusic.getState().apply({
        type: "music.updated",
        reaction: { roomId: "mr_1", userId: "u-bob", name: "Bob", emoji: "💃" },
        serverNow: Date.now(),
      }),
    );
    const flying = document.querySelector(".music-reaction")!;
    expect(flying.textContent).toBe("💃Bob");
    // Another room's reactions aren't mine to see.
    act(() =>
      useMusic.getState().apply({
        type: "music.updated",
        reaction: { roomId: "mr_other", userId: "u-x", name: "X", emoji: "😴" },
        serverNow: Date.now(),
      }),
    );
    expect(document.querySelectorAll(".music-reaction")).toHaveLength(1);
  });

  it("is moved by dragging its header, and stays where it was left", async () => {
    localStorage.removeItem("slack.music.place");
    Element.prototype.setPointerCapture ??= () => {};
    Element.prototype.releasePointerCapture ??= () => {};
    Element.prototype.hasPointerCapture ??= () => false;
    vi.spyOn(musicApi, "join").mockImplementation(() => answer(room()));
    view();
    fireEvent.click(await screen.findByRole("button", { name: "Unirme" }));
    const player = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-music-player]");
      if (!el) throw new Error("no player yet");
      return el;
    });
    const handle = player.querySelector("[data-music-drag]")!;
    // jsdom's PointerEvent carries no coordinates: mouse events under the pointer names do.
    const pointer = (type: string, clientX: number, clientY: number) =>
      act(() => {
        handle.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX, clientY }));
      });
    pointer("pointerdown", 10, 10);
    pointer("pointermove", 210, 160);
    expect(player.style.left).toBe("200px");
    expect(player.style.top).toBe("150px");
    pointer("pointerup", 210, 160);
    expect(localStorage.getItem("slack.music.place")).not.toBeNull();
  });
});

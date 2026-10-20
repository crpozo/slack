import type { Canvas, SaveCanvasInput } from "@mindfultech/shared";
import { request, TasksApiError } from "./tasksApi";

const id = encodeURIComponent;

/** Saved by someone else since the version this save was based on; `current` is theirs. */
export class CanvasConflictError extends Error {
  constructor(readonly current: Canvas) {
    super("Someone else saved the canvas meanwhile");
  }
}

/** The channel canvas (same HTTP API and auth as the Task Manager and the calendar). */
export const canvasApi = {
  get: (channelId: string) =>
    request<{ canvas: Canvas }>("GET", `/channels/${id(channelId)}/canvas`).then((r) => r.canvas),
  /** Last-writer-wins on `version`: a stale save is a `CanvasConflictError` carrying the current canvas. */
  save: async (channelId: string, input: SaveCanvasInput): Promise<Canvas> => {
    try {
      const { canvas } = await request<{ canvas: Canvas }>(
        "PUT",
        `/channels/${id(channelId)}/canvas`,
        input,
      );
      return canvas;
    } catch (err) {
      if (err instanceof TasksApiError && err.status === 409) {
        throw new CanvasConflictError(await canvasApi.get(channelId));
      }
      throw err;
    }
  },
};

export type CanvasApi = typeof canvasApi;

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth", () => ({ getIdToken: vi.fn(async () => "id-token") }));
import { notesApi } from "./notesApi";
import { configureTasksApi, tasksApi, TasksApiError } from "./tasksApi";

const fetchMock = vi.fn();

function respond(status: number, body?: unknown) {
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  configureTasksApi("https://api.example.com/");
});
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe("tasks API client", () => {
  it("Phase 43: sends a call's audio clip as the raw body, with its own type", async () => {
    respond(200, { phrases: 3 });
    const audio = new Blob(["opus"], { type: "audio/webm;codecs=opus" });
    const result = await notesApi.uploadClip(
      "call 1",
      { channelId: "dm_a_b", speaker: "u-b", startedAt: 1_700_000_000_000, durationMs: 240_000 },
      audio,
    );
    expect(result).toEqual({ phrases: 3 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.example.com/calls/call%201/clips?channelId=dm_a_b&speaker=u-b&startedAt=1700000000000&durationMs=240000",
    );
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      authorization: "Bearer id-token",
      "content-type": "audio/webm;codecs=opus",
    });
    expect(init.body).toBe(audio);
  });

  it("sends the id token as a bearer and JSON bodies, trimming the base URL", async () => {
    respond(201, { task: { taskId: "t1" } });
    const task = await tasksApi.createTask("b 1", { title: "x", description: "" });
    expect(task).toEqual({ taskId: "t1" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/boards/b%201/tasks");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      authorization: "Bearer id-token",
      "content-type": "application/json",
    });
    expect(init.body).toBe(JSON.stringify({ title: "x", description: "" }));
  });

  it("unwraps list responses and handles 204", async () => {
    respond(200, { boards: [{ boardId: "b1" }] });
    expect(await tasksApi.listBoards()).toEqual([{ boardId: "b1" }]);
    respond(204);
    await expect(tasksApi.deleteTask("t1")).resolves.toBeUndefined();
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(init.headers).toEqual({ authorization: "Bearer id-token" }); // no content-type without a body
  });

  it("turns error responses into TasksApiError with the server's message", async () => {
    respond(404, { message: "Board not found" });
    await expect(tasksApi.listTasks("b1")).rejects.toMatchObject({
      status: 404,
      message: "Board not found",
    });
    respond(500, "not json");
    await expect(tasksApi.listTasks("b1")).rejects.toMatchObject({
      message: "Request failed (500)",
    });
    respond(401, { message: "Unauthorized" });
    await expect(tasksApi.listTasks("b1")).rejects.toThrow(/session expired/);
  });

  it("explains network failures and a missing configuration", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(tasksApi.listBoards()).rejects.toThrow(/Couldn't reach the server/);

    configureTasksApi(null);
    const err = await tasksApi.listBoards().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TasksApiError);
    expect((err as TasksApiError).message).toMatch(/isn't configured/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

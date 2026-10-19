import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth", () => ({ getIdToken: vi.fn(async () => "id-token") }));
import { calendarApi } from "./calendarApi";
import { configureTasksApi } from "./tasksApi";

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
  configureTasksApi("https://api.example.com");
});
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe("calendar API client", () => {
  it("lists a date range and unwraps the events", async () => {
    respond(200, { events: [{ eventId: "ev_1" }] });
    expect(await calendarApi.listEvents("2026-11-01", "2026-12-06")).toEqual([{ eventId: "ev_1" }]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/calendar/events?from=2026-11-01&to=2026-12-06");
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({ authorization: "Bearer id-token" });
  });

  it("creates, decides and cancels, keeping the ledger reply", async () => {
    respond(201, { event: { eventId: "ev_2" }, balance: { used: 0, pending: 4 } });
    const created = await calendarApi.createEvent({
      type: "vacation",
      startDate: "2026-11-02",
      endDate: "2026-11-06",
    });
    expect(created).toEqual({ event: { eventId: "ev_2" }, balance: { used: 0, pending: 4 } });

    respond(200, { event: { eventId: "ev_2", status: "approved" } });
    const decided = await calendarApi.decideVacation("ev_2", { status: "approved" });
    expect(decided).toEqual({ eventId: "ev_2", status: "approved" });
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/calendar/vacations/ev_2/status");
    expect(init.method).toBe("PUT");
    expect(init.body).toBe(JSON.stringify({ status: "approved" }));

    respond(204);
    await expect(calendarApi.deleteEvent("ev_2")).resolves.toBeUndefined();

    respond(200, { balance: { userId: "u1", year: "2026", allowance: 20, used: 0, pending: 0 } });
    expect(await calendarApi.setAllowance("u1", "2026", 20)).toMatchObject({ allowance: 20 });
    expect(fetchMock.mock.calls[3]![0]).toBe("https://api.example.com/calendar/balances/u1/2026");
  });
});

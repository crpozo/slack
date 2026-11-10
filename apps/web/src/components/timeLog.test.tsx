// @vitest-environment jsdom
import type { Channel, TimeEntry } from "@mindfultech/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureTasksApi, timeApi } from "../lib/tasksApi";
import { useChat } from "../store";
import { TimeLogModal } from "./TimeLog";

// Phase 60: a channel's hours (rates and costs for admins only).

const channel: Channel = {
  channelId: "ch_cam",
  name: "Cambridge",
  type: "private",
  createdBy: "u-admin",
  createdAt: 1,
  archived: false,
  members: ["u-admin", "u-dev"],
};
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Guayaquil" }).format(
  new Date(),
);
const entry = (patch: Partial<TimeEntry> = {}): TimeEntry => ({
  entryId: "e1",
  channelId: "ch_cam",
  userId: "u-dev",
  userName: "dev",
  date: today,
  minutes: 150,
  description: "API de pagos",
  createdAt: 1,
  ...patch,
});

beforeEach(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
  configureTasksApi("https://api.fake.example");
  useChat.setState({
    users: {
      "u-dev": {
        userId: "u-dev",
        email: "d@x.com",
        displayName: "Harryson",
        updatedAt: 1,
        role: "guest",
      },
    },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the channel's hours", () => {
  it("an admin sees hours, sets a rate and sees the cost", async () => {
    useChat.setState({ me: { userId: "u-admin", email: "a@x.com", role: "admin" } });
    vi.spyOn(timeApi, "list").mockResolvedValue({ entries: [entry()], rates: { "u-dev": 20 } });
    const setRate = vi
      .spyOn(timeApi, "setRate")
      .mockResolvedValue({ userId: "u-dev", hourlyRate: 30 });
    render(<TimeLogModal channel={channel} onClose={() => {}} />);
    await screen.findByText("API de pagos");
    const total = document.querySelector("[data-time-total]")!.textContent ?? "";
    expect(total).toContain("2h 30m");
    expect(total).toMatch(/50[.,]00/); // 2.5 h × $20
    const rate = screen.getByLabelText("Tarifa por hora en dólares");
    fireEvent.change(rate, { target: { value: "30" } });
    fireEvent.blur(rate);
    await waitFor(() => expect(setRate).toHaveBeenCalledWith("ch_cam", "u-dev", 30));
  });

  it("an external logs their day and never sees rates or costs", async () => {
    useChat.setState({ me: { userId: "u-dev", email: "d@x.com", role: "guest" } });
    vi.spyOn(timeApi, "list").mockResolvedValue({ entries: [entry()] });
    const log = vi.spyOn(timeApi, "log").mockResolvedValue(entry({ entryId: "e2" }));
    render(<TimeLogModal channel={channel} onClose={() => {}} />);
    await screen.findByText("API de pagos");
    expect(screen.queryByLabelText("Tarifa por hora en dólares")).toBeNull();
    expect(document.querySelector("[data-time-log]")!.textContent).not.toMatch(/\$|USD/);
    fireEvent.change(screen.getByLabelText("Tiempo trabajado"), { target: { value: "1:30" } });
    fireEvent.change(screen.getByLabelText("Qué hiciste"), {
      target: { value: "Login con Google" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Registrar 1h 30m" }));
    await waitFor(() =>
      expect(log).toHaveBeenCalledWith("ch_cam", {
        date: today,
        minutes: 90,
        description: "Login con Google",
      }),
    );
  });
});

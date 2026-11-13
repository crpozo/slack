// @vitest-environment jsdom
import type { PlatformReport } from "@mindfultech/shared";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../lib/tasksApi";
import { usePlatformInsights } from "../store/platformInsights";
import { PlatformInsightsView } from "./PlatformInsightsView";

// Phase 64: Platform Insights, for its owners only.

const report: PlatformReport = {
  generatedAt: Date.parse("2026-11-13T17:00:00Z"),
  metrics: {
    from: "2026-10-15",
    to: "2026-11-13",
    days: 30,
    people: {
      total: 3,
      active: 2,
      guests: 1,
      list: [
        {
          name: "Ana",
          role: "admin",
          messages: 40,
          activeDays: 12,
          lastActive: "2026-11-12",
          openTasks: 2,
          tasksDone: 5,
          hoursLogged: 10,
        },
      ],
    },
    messages: {
      total: 60,
      previous: 50,
      inChannels: 45,
      inDirectMessages: 15,
      replies: 6,
      withFiles: 4,
      voice: 1,
      perDay: [
        { date: "2026-11-12", count: 20 },
        { date: "2026-11-13", count: 40 },
      ],
      perHour: Array.from({ length: 24 }, (_, h) => (h === 10 ? 30 : 0)),
      perWeekday: [10, 10, 10, 10, 20, 0, 0],
      outsideHours: 3,
    },
    channels: {
      total: 2,
      active: 1,
      list: [
        {
          name: "general",
          type: "public",
          messages: 45,
          people: 2,
          lastMessage: "2026-11-13",
          hasExternals: false,
        },
      ],
      quiet: ["Cliente X"],
    },
    tasks: {
      boards: 1,
      open: 4,
      byStatus: { TODO: 3, IN_PROGRESS: 1 },
      created: 6,
      done: 5,
      unassigned: 1,
      stale: 2,
      medianDaysToDone: 3,
    },
    calls: { withNotes: 2, minutes: 75 },
    time: { hours: 10, cost: 200, byChannel: [{ name: "Cliente X", hours: 10, cost: 200 }] },
  },
  analysis: {
    summary: "El equipo usa sobre todo #general.",
    wins: ["Cinco tareas cerradas."],
    risks: ["Dos tareas sin tocar."],
    recommendations: [
      {
        title: "Revisar tareas viejas",
        why: "2 llevan 14 días.",
        how: "Repasarlas el lunes.",
        impact: "alto",
      },
    ],
    questions: ["¿Sirve el canal Cliente X?"],
  },
};

beforeEach(() => {
  usePlatformInsights.setState({
    allowed: null,
    status: "idle",
    report: null,
    generating: false,
    error: null,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Platform Insights", () => {
  it("shows an owner the numbers and what the AI would improve", async () => {
    vi.spyOn(api, "request").mockImplementation(async (_method, path) =>
      path === "/platform-insights/access" ? { allowed: true } : { report },
    );
    render(<PlatformInsightsView />);
    await waitFor(() =>
      expect(screen.getByText("El equipo usa sobre todo #general.")).toBeTruthy(),
    );
    expect(screen.getByText("+20% vs. 30 días antes")).toBeTruthy();
    expect(screen.getByText(/1\. Revisar tareas viejas/)).toBeTruthy();
    expect(screen.getByText("Impacto alto")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Analizar de nuevo" })).toBeTruthy();
    expect(screen.getByText(/No lee el texto de ningún mensaje/)).toBeTruthy();
  });

  it("shows nothing of it to anyone else, and never asks for the report", async () => {
    const request = vi.spyOn(api, "request").mockResolvedValue({ allowed: false });
    render(<PlatformInsightsView />);
    await waitFor(() =>
      expect(screen.getByText("Esta sección no está disponible para tu cuenta.")).toBeTruthy(),
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /Analizar/ })).toBeNull();
  });
});

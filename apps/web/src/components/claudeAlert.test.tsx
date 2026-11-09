// @vitest-environment jsdom
import type { ClaudeModelAlert } from "@mindfultech/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewsDashboard } from "./NewsDashboard";

// Phase 56: an alert when Anthropic releases a new Claude model, or is about to.

const alert: ClaudeModelAlert = {
  status: "launched",
  model: "Claude Opus 6",
  headline: "Anthropic lanza Claude Opus 6",
  summary: "Disponible hoy en la API y en Bedrock.",
  evidence: [
    {
      title: "Anthropic launches Claude Opus 6",
      link: "https://e.com/a",
      sourceName: "TechCrunch",
    },
  ],
  from: "analysis",
};

const renderWith = (claudeAlert: ClaudeModelAlert | null, onDismiss = vi.fn()) =>
  render(
    <NewsDashboard
      dateLabel="Lun 9 nov 2026"
      storyCount={18}
      stories={[]}
      trends={[]}
      takeaways={[]}
      now={0}
      refreshing={false}
      onRefresh={() => {}}
      claudeAlert={claudeAlert}
      onDismissClaudeAlert={onDismiss}
    />,
  );

afterEach(cleanup);

describe("the Claude alert in AI News", () => {
  it("says a new model is out, what it is, and where to read about it", () => {
    const onDismiss = vi.fn();
    renderWith(alert, onDismiss);
    const banner = screen.getByRole("status", { name: "Nuevo modelo de Claude" });
    expect(banner.dataset.claudeAlert).toBe("launched");
    expect(banner.textContent).toContain("Claude Opus 6");
    expect(banner.textContent).toContain("Anthropic lanza Claude Opus 6");
    expect(screen.getByRole("link", { name: /Leer en TechCrunch/ }).getAttribute("href")).toBe(
      "https://e.com/a",
    );
    fireEvent.click(screen.getByRole("button", { name: "Ocultar el aviso" }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it("marks one on its way differently, and shows nothing on other days", () => {
    renderWith({ ...alert, status: "upcoming" });
    expect(screen.getByRole("status", { name: "Nuevo modelo de Claude en camino" })).toBeTruthy();
    cleanup();
    renderWith(null);
    expect(document.querySelector("[data-claude-alert]")).toBeNull();
  });
});

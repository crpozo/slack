// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NewsDashboard } from "./NewsDashboard";

// Phase 62: the sections of AI News are pages; a tab swaps the content.

const story = {
  headline: "OpenAI lanza agentes",
  summary: "Resumen.",
  sourceName: "TechCrunch",
  link: "https://e.com/a",
  thumbnailUrl: null,
  pubDate: null,
};

afterEach(cleanup);

describe("the AI News tabs", () => {
  it("show one section at a time", () => {
    render(
      <NewsDashboard
        dateLabel="Lun 9 nov 2026"
        storyCount={1}
        stories={[story]}
        trends={[{ topic: "Agentes", text: "Todos lanzan agentes." }]}
        takeaways={[{ lead: "Probar agentes", body: "en un cliente actual." }]}
        now={0}
        refreshing={false}
        onRefresh={() => {}}
      />,
    );
    const tab = (name: string) => screen.getByRole("tab", { name });
    expect(tab("Lo esencial").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").id).toBe("news-top");
    expect(screen.queryByText("Todos lanzan agentes.")).toBeNull();

    fireEvent.click(tab("Tendencias"));
    expect(tab("Tendencias").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").id).toBe("news-trends");
    expect(screen.getByText("Todos lanzan agentes.")).toBeTruthy();
    expect(screen.queryByText("OpenAI lanza agentes")).toBeNull();

    fireEvent.click(tab("Para MindfulTech"));
    expect(screen.getByRole("tabpanel").id).toBe("news-impact");
    expect(screen.getByText(/Probar agentes/)).toBeTruthy();
  });
});

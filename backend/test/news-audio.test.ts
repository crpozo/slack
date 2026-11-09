import { describe, expect, it } from "vitest";
import { audioScript, scriptChunks, spokenDay, spokenSeconds } from "../src/lib/newsAudio";

describe("the AI News summary in audio (Phase 54)", () => {
  const insights = {
    day: "2026-11-09",
    stories: [
      {
        headline: "OpenAI lanza agentes",
        summary: "Resumen.",
        whyItMatters: "Cambia la **automatización** de procesos",
        sourceName: "TechCrunch",
        link: "https://techcrunch.com/a",
        thumbnailUrl: null,
        pubDate: null,
      },
      {
        headline: "Nvidia invierte",
        summary: "Una ronda grande. Ver https://example.com",
        sourceName: "The Verge",
        link: "https://theverge.com/b",
        thumbnailUrl: null,
        pubDate: null,
      },
    ],
    trends: [{ topic: "Agentes", text: "Todos lanzan **agentes** para empresas" }],
    takeaways: [
      { lead: "Probar agentes", body: "en un cliente actual.", horizon: "ahora" as const },
    ],
  };

  it("reads the day, the top stories, the trends and the actions, without markdown or links", () => {
    const script = audioScript(insights);
    expect(script).toContain("Hola. Este es el resumen de AI News del lunes, 9 de noviembre");
    expect(script).toContain(
      "Primero: OpenAI lanza agentes. Por qué importa: Cambia la automatización de procesos. Fuente: TechCrunch.",
    );
    // No "why it matters": its summary instead, links dropped.
    expect(script).toContain("Segundo: Nvidia invierte. Una ronda grande. Ver. Fuente: The Verge.");
    expect(script).toContain("Agentes. Todos lanzan agentes para empresas.");
    expect(script).toContain("Probar agentes, esta semana: en un cliente actual.");
    expect(script).not.toMatch(/\*\*|https?:/);
    expect(script.endsWith("Los detalles y los enlaces están en AI News.")).toBe(true);
  });

  it("says a new Claude model first (Phase 56)", () => {
    const script = audioScript({
      ...insights,
      claudeAlert: {
        status: "launched",
        model: "Claude Opus 6",
        headline: "h",
        summary: "Disponible hoy en la API.",
        evidence: [],
        from: "analysis",
      },
    });
    const [, second] = script.split("\n\n");
    expect(second).toBe(
      "Atención: Anthropic lanzó un nuevo modelo de Claude: Claude Opus 6. Disponible hoy en la API.",
    );
  });

  it("cuts the script into pieces Polly accepts, between paragraphs then sentences", () => {
    const script = ["Uno. Dos.", "Tres.", "x".repeat(25) + ". " + "y".repeat(25) + "."].join(
      "\n\n",
    );
    const chunks = scriptChunks(script, 30);
    expect(chunks.every((c) => c.length <= 30)).toBe(true);
    expect(chunks.join(" ").replace(/\s+/g, "")).toBe(script.replace(/\s+/g, ""));
    expect(scriptChunks("corto")).toEqual(["corto"]);
  });

  it("names the day in Spanish and guesses how long it plays", () => {
    expect(spokenDay("2026-11-09")).toBe("lunes, 9 de noviembre");
    expect(spokenDay("nope")).toBe("");
    expect(spokenSeconds(1500)).toBe(100);
  });
});

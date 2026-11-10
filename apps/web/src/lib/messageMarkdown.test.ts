import { describe, expect, it } from "vitest";
import { looksLikeMarkdown, renderMessageMarkdown } from "./markdown";

// Phase 56: Markdown pasted into a message shows formatted.

const README = [
  "# Plan de lanzamiento",
  "",
  "Pasos para **esta semana**:",
  "",
  "1. Revisar el [brief](https://example.com/brief)",
  "2. Probar `deploy`",
  "   - en staging",
  "- [x] Diseño",
  "- [ ] QA",
  "",
  "> Ojo con los precios.",
  "",
  "| Tarea | Dueño |",
  "| --- | :---: |",
  "| API | Ana |",
  "",
  "---",
  "Listo ~~ayer~~ hoy.",
].join("\n");

describe("Markdown in messages", () => {
  it("tells Markdown from chat", () => {
    expect(looksLikeMarkdown(README)).toBe(true);
    expect(looksLikeMarkdown("## Resumen\nTodo bien")).toBe(true);
    expect(looksLikeMarkdown("1. uno\n2. dos")).toBe(true);
    expect(looksLikeMarkdown("> cita importante")).toBe(true);
    expect(looksLikeMarkdown("mira [esto](https://e.com)")).toBe(true);
    expect(looksLikeMarkdown("| a | b |\n|---|---|\n| 1 | 2 |")).toBe(true);
    // Chat: what messages already showed, or no Markdown at all.
    expect(looksLikeMarkdown("hola, **listo** el deploy")).toBe(false);
    expect(looksLikeMarkdown("- solo un punto")).toBe(false);
    expect(looksLikeMarkdown("#general tiene la info")).toBe(false);
    expect(looksLikeMarkdown("```\n# no es título\n- ni lista\n- ni nada\n```")).toBe(false);
    expect(looksLikeMarkdown("---")).toBe(false);
    expect(looksLikeMarkdown("sale en https://e.com")).toBe(false);
  });

  it("renders headings, lists, checkboxes, quotes, tables, rules, links and strikethrough", () => {
    const { html, rich } = renderMessageMarkdown(README);
    expect(rich).toBe(true);
    expect(html).toContain("<h3>Plan de lanzamiento</h3>");
    expect(html).toContain("<strong>esta semana</strong>");
    expect(html).toContain("<ol>");
    expect(html).toContain('<a href="https://example.com/brief"');
    expect(html).toContain("<code>deploy</code>");
    expect(html).toContain('<li class="task">');
    expect(html).toContain("<blockquote>Ojo con los precios.</blockquote>");
    expect(html).toContain("<table>");
    expect(html).toContain('<th class="align-center">Dueño</th>');
    expect(html).toContain("<hr>");
    expect(html).toContain("<del>ayer</del>");
  });

  it("keeps chat messages on the light rules, and escapes everything either way", () => {
    expect(renderMessageMarkdown("hola **listo**")).toEqual({
      html: "hola <strong>listo</strong>",
      rich: false,
    });
    const { html } = renderMessageMarkdown('# <img src=x onerror="alert(1)">\n- a\n- b');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("highlights mentions in Markdown too", () => {
    const marks = { known: new Set(["ana"]), mine: new Set<string>() };
    const { html } = renderMessageMarkdown("## Tareas\n- @ana revisa\n- yo pruebo", marks);
    expect(html).toContain('<span class="mention">@ana</span>');
  });
});

// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { hasRichFormatting, htmlToMarkdown } from "./pasteMarkdown";

describe("htmlToMarkdown (a rich paste)", () => {
  it("keeps a to-do list's bold leads, numbers, inline code and headings", () => {
    const html = `
      <p><strong>To-do para el equipo: todo listo el lunes</strong><br>Sitio: example.com (WordPress). Orden sugerido.</p>
      <p>Mañana (8:00 a 12:00)</p>
      <ol>
        <li><p><strong>Inventario de formularios</strong>: tabla con nombre y página.</p></li>
        <li><p><strong>Probar cada formulario</strong>: enviar prueba.</p></li>
      </ol>
      <p>Tarde (13:00 a 18:00)</p>
      <ol start="3">
        <li><p><strong>Script de campaña</strong>: leer <code>utm_source</code>, <code>gclid</code> de la URL.</p></li>
      </ol>`;
    expect(htmlToMarkdown(html)).toBe(
      [
        "**To-do para el equipo: todo listo el lunes**",
        "Sitio: example.com (WordPress). Orden sugerido.",
        "Mañana (8:00 a 12:00)",
        "1. **Inventario de formularios**: tabla con nombre y página.",
        "2. **Probar cada formulario**: enviar prueba.",
        "",
        "Tarde (13:00 a 18:00)",
        "3. **Script de campaña**: leer `utm_source`, `gclid` de la URL.",
      ].join("\n"),
    );
  });

  it("reads Google Docs' styles (its <b style=font-weight:normal> wrapper isn't bold)", () => {
    const html =
      '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1">' +
      '<p dir="ltr"><span style="font-weight:700;">Título</span><span style="font-weight:400;"> y texto</span></p>' +
      '<p dir="ltr"><span style="font-style:italic;">cursiva</span></p>' +
      '<ul><li dir="ltr"><p dir="ltr"><span>uno</span></p></li><li dir="ltr"><p dir="ltr"><span>dos</span></p></li></ul></b>';
    expect(htmlToMarkdown(html)).toBe("**Título** y texto\n_cursiva_\n- uno\n- dos");
  });

  it("nests lists, keeps links and code blocks, and drops the clutter", () => {
    const html = `
      <h2>Plan</h2>
      <ul><li>Uno<ul><li>Uno-a</li></ul></li><li>Ver <a href="https://example.com/doc">el doc</a></li></ul>
      <pre><code>const a = 1;
const b = 2;</code></pre>
      <style>p{color:red}</style><script>alert(1)</script>`;
    expect(htmlToMarkdown(html)).toBe(
      [
        "**Plan**",
        "",
        "- Uno",
        "  - Uno-a",
        "- Ver el doc (https://example.com/doc)",
        "",
        "```",
        "const a = 1;",
        "const b = 2;",
        "```",
      ].join("\n"),
    );
  });

  it("keeps spaces outside the marks, so they still render", () => {
    expect(htmlToMarkdown("<p>a<strong> negrita </strong>b</p>")).toBe("a **negrita** b");
  });
});

describe("hasRichFormatting", () => {
  it("is true for docs and answers, false for plain pastes and code editors", () => {
    expect(hasRichFormatting("<p><strong>x</strong></p>")).toBe(true);
    expect(hasRichFormatting("<ol><li>x</li></ol>")).toBe(true);
    expect(hasRichFormatting('<span style="font-weight:700">x</span>')).toBe(true);
    expect(hasRichFormatting("<p>just text</p>")).toBe(false);
    expect(
      hasRichFormatting(
        '<div style="font-family: Menlo; white-space: pre;"><div><span>const</span> <b>a</b></div></div>',
      ),
    ).toBe(false);
  });

  it("turns a table into a markdown table, with each cell in its column", () => {
    const html = `<p><strong>Quito</strong></p>
      <table><thead><tr><th>Institución</th><th>Sitio</th></tr></thead><tbody>
      <tr><td>Hospital Metropolitano</td><td><a href="https://www.hospitalmetropolitano.org">https://www.hospitalmetropolitano.org</a></td></tr>
      <tr><td>Clínica A | B</td><td><a href="https://example.com/">example.com</a></td></tr>
      </tbody></table><p><strong>Guayaquil</strong></p>`;
    expect(hasRichFormatting("<table><tr><td>a</td><td>b</td></tr></table>")).toBe(true);
    expect(htmlToMarkdown(html)).toBe(
      [
        "**Quito**",
        "",
        "| Institución | Sitio |",
        "| --- | --- |",
        "| Hospital Metropolitano | https://www.hospitalmetropolitano.org |",
        "| Clínica A \\| B | https://example.com/ |",
        "",
        "**Guayaquil**",
      ].join("\n"),
    );
  });

  it("reads through a one-column table instead of drawing it", () => {
    expect(
      htmlToMarkdown("<table><tr><td>Solo</td></tr><tr><td>una columna</td></tr></table>"),
    ).toBe("Solo\nuna columna");
  });
});

import { describe, expect, it } from "vitest";
import { escapeHtml, renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("escapes HTML before formatting", () => {
    expect(renderMarkdown('<img src=x onerror="alert(1)">')).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    );
    expect(escapeHtml(`'&'`)).toBe("&#39;&amp;&#39;");
  });

  it("formats bold, italic and inline code", () => {
    expect(renderMarkdown("**hola** _mundo_ `x < y`")).toBe(
      "<strong>hola</strong> <em>mundo</em> <code>x &lt; y</code>",
    );
  });

  it("does not format inside code", () => {
    expect(renderMarkdown("`**no**` y ```\n_tampoco_\n```")).toBe(
      "<code>**no**</code> y <pre><code>_tampoco_\n</code></pre>",
    );
  });

  it("links http(s) URLs only, without trailing punctuation", () => {
    expect(renderMarkdown("ver https://mindfultech.ec/a_b?x=1&y=2.")).toBe(
      'ver <a href="https://mindfultech.ec/a_b?x=1&amp;y=2" target="_blank" rel="noopener noreferrer">https://mindfultech.ec/a_b?x=1&amp;y=2</a>.',
    );
    expect(renderMarkdown("javascript:alert(1)")).toBe("javascript:alert(1)");
  });

  it("keeps snake_case words and converts newlines", () => {
    expect(renderMarkdown("mi_variable_x\nlinea 2")).toBe("mi_variable_x<br>linea 2");
  });

  it("ignores injected stash markers", () => {
    expect(renderMarkdown("0")).toBe("0");
  });
});
